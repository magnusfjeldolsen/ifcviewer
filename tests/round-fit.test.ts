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

  it('on a bend, fits one ring of facets, on the centre line of its chord', () => {
    // A torus is nothing but bend. Each ring of facets is a straight piece of
    // tube along its chord, so its centre is off the true arc by the chord's
    // sag, R(1 − cos(Δθ/2)) — and the snap is held to that one piece.
    for (const segments of [12, 48, 180]) {
      const torus = buildSnapGeometry(new THREE.TorusGeometry(1, 0.05, 12, segments));
      const found = fitCurvedSide(torus, 0);
      const half = Math.PI / segments;
      expect(found.fit).not.toBeNull();
      // Twelve facets round, two triangles each: one ring and nothing more.
      expect(found.ring.length).toBe(24);
      const c = found.fit!.centre;
      expect(Math.abs(Math.hypot(c.x, c.y) - 1)).toBeLessThanOrEqual(1 - Math.cos(half) + 1e-4);
      expect(Math.abs(c.z)).toBeLessThan(1e-4);
      // Held within the chord, whose half-length is at most (R + r)·sin(Δθ/2).
      expect(found.fit!.halfLength).toBeLessThanOrEqual((1 + 0.05) * Math.sin(half) + 1e-4);
    }
  });
});

/**
 * A tube built ring by ring, so a test can put a straight run and a bend in
 * one piece the way a bent bar or a pipe with an elbow arrives from web-ifc.
 * Each ring is a function from the angle round the tube to a point.
 */
function tube(rings: Array<(a: number) => [number, number, number]>, segments: number, phase: number) {
  const positions: number[] = [];
  const index: number[] = [];
  const starts: number[] = [];
  for (const ring of rings) {
    starts.push(positions.length / 3);
    for (let i = 0; i < segments; i++) positions.push(...ring(((i + phase) * 2 * Math.PI) / segments));
  }
  for (let k = 0; k + 1 < starts.length; k++) {
    const a = starts[k];
    const b = starts[k + 1];
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      index.push(a + i, a + j, b + j, a + i, b + j, b + i);
    }
  }
  const first = starts[0];
  const last = starts[starts.length - 1];
  for (let i = 1; i < segments - 1; i++) {
    index.push(first, first + i + 1, first + i);
    index.push(last, last + i, last + i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  return buildSnapGeometry(g);
}

describe('roundFitsAt — a bend in the same piece', () => {
  const r = 0.05;

  /** A 1 m straight run along x into a 90° elbow of bend radius 0.15 m, turning to +y. */
  function pipeWithElbow(steps: number, phase: number) {
    const R = 0.15;
    const rings: Array<(a: number) => [number, number, number]> = [(a) => [-1, r * Math.cos(a), r * Math.sin(a)]];
    for (let k = 0; k <= steps; k++) {
      const th = ((k / steps) * Math.PI) / 2;
      rings.push((a) => {
        const rad = R - r * Math.cos(a);
        return [rad * Math.sin(th), R - rad * Math.cos(th), r * Math.sin(a)];
      });
    }
    return tube(rings, 12, phase);
  }

  it('snaps the straight run of a pipe to its axis, whatever the elbow is cut into', () => {
    for (const phase of [0, 0.25, 0.5]) {
      for (const steps of [3, 6, 12, 32]) {
        const geo = pipeWithElbow(steps, phase);
        // The straight run is the first ring band: triangles 0–23.
        for (let t = 0; t < 24; t++) {
          const fit = roundFitsAt(geo, t).find((f) => f.slides);
          expect(fit, `phase ${phase}, ${steps} steps, triangle ${t}`).toBeDefined();
          expect(Math.hypot(fit!.centre.y, fit!.centre.z)).toBeLessThan(1e-5);
          expect(fit!.radius).toBeCloseTo(r, 5);
          // The run stops where the elbow starts, at x = 0.
          expect(fit!.centre.x + fit!.halfLength).toBeCloseTo(0, 4);
        }
      }
    }
  });

  it('snaps the first leg of a mitred bend to its axis', () => {
    const L = 1;
    for (const phase of [0, 0.5]) {
      const geo = tube(
        [
          (a) => [0, r * Math.cos(a), r * Math.sin(a)],
          (a) => [L - r * Math.cos(a), r * Math.cos(a), r * Math.sin(a)],
          (a) => [L - r * Math.cos(a), L, r * Math.sin(a)],
        ],
        12,
        phase,
      );
      for (let t = 0; t < 24; t++) {
        const fit = roundFitsAt(geo, t).find((f) => f.slides);
        expect(fit, `phase ${phase}, triangle ${t}`).toBeDefined();
        expect(Math.hypot(fit!.centre.y, fit!.centre.z)).toBeLessThan(1e-5);
      }
    }
  });
});

describe('roundFitsAt — the answer does not depend on hover order', () => {
  /** A 12-segment turned column, shaft radius 0.3 m, with whatever top `profile` gives it. */
  function shaft(profile: Array<[number, number]>) {
    const geo = buildSnapGeometry(new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 12));
    const n = new THREE.Vector3();
    const triangles: number[] = [];
    for (let t = 0; t < geo.triangles.length / 3; t++) {
      n.set(geo.normals[t * 3], geo.normals[t * 3 + 1], geo.normals[t * 3 + 2]);
      if (Math.abs(n.y) < 1e-3) triangles.push(t);
    }
    return { geo, triangles };
  }

  const tops: Record<string, Array<[number, number]>> = {
    plain: [[0, 0], [0.3, 0], [0.3, 3], [0, 3]],
    // A capital flaring out at 30°, and a 45° chamfer: both put a fold that
    // runs round the column right next to the shaft.
    'flared capital': [[0, 0], [0.3, 0], [0.3, 2.7], [0.3 + 0.3 * Math.tan(Math.PI / 6), 3], [0, 3]],
    chamfer: [[0, 0], [0.3, 0], [0.3, 2.95], [0.25, 3], [0, 3]],
  };

  for (const [name, profile] of Object.entries(tops)) {
    for (const order of ['bottom first', 'top first'] as const) {
      it(`finds the shaft's axis from every shaft triangle — ${name}, ${order}`, () => {
        const { geo, triangles } = shaft(profile);
        expect(triangles.length).toBe(24);
        const sequence = order === 'bottom first' ? triangles : [...triangles].reverse();
        for (const t of sequence) {
          const fit = roundFitsAt(geo, t).find((f) => f.slides);
          expect(fit, `triangle ${t}`).toBeDefined();
          expect(fit!.radius).toBeCloseTo(0.3, 5);
          expect(Math.abs(fit!.axis.y)).toBeCloseTo(1, 6);
          expect(Math.hypot(fit!.centre.x, fit!.centre.z)).toBeLessThan(1e-5);
        }
      });
    }
  }
});

describe('roundFitsAt — finely cut cylinders', () => {
  const y = new THREE.Vector3(0, 1, 0);
  const firstSide = (geo: SnapGeometry) => triangleWhere(geo, (n) => Math.abs(n.dot(y)) < 1e-3);

  it('fits a tank or large pipe cut into many segments and many rows', () => {
    // 300 × 170 is about 100 000 triangles; the cut crosses only one ring.
    for (const [segments, rows] of [[64, 32], [300, 170]]) {
      const geo = buildSnapGeometry(new THREE.CylinderGeometry(0.3, 0.3, 30, segments, rows));
      const fit = roundFitsAt(geo, firstSide(geo)).find((f) => f.slides);
      expect(fit, `${segments} × ${rows}`).toBeDefined();
      expect(fit!.radius).toBeCloseTo(0.3, 5);
      // The run is the whole height, found by following the facet edges.
      expect(fit!.halfLength).toBeCloseTo(15, 3);
    }
  });

  it('fits cylinders cut finer than one degree a facet', () => {
    for (const segments of [400, 1000]) {
      const geo = buildSnapGeometry(new THREE.CylinderGeometry(0.3, 0.3, 3, segments));
      expect(roundFitsAt(geo, firstSide(geo)).some((f) => f.slides), `${segments}`).toBe(true);
    }
  });
});

describe('roundFitsAt — thin bars far from the chunk anchor (float32)', () => {
  it('fits 3–8 mm bars up to 1.5 km out', () => {
    for (const radius of [0.003, 0.005, 0.008]) {
      for (const offset of [200, 500, 1500]) {
        for (let k = 0; k < 20; k++) {
          const g = new THREE.CylinderGeometry(radius, radius, 2, 12);
          g.rotateZ(0.3 + k * 0.17);
          g.rotateX(0.2 + k * 0.05);
          g.translate(offset + k * 0.37, offset * 0.3 + k * 0.11, -offset * 0.7);
          const geo = buildSnapGeometry(g);
          const axis = new THREE.Vector3(0, 1, 0)
            .applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.3 + k * 0.17)
            .applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.2 + k * 0.05);
          const side = triangleWhere(geo, (n) => Math.abs(n.dot(axis)) < 0.1);
          const fit = roundFitsAt(geo, side).find((f) => f.slides);
          expect(fit, `${radius * 1000} mm at ${offset} m, bar ${k}`).toBeDefined();
          expect(fit!.radius).toBeCloseTo(radius, 3);
        }
      }
    }
  });
});

describe('roundFitsAt — more shapes that are not round', () => {
  it('rejects an ellipse, a sphere and a cone', () => {
    const ellipse = new THREE.Shape();
    ellipse.absellipse(0, 0, 0.3, 0.27, 0, Math.PI * 2, false, 0);
    const shapes = [
      prism(ellipse, 3),
      new THREE.SphereGeometry(0.5, 12, 12),
      new THREE.CylinderGeometry(0.3, 0.2, 3, 12),
    ];
    for (const g of shapes) {
      const geo = buildSnapGeometry(g);
      for (let t = 0; t < geo.triangles.length / 3; t++) {
        expect(roundFitsAt(geo, t).filter((f) => f.slides)).toEqual([]);
      }
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
  it('gives every triangle round a column the same centre, and remembers it', () => {
    const geo = buildSnapGeometry(new THREE.CylinderGeometry(0.3, 0.3, 3, 12));
    const y = new THREE.Vector3(0, 1, 0);
    const sides: number[] = [];
    const n = new THREE.Vector3();
    for (let t = 0; t < geo.triangles.length / 3; t++) {
      n.set(geo.normals[t * 3], geo.normals[t * 3 + 1], geo.normals[t * 3 + 2]);
      if (Math.abs(n.dot(y)) < 1e-3) sides.push(t);
    }
    const first: RoundFit = roundFitsAt(geo, sides[0])[0];
    for (const t of sides) {
      const fit = roundFitsAt(geo, t)[0];
      expect(fit.centre.distanceTo(first.centre)).toBeLessThan(1e-6);
      expect(fit.radius).toBeCloseTo(first.radius, 9);
      // Asking again is a lookup, not a second fit.
      expect(roundFitsAt(geo, t)[0]).toBe(fit);
    }
  });

  it('returns nothing for a triangle that does not exist', () => {
    const geo = buildSnapGeometry(new THREE.BoxGeometry());
    expect(roundFitsAt(geo, -1)).toEqual([]);
    expect(roundFitsAt(geo, 10_000)).toEqual([]);
  });
});
