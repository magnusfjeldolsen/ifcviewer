/**
 * Round centres on what web-ifc really produces (issue #63): columns and a
 * pipe cut by openings, a notch and a clipping plane, and swept-disk bars
 * and a pipe with bends. Each file is streamed through web-ifc in Node, the
 * same library the viewer's workers use, and every side triangle is asked
 * for its centre.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { IfcAPI, LogLevel } from 'web-ifc';
import { buildSnapGeometry, type SnapGeometry } from '../src/tools/snapGeometry';
import { roundFitsAt } from '../src/tools/roundFit';
import { CUT_IFC, BEND_IFC } from './fixtures/roundIfc';

let api: IfcAPI;

beforeAll(async () => {
  api = new IfcAPI();
  await api.Init();
  api.SetLogLevel(LogLevel.LOG_LEVEL_OFF);
});

/** Every element's triangles in viewer world space (metres, y up), keyed by expressID. */
function load(ifc: string): Map<number, SnapGeometry> {
  const modelID = api.OpenModel(new TextEncoder().encode(ifc));
  const byElement = new Map<number, { positions: number[]; index: number[] }>();
  api.StreamAllMeshes(modelID, (mesh) => {
    const entry = byElement.get(mesh.expressID) ?? { positions: [], index: [] };
    byElement.set(mesh.expressID, entry);
    for (let i = 0; i < mesh.geometries.size(); i++) {
      const placed = mesh.geometries.get(i);
      const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
      const verts = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
      const index = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
      const matrix = new THREE.Matrix4().fromArray(placed.flatTransformation);
      const base = entry.positions.length / 3;
      const p = new THREE.Vector3();
      for (let k = 0; k < verts.length; k += 6) {
        p.set(verts[k], verts[k + 1], verts[k + 2]).applyMatrix4(matrix);
        entry.positions.push(p.x, p.y, p.z);
      }
      for (const k of index) entry.index.push(base + k);
      geometry.delete();
    }
  });
  api.CloseModel(modelID);
  const out = new Map<number, SnapGeometry>();
  for (const [id, { positions, index }] of byElement) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(index);
    out.set(id, buildSnapGeometry(g));
  }
  return out;
}

interface Axis {
  /** A point on the axis, world metres. */
  point: THREE.Vector3;
  direction: THREE.Vector3;
}

/**
 * The triangles of the round surface itself — normal square to the axis and
 * every corner on the circle, or on the chord of a facet just inside it —
 * and how many of them snap to the axis. The walls of a slot or notch are
 * square to the axis too, but stand well inside the circle; they are not
 * counted, and must not snap.
 */
function surfaceStats(
  geo: SnapGeometry,
  axis: Axis,
  radius: number,
  inner?: number,
  within: (p: THREE.Vector3) => boolean = () => true,
) {
  const n = new THREE.Vector3();
  const p = new THREE.Vector3();
  const offAxis = (i: number) => {
    p.set(geo.positions[i * 3], geo.positions[i * 3 + 1], geo.positions[i * 3 + 2]).sub(axis.point);
    return p.sub(axis.direction.clone().multiplyScalar(p.dot(axis.direction))).length();
  };
  const onSurface = (d: number, r: number) => d > 0.9 * r && d < 1.01 * r;
  let surface = 0;
  let snapping = 0;
  let walls = 0;
  let wallsSnapping = 0;
  let worst = 0;
  for (let t = 0; t < geo.triangles.length / 3; t++) {
    n.set(geo.normals[t * 3], geo.normals[t * 3 + 1], geo.normals[t * 3 + 2]);
    if (Math.abs(n.dot(axis.direction)) > 0.05) continue;
    const centroid = new THREE.Vector3();
    for (let k = 0; k < 3; k++) {
      const i = geo.triangles[t * 3 + k];
      centroid.x += geo.positions[i * 3] / 3;
      centroid.y += geo.positions[i * 3 + 1] / 3;
      centroid.z += geo.positions[i * 3 + 2] / 3;
    }
    if (!within(centroid)) continue;
    const corners = [0, 1, 2].map((k) => offAxis(geo.triangles[t * 3 + k]));
    const isSurface = corners.every((d) => onSurface(d, radius)) || (inner !== undefined && corners.every((d) => onSurface(d, inner)));
    const fit = roundFitsAt(geo, t).find((f) => f.slides);
    if (!isSurface) {
      walls++;
      if (fit) wallsSnapping++;
      continue;
    }
    surface++;
    if (!fit) continue;
    snapping++;
    const d = fit.centre.clone().sub(axis.point);
    worst = Math.max(worst, d.sub(axis.direction.clone().multiplyScalar(d.dot(axis.direction))).length());
  }
  return { surface, snapping, walls, wallsSnapping, worst };
}

const vertical = (x: number, y: number): Axis => ({ point: new THREE.Vector3(x / 1000, 0, -y / 1000), direction: new THREE.Vector3(0, 1, 0) });
const alongX = (y: number, z: number): Axis => ({ point: new THREE.Vector3(0, z / 1000, -y / 1000), direction: new THREE.Vector3(1, 0, 0) });
const alongY = (x: number, z: number): Axis => ({ point: new THREE.Vector3(x / 1000, z / 1000, 0), direction: new THREE.Vector3(0, 0, 1) });

describe('columns and a pipe cut by openings (web-ifc output)', () => {
  let elements: Map<number, SnapGeometry>;
  beforeAll(() => {
    elements = load(CUT_IFC);
  });
  afterAll(() => elements.clear());

  // A slot right through a column leaves two separate arcs at its height —
  // two gaps, which the defect rule does not accept — so triangles lying
  // wholly within the slot's height are left out for #29. Above and below
  // it, and everywhere on the others, every surface triangle must snap.
  const inSlotBand = (p: THREE.Vector3) => p.y > 1.35 && p.y < 1.65;
  const cases: Array<[string, number, Axis, number, number?, ((p: THREE.Vector3) => boolean)?]> = [
    ['column with a slot through it', 29, vertical(5000, 3000), 0.2, undefined, (p) => !inSlotBand(p)],
    ['hollow pipe with a branch hole', 48, alongX(8000, 2500), 0.1, 0.092],
    ['column clipped at an angle', 73, vertical(7000, 3000), 0.15],
    ['column with a notch', 87, vertical(9000, 3000), 0.2],
  ];
  for (const [name, id, axis, radius, inner, within] of cases) {
    it(`snaps every triangle of the round surface to the axis — ${name}`, () => {
      const s = surfaceStats(elements.get(id)!, axis, radius, inner, within);
      expect(s.surface).toBeGreaterThan(0);
      expect(s.snapping, `#${id}: ${s.snapping} of ${s.surface}`).toBe(s.surface);
      expect(s.worst).toBeLessThan(1e-5);
      // The flat walls of the cut-out are not part of anything round.
      expect(s.wallsSnapping).toBe(0);
    });
  }

  it('slides the clipped column only as far as its sloped top, from any triangle', () => {
    const geo = elements.get(73)!;
    const ranges = new Set<string>();
    for (let t = 0; t < geo.triangles.length / 3; t++) {
      const fit = roundFitsAt(geo, t).find((f) => f.slides);
      if (!fit) continue;
      ranges.add(`${(fit.centre.y - fit.halfLength).toFixed(6)}..${(fit.centre.y + fit.halfLength).toFixed(6)}`);
    }
    expect(ranges.size).toBe(1);
    const [from, to] = [...ranges][0].split('..').map(Number);
    expect(from).toBeCloseTo(0, 5);
    // The clipping plane through z 2.7 m tilted 30°: highest at the low side of the tilt.
    // (2.787 m at the extreme; the polygon's nearest corner is a little lower.)
    expect(to).toBeGreaterThan(2.78);
    expect(to).toBeLessThan(2.7 + 0.15 * Math.tan(Math.PI / 6) + 1e-6);
  });
});

describe('bars and a pipe swept along bends (web-ifc output)', () => {
  let elements: Map<number, SnapGeometry>;
  beforeAll(() => {
    elements = load(BEND_IFC);
  });
  afterAll(() => elements.clear());

  // [name, id, first leg, where it is, second leg, where it is, radius]. A
  // triangle belongs to a leg if its centroid is on the straight run: along x
  // short of x = 1000 mm, then along +y (world −z) past the bend's end.
  type Leg = [Axis, (p: THREE.Vector3) => boolean];
  const cases: Array<[string, number, Leg, Leg, number]> = [
    ['bar with a bend', 25, [alongX(0, 500), (p) => p.x < 1.0], [alongY(1040, 500), (p) => -p.z > 0.04], 0.01],
    ['bar with a sharp corner', 37, [alongX(-2000, 500), (p) => p.x < 1.0], [alongY(1000, 500), (p) => -p.z > -2.0], 0.01],
    ['pipe with an elbow', 45, [alongX(-4000, 500), (p) => p.x < 1.0], [alongY(1150, 500), (p) => -p.z > -3.85], 0.05],
  ];
  for (const [name, id, first, second, radius] of cases) {
    it(`snaps both straight legs to their axes — ${name}`, () => {
      const geo = elements.get(id)!;
      for (const [leg, within] of [first, second]) {
        const s = surfaceStats(geo, leg, radius, undefined, within);
        // Bend triangles are square to neither leg's axis exactly; the legs' are.
        expect(s.surface, name).toBeGreaterThanOrEqual(22);
        expect(s.snapping, name).toBe(s.surface);
        expect(s.worst).toBeLessThan(1e-5);
      }
    });
  }
});
