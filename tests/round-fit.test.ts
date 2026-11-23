import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildSnapGeometry, type SnapGeometry } from '../src/tools/snapGeometry';
import {
  fitCircle2D,
  isRound,
  roundFitsAt,
  fitCurvedSide,
  MAX_FACET_DEG,
  type RoundFit,
} from '../src/tools/roundFit';

/**
 * Expected centres come from how each shape was built — a cylinder made about
 * a known axis has its centre on that axis whatever the fitting code does.
 */

function polygon(n: number, r: number, cx = 0, cy = 0, from = 0, to = 2 * Math.PI) {
  const xs: number[] = [];
  const ys: number[] = [];
  const closed = Math.abs(to - from - 2 * Math.PI) < 1e-9;
  const steps = closed ? n : n + 1;
  for (let i = 0; i < steps; i++) {
    const a = from + ((to - from) * i) / n;
    xs.push(cx + r * Math.cos(a));
    ys.push(cy + r * Math.sin(a));
  }
  return { xs, ys };
}

/** The outline of a rounded rectangle, each corner arc cut into `segments`. */
function roundedRect(halfW: number, halfH: number, rc: number, segments: number) {
  const xs: number[] = [];
  const ys: number[] = [];
  const corners: Array<[number, number, number]> = [
    [halfW - rc, halfH - rc, 0],
    [-(halfW - rc), halfH - rc, Math.PI / 2],
    [-(halfW - rc), -(halfH - rc), Math.PI],
    [halfW - rc, -(halfH - rc), (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = start + ((Math.PI / 2) * i) / segments;
      xs.push(cx + rc * Math.cos(a));
      ys.push(cy + rc * Math.sin(a));
    }
  }
  return { xs, ys };
}

/** A geometry in a known pose: built about +y at the origin, then moved. */
function posed(g: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  g.applyMatrix4(matrix);
  return g;
}

/** A pose that tilts the axis off every coordinate axis and moves it far from the origin. */
function awkwardPose(offset = new THREE.Vector3(37.5, -12.25, 8)): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeRotationFromEuler(new THREE.Euler(0.4, 0.9, -0.3))
    .setPosition(offset);
}

/** The axis a pose sends +y to, and the point it sends the origin to. */
function axisOf(matrix: THREE.Matrix4) {
  return {
    point: new THREE.Vector3().applyMatrix4(matrix),
    direction: new THREE.Vector3(0, 1, 0).transformDirection(matrix),
  };
}

function distanceToLine(p: THREE.Vector3, point: THREE.Vector3, direction: THREE.Vector3): number {
  const d = p.clone().sub(point);
  return d.sub(direction.clone().multiplyScalar(d.dot(direction))).length();
}

/** The first triangle whose normal satisfies `test`. */
function triangleWhere(geo: SnapGeometry, test: (n: THREE.Vector3) => boolean): number {
  const n = new THREE.Vector3();
  for (let t = 0; t < geo.triangles.length / 3; t++) {
    n.set(geo.normals[t * 3], geo.normals[t * 3 + 1], geo.normals[t * 3 + 2]);
    if (test(n)) return t;
  }
  throw new Error('no such triangle');
}

/** Pick a side triangle (normal square to the axis) and a cap triangle (normal along it). */
function sideAndCap(geo: SnapGeometry, axis: THREE.Vector3) {
  return {
    side: triangleWhere(geo, (n) => Math.abs(n.dot(axis)) < 1e-3),
    cap: triangleWhere(geo, (n) => n.dot(axis) > 0.999),
  };
}

function prism(shape: THREE.Shape, depth: number, curveSegments = 12): THREE.BufferGeometry {
  // Extruded along +z; rotated so the extrusion runs along +y like a cylinder.
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments });
  g.rotateX(-Math.PI / 2);
  return g;
}

describe('fitCircle2D', () => {
  it('recovers the centre and radius of a regular polygon far from the origin', () => {
    const { xs, ys } = polygon(12, 0.2, 6_650_000, 600_000);
    const c = fitCircle2D(xs, ys)!;
    expect(c.cx).toBeCloseTo(6_650_000, 6);
    expect(c.cy).toBeCloseTo(600_000, 6);
    expect(c.r).toBeCloseTo(0.2, 9);
    expect(c.residual).toBeLessThan(1e-6);
    expect(c.maxGapDeg).toBeCloseTo(30, 6);
  });

  it('returns null for points on a line', () => {
    expect(fitCircle2D([0, 1, 2, 3], [0, 1, 2, 3])).toBeNull();
  });
});

describe('isRound — what counts as round', () => {
  it('accepts the 12-segment circle web-ifc produces by default', () => {
    const { xs, ys } = polygon(12, 0.25);
    expect(isRound(fitCircle2D(xs, ys))).toBe(true);
  });

  it('accepts an octagon, the coarsest polygon treated as round', () => {
    const { xs, ys } = polygon(8, 0.25);
    expect(isRound(fitCircle2D(xs, ys))).toBe(true);
    expect(MAX_FACET_DEG).toBe(45);
  });

  it('rejects a hexagon and a square: their corners are on a circle but their sides are too wide', () => {
    for (const n of [6, 4]) {
      const { xs, ys } = polygon(n, 0.25);
      expect(isRound(fitCircle2D(xs, ys))).toBe(false);
    }
  });

  it('rejects an open arc, however well its points fit', () => {
    // A curved beam's web: a 22° slice of a 6 m circle.
    const { xs, ys } = polygon(6, 6, 0, 0, 0, (22 * Math.PI) / 180);
    const c = fitCircle2D(xs, ys)!;
    expect(c.residual).toBeLessThan(1e-6);
    expect(isRound(c)).toBe(false);
  });

  it('rejects the rounded-rectangle hollow sections in the Snowdon sample', () => {
    // HSS 6x6 with a 0.0968 ft corner radius, as in the sample's profiles.
    const { xs, ys } = roundedRect(0.25, 0.25, 0.0968, 3);
    expect(isRound(fitCircle2D(xs, ys))).toBe(false);
  });

  it('rejects a rounded rectangle even when its corner arcs are finely cut', () => {
    const { xs, ys } = roundedRect(0.3, 0.2, 0.05, 16);
    expect(isRound(fitCircle2D(xs, ys))).toBe(false);
  });
});

describe('roundFitsAt — the curved side', () => {
  it('finds the axis of a tilted, displaced cylinder from a hit on its side', () => {
    const pose = awkwardPose();
    const geo = buildSnapGeometry(posed(new THREE.CylinderGeometry(0.3, 0.3, 3, 12), pose));
    const truth = axisOf(pose);
    const { side } = sideAndCap(geo, truth.direction);

    const fits = roundFitsAt(geo, side);
    const fit = fits.find((f) => f.slides)!;
    expect(fit).toBeDefined();
    expect(distanceToLine(fit.centre, truth.point, truth.direction)).toBeLessThan(1e-4);
    expect(Math.abs(fit.axis.dot(truth.direction))).toBeCloseTo(1, 6);
    expect(fit.radius).toBeCloseTo(0.3, 4);
  });

  it('works on a thin bar — the 3/4" rebar in the Snowdon sample — far from the origin', () => {
    const pose = awkwardPose(new THREE.Vector3(-70, -5.8, 20));
    const geo = buildSnapGeometry(posed(new THREE.CylinderGeometry(0.03125, 0.03125, 10, 12), pose));
    const truth = axisOf(pose);
    const { side } = sideAndCap(geo, truth.direction);

    const fit = roundFitsAt(geo, side).find((f) => f.slides)!;
    expect(fit).toBeDefined();
    // Within 1% of the radius: well under a millimetre on a 19 mm bar.
    expect(distanceToLine(fit.centre, truth.point, truth.direction)).toBeLessThan(0.0003);
  });

  it('finds the axis of the inside of a hollow pipe as well as the outside', () => {
    const shape = new THREE.Shape().absarc(0, 0, 0.1, 0, Math.PI * 2, false);
    shape.holes.push(new THREE.Path().absarc(0, 0, 0.08, 0, Math.PI * 2, true));
    const geo = buildSnapGeometry(prism(shape, 2));
    const y = new THREE.Vector3(0, 1, 0);

    // Outside faces point away from the axis, inside faces towards it.
    const outward = (t: number) => {
      const n = new THREE.Vector3(geo.normals[t * 3], geo.normals[t * 3 + 1], geo.normals[t * 3 + 2]);
      const i = geo.triangles[t * 3];
      const p = new THREE.Vector3(geo.positions[i * 3], 0, geo.positions[i * 3 + 2]);
      return n.dot(p) > 0;
    };
    const n = new THREE.Vector3();
    let outer = -1;
    let inner = -1;
    for (let t = 0; t < geo.triangles.length / 3; t++) {
      n.set(geo.normals[t * 3], geo.normals[t * 3 + 1], geo.normals[t * 3 + 2]);
      if (Math.abs(n.dot(y)) > 1e-3) continue;
      if (outward(t) && outer < 0) outer = t;
      if (!outward(t) && inner < 0) inner = t;
    }

    const outerFit = roundFitsAt(geo, outer).find((f) => f.slides)!;
    const innerFit = roundFitsAt(geo, inner).find((f) => f.slides)!;
    expect(outerFit.radius).toBeCloseTo(0.1, 4);
    expect(innerFit.radius).toBeCloseTo(0.08, 4);
    for (const fit of [outerFit, innerFit]) {
      expect(Math.hypot(fit.centre.x, fit.centre.z)).toBeLessThan(1e-5);
    }
  });

  it('accepts an octagonal column and rejects a hexagonal one', () => {
    const y = new THREE.Vector3(0, 1, 0);
    const octagon = buildSnapGeometry(new THREE.CylinderGeometry(0.3, 0.3, 3, 8));
    const hexagon = buildSnapGeometry(new THREE.CylinderGeometry(0.3, 0.3, 3, 6));
    expect(roundFitsAt(octagon, sideAndCap(octagon, y).side)).toHaveLength(1);
    expect(roundFitsAt(hexagon, sideAndCap(hexagon, y).side)).toHaveLength(0);
  });

  it('finds nothing round on a box', () => {
    const geo = buildSnapGeometry(new THREE.BoxGeometry(1, 2, 3));
    for (let t = 0; t < geo.triangles.length / 3; t++) expect(roundFitsAt(geo, t)).toEqual([]);
  });

  it('finds nothing round on a rounded rectangular hollow section', () => {
    const outline = new THREE.Shape();
    const w = 0.25;
    const rc = 0.0968;
    outline.moveTo(-w + rc, -w);
    outline.lineTo(w - rc, -w);
    outline.absarc(w - rc, -w + rc, rc, -Math.PI / 2, 0, false);
    outline.lineTo(w, w - rc);
    outline.absarc(w - rc, w - rc, rc, 0, Math.PI / 2, false);
    outline.lineTo(-w + rc, w);
    outline.absarc(-w + rc, w - rc, rc, Math.PI / 2, Math.PI, false);
    outline.lineTo(-w, -w + rc);
    outline.absarc(-w + rc, -w + rc, rc, Math.PI, (3 * Math.PI) / 2, false);
    const geo = buildSnapGeometry(prism(outline, 3, 3));
    for (let t = 0; t < geo.triangles.length / 3; t++) expect(roundFitsAt(geo, t)).toEqual([]);
  });

  it('does not grow round a bend: a bent bar is fitted to the straight run that was hit', () => {
    // An L of two cylinders would weld at the joint only by luck; a torus is
    // nothing but bend, so the side may never extend beyond one ring of facets.
    const torus = buildSnapGeometry(new THREE.TorusGeometry(1, 0.05, 12, 48));
    const found = fitCurvedSide(torus, 0);
    // One segment of 48 is two triangles per facet, twelve facets round.
    expect(found.triangles.length).toBeLessThanOrEqual(24);
    if (found.fit) {
      // Whatever it found is on the tube's centreline, which is radius 1 about z.
      const c = found.fit.centre;
      expect(Math.abs(Math.hypot(c.x, c.y) - 1)).toBeLessThan(0.01);
      expect(Math.abs(c.z)).toBeLessThan(0.01);
    }
  });
});

describe('roundFitsAt — a flat round outline', () => {
  it('finds the centre of a column top, seen in plan', () => {
    const pose = awkwardPose();
    const geo = buildSnapGeometry(posed(new THREE.CylinderGeometry(0.3, 0.3, 3, 12), pose));
    const truth = axisOf(pose);
    const { cap } = sideAndCap(geo, truth.direction);

    const fits = roundFitsAt(geo, cap);
    expect(fits).toHaveLength(1);
    const expected = truth.point.clone().addScaledVector(truth.direction, 1.5);
    expect(fits[0].slides).toBe(false);
    expect(fits[0].centre.distanceTo(expected)).toBeLessThan(1e-4);
  });

  it('finds the centre of a round hole in a plate, and nothing for the plate outline', () => {
    const plate = new THREE.Shape();
    plate.moveTo(0, 0);
    plate.lineTo(2, 0);
    plate.lineTo(2, 1);
    plate.lineTo(0, 1);
    plate.lineTo(0, 0);
    plate.holes.push(new THREE.Path().absarc(1.4, 0.5, 0.15, 0, Math.PI * 2, true));
    const geo = buildSnapGeometry(prism(plate, 0.2));
    const top = triangleWhere(geo, (n) => n.y > 0.999);

    const fits = roundFitsAt(geo, top);
    expect(fits).toHaveLength(1);
    // The plate was extruded along +z then turned so +z became +y; the shape's
    // y became -z.
    expect(fits[0].centre.x).toBeCloseTo(1.4, 4);
    expect(fits[0].centre.z).toBeCloseTo(-0.5, 4);
    expect(fits[0].radius).toBeCloseTo(0.15, 4);
  });

  it('gives both rims of a pipe end the same centre', () => {
    const shape = new THREE.Shape().absarc(0, 0, 0.1, 0, Math.PI * 2, false);
    shape.holes.push(new THREE.Path().absarc(0, 0, 0.08, 0, Math.PI * 2, true));
    const geo = buildSnapGeometry(prism(shape, 2));
    const end = triangleWhere(geo, (n) => n.y > 0.999);

    const fits = roundFitsAt(geo, end);
    expect(fits).toHaveLength(2);
    expect(fits[0].centre.distanceTo(fits[1].centre)).toBeLessThan(1e-5);
  });
});

describe('roundFitsAt — caching', () => {
  it('fits a side once, and every triangle on it shares the answer', () => {
    const geo = buildSnapGeometry(new THREE.CylinderGeometry(0.3, 0.3, 3, 12));
    const y = new THREE.Vector3(0, 1, 0);
    const sides: number[] = [];
    const n = new THREE.Vector3();
    for (let t = 0; t < geo.triangles.length / 3; t++) {
      n.set(geo.normals[t * 3], geo.normals[t * 3 + 1], geo.normals[t * 3 + 2]);
      if (Math.abs(n.dot(y)) < 1e-3) sides.push(t);
    }
    const first: RoundFit = roundFitsAt(geo, sides[0])[0];
    for (const t of sides) expect(roundFitsAt(geo, t)[0]).toBe(first);
  });

  it('returns nothing for a triangle that does not exist', () => {
    const geo = buildSnapGeometry(new THREE.BoxGeometry());
    expect(roundFitsAt(geo, -1)).toEqual([]);
    expect(roundFitsAt(geo, 10_000)).toEqual([]);
  });
});
