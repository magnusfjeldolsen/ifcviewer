import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildSnapGeometry, type SnapGeometry } from '../src/tools/snapGeometry';
import { judgeRing, roundFitsAt, type RoundFit } from '../src/tools/roundFit';

/**
 * Issue #63, second review: what real meshes do to a round element, and what
 * must still be refused. Cases come from the reviewer's probes.
 */

const Y = new THREE.Vector3(0, 1, 0);
type Ring = (a: number) => [number, number, number];

/** A tube built ring by ring, with a choice of quad diagonal and optional end caps. */
function tube(rings: Ring[], segments: number, phase = 0, diagonal: (k: number, i: number) => boolean = () => true, caps = true) {
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
      if (diagonal(k, i)) index.push(a + i, a + j, b + j, a + i, b + j, b + i);
      else index.push(a + i, a + j, b + i, a + j, b + j, b + i);
    }
  }
  if (caps) {
    const first = starts[0];
    const last = starts[starts.length - 1];
    for (let i = 1; i < segments - 1; i++) {
      index.push(first, first + i + 1, first + i);
      index.push(last, last + i, last + i + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  return g;
}

const column = (r: number, heights: number[]): Ring[] =>
  heights.map((h) => (a: number) => [r * Math.cos(a), h, r * Math.sin(a)]);

function normalOf(geo: SnapGeometry, t: number) {
  return new THREE.Vector3(geo.normals[t * 3], geo.normals[t * 3 + 1], geo.normals[t * 3 + 2]);
}

/** Side triangles (normal square to y within `tolerance`) and the sliding fit each one gets. */
function sides(geo: SnapGeometry, tolerance = 0.05) {
  const out: Array<{ t: number; fit: RoundFit | undefined }> = [];
  for (let t = 0; t < geo.triangles.length / 3; t++) {
    if (Math.abs(normalOf(geo, t).dot(Y)) > tolerance) continue;
    out.push({ t, fit: roundFitsAt(geo, t).find((f) => f.slides) });
  }
  return out;
}

function expectAllOnAxis(geo: SnapGeometry, radius: number, tolerance = 0.05) {
  const found = sides(geo, tolerance);
  expect(found.length).toBeGreaterThan(0);
  for (const { t, fit } of found) {
    expect(fit, `triangle ${t}`).toBeDefined();
    expect(Math.hypot(fit!.centre.x, fit!.centre.z), `triangle ${t}`).toBeLessThan(1e-4);
    expect(fit!.radius).toBeCloseTo(radius, 4);
  }
  return found.length;
}

describe('round centres survive mesh defects', () => {
  it('steps across a T-junction on an axial edge', () => {
    const segments = 12;
    const r = 0.3;
    const positions: number[] = [];
    for (const h of [0, 3]) {
      for (let i = 0; i < segments; i++) positions.push(r * Math.cos((i * 2 * Math.PI) / segments), h, r * Math.sin((i * 2 * Math.PI) / segments));
    }
    positions.push(r, 1.5, 0); // the midpoint of the first axial edge, used on one side only
    const m = 2 * segments;
    const index: number[] = [];
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      if (i === 0) index.push(0, 1, m, m, 1, segments + 1, m, segments + 1, segments);
      else index.push(i, j, segments + j, i, segments + j, segments + i);
    }
    for (let i = 1; i < segments - 1; i++) index.push(0, i + 1, i, segments, segments + i, segments + i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(index);
    expect(expectAllOnAxis(buildSnapGeometry(g), r)).toBe(25);
  });

  it('steps across a seam that was not welded', () => {
    const g = tube(column(0.3, [0, 3]), 12);
    const positions = Array.from(g.getAttribute('position').array as Float32Array);
    const index = Array.from(g.getIndex()!.array);
    // Copies of the seam's two corners, 0.03 mm off — beyond the weld tolerance.
    const a = positions.length / 3;
    positions.push(positions[0] + 3e-5, positions[1], positions[2]);
    const b = positions.length / 3;
    positions.push(positions[36] + 3e-5, positions[37], positions[38]);
    for (let k = 66; k < 72; k++) {
      if (index[k] === 0) index[k] = a;
      if (index[k] === 12) index[k] = b;
    }
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g2.setIndex(index);
    expect(expectAllOnAxis(buildSnapGeometry(g2), 0.3)).toBe(24);
  });

  it('steps across duplicated triangles', () => {
    const g = tube(column(0.3, [0, 3]), 12);
    const index = Array.from(g.getIndex()!.array);
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', g.getAttribute('position'));
    g2.setIndex([...index, ...index]);
    expect(expectAllOnAxis(buildSnapGeometry(g2), 0.3)).toBe(48);
  });

  it('keeps the rows above and below a dent, and the dented row itself', () => {
    // One column of corners pushed in by 20% between heights 1 and 1.2. The
    // facets that use a dented corner are turned out of the ring; every other
    // triangle — in the dented row and the rows either side — still snaps.
    const g = tube(
      [0, 1, 1.2, 3].map((h, k): Ring => (a) => {
        const s = (k === 1 || k === 2) && Math.abs(Math.cos(a) - 1) < 1e-9 ? 0.8 : 1;
        return [0.3 * s * Math.cos(a), h, 0.3 * s * Math.sin(a)];
      }),
      12,
    );
    const geo = buildSnapGeometry(g);
    const dented = (i: number) => Math.hypot(geo.positions[i * 3], geo.positions[i * 3 + 2]) < 0.29;
    let checked = 0;
    for (let t = 0; t < geo.triangles.length / 3; t++) {
      if (Math.abs(normalOf(geo, t).dot(Y)) > 1e-3) continue;
      if ([0, 1, 2].some((k) => dented(geo.triangles[t * 3 + k]))) continue;
      const fit = roundFitsAt(geo, t).find((f) => f.slides);
      expect(fit, `triangle ${t}`).toBeDefined();
      expect(Math.hypot(fit!.centre.x, fit!.centre.z)).toBeLessThan(1e-4);
      expect(fit!.radius).toBeCloseTo(0.3, 4);
      checked++;
    }
    // Three rows of 24, less the triangles touching the four dented corners.
    expect(checked).toBeGreaterThanOrEqual(60);
  });

  it('handles alternating diagonals and uneven rows, and pipes with no end caps', () => {
    expectAllOnAxis(buildSnapGeometry(tube(column(0.3, [0, 0.5, 1.2, 2, 3]), 12, 0, (k, i) => (k + i) % 2 === 0)), 0.3);
    expectAllOnAxis(buildSnapGeometry(tube(column(0.3, [0, 3]), 12, 0, () => true, false)), 0.3);
  });

  it('fits a tall, finely rowed column without walking every row of every line', () => {
    // 4000 rows of 12 facets: following all 12 lines to the ends would look
    // at well over 100 000 triangles. The run is measured from the first line
    // in full and part of the rest, inside the run budget.
    const geo = buildSnapGeometry(tube(column(0.3, Array.from({ length: 4001 }, (_, k) => k * 0.01)), 12));
    const cost = { steps: 0 };
    const fit = roundFitsAt(geo, 48_000, cost).find((f) => f.slides);
    expect(fit).toBeDefined();
    expect(fit!.halfLength).toBeCloseTo(20, 3);
    expect(cost.steps).toBeLessThan(26_000);
  });
});

describe('judgeRing — one local defect, and nothing more', () => {
  const circle = (degrees: number[], r = 0.3, cx = 0.1, cy = -0.2) => ({
    xs: degrees.map((d) => cx + r * Math.cos((d * Math.PI) / 180)),
    ys: degrees.map((d) => cy + r * Math.sin((d * Math.PI) / 180)),
  });
  const twelve = Array.from({ length: 12 }, (_, i) => i * 30);

  it('accepts a full ring as it is', () => {
    const { xs, ys } = circle(twelve);
    expect(judgeRing(xs, ys)?.kept).toHaveLength(12);
  });

  it('accepts one gap of up to 90° — one or two facets missing — with the centre where it was', () => {
    for (const missing of [[90], [90, 120]]) {
      const { xs, ys } = circle(twelve.filter((d) => !missing.includes(d)));
      const judged = judgeRing(xs, ys)!;
      expect(judged, `${missing}`).not.toBeNull();
      expect(judged.circle.cx).toBeCloseTo(0.1, 9);
      expect(judged.circle.cy).toBeCloseTo(-0.2, 9);
    }
  });

  it('refuses a gap wider than 90°, and two gaps of any size over one facet', () => {
    const { xs: x3, ys: y3 } = circle(twelve.filter((d) => ![90, 120, 150].includes(d)));
    expect(judgeRing(x3, y3)).toBeNull();
    const { xs: x2, ys: y2 } = circle(twelve.filter((d) => ![60, 240].includes(d)));
    expect(judgeRing(x2, y2)).toBeNull();
  });

  it('sets aside a point knocked off the circle, when the rest is a clean ring', () => {
    const { xs, ys } = circle(twelve);
    // A dented corner, pushed 20% of the way in towards the centre.
    xs[3] = 0.1 + 0.8 * (xs[3] - 0.1);
    ys[3] = -0.2 + 0.8 * (ys[3] + 0.2);
    const judged = judgeRing(xs, ys)!;
    expect(judged).not.toBeNull();
    expect(judged.kept).not.toContain(3);
    expect(judged.circle.r).toBeCloseTo(0.3, 9);
  });

  it('refuses open arcs of less than 270°, a hexagon and a rounded rectangle', () => {
    const arc = circle(Array.from({ length: 10 }, (_, i) => i * 25)); // 225° of arc
    expect(judgeRing(arc.xs, arc.ys)).toBeNull();
    const hexagon = circle([0, 60, 120, 180, 240, 300, 0.001, 60.001]);
    expect(judgeRing(hexagon.xs, hexagon.ys)).toBeNull();
    // The corners of a rounded rectangle, 5 per arc: its error is spread all round.
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [cx, cy, start] of [[0.15, 0.1, 0], [-0.15, 0.1, 90], [-0.15, -0.1, 180], [0.15, -0.1, 270]]) {
      for (let k = 0; k <= 4; k++) {
        const a = ((start + (90 * k) / 4) * Math.PI) / 180;
        xs.push(cx + 0.15 * Math.cos(a));
        ys.push(cy + 0.15 * Math.sin(a));
      }
    }
    expect(judgeRing(xs, ys)).toBeNull();
  });
});

describe('shapes the defect rule must still keep out', () => {
  function cSection(span: number) {
    const outer: Array<[number, number]> = [];
    const n = Math.round(span / 30);
    for (let i = 0; i <= n; i++) outer.push([0.3 * Math.cos((i / n) * span * (Math.PI / 180)), 0.3 * Math.sin((i / n) * span * (Math.PI / 180))]);
    const inner = outer.map(([x, y]) => [x * (0.25 / 0.3), y * (0.25 / 0.3)] as [number, number]).reverse();
    const s = new THREE.Shape();
    const all = [...outer, ...inner];
    s.moveTo(...all[0]);
    for (const p of all.slice(1)) s.lineTo(...p);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 3, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    return buildSnapGeometry(g);
  }
  const anyFit = (geo: SnapGeometry) => {
    for (let t = 0; t < geo.triangles.length / 3; t++) if (roundFitsAt(geo, t).length) return true;
    return false;
  };

  it('refuses an open section covering less than three quarters of a circle', () => {
    expect(anyFit(cSection(250))).toBe(false);
  });

  it('accepts a section with at most a quarter cut away — its centre is still pinned', () => {
    // Stated, not accidental: a pipe with a 90° slot or less has a centre.
    for (const span of [270, 300]) {
      const geo = cSection(span);
      for (let t = 0; t < geo.triangles.length / 3; t++) {
        for (const fit of roundFitsAt(geo, t).filter((f) => f.slides)) {
          expect(Math.hypot(fit.centre.x, fit.centre.z)).toBeLessThan(1e-5);
        }
      }
    }
  });

  it('refuses an I-section with fillets', () => {
    const tf = 0.02, tw = 0.012, b = 0.2, h = 0.3, rr = 0.02;
    const s = new THREE.Shape();
    s.moveTo(-b / 2, -h / 2); s.lineTo(b / 2, -h / 2); s.lineTo(b / 2, -h / 2 + tf);
    s.lineTo(tw / 2 + rr, -h / 2 + tf); s.absarc(tw / 2 + rr, -h / 2 + tf + rr, rr, -Math.PI / 2, -Math.PI, true);
    s.lineTo(tw / 2, h / 2 - tf - rr); s.absarc(tw / 2 + rr, h / 2 - tf - rr, rr, Math.PI, Math.PI / 2, true);
    s.lineTo(b / 2, h / 2 - tf); s.lineTo(b / 2, h / 2); s.lineTo(-b / 2, h / 2); s.lineTo(-b / 2, h / 2 - tf);
    s.lineTo(-tw / 2 - rr, h / 2 - tf); s.absarc(-tw / 2 - rr, h / 2 - tf - rr, rr, Math.PI / 2, 0, true);
    s.lineTo(-tw / 2, -h / 2 + tf + rr); s.absarc(-tw / 2 - rr, -h / 2 + tf + rr, rr, 0, -Math.PI / 2, true);
    s.lineTo(-b / 2, -h / 2 + tf);
    const g = new THREE.ExtrudeGeometry(s, { depth: 3, bevelEnabled: false, curveSegments: 12 });
    g.rotateX(-Math.PI / 2);
    expect(anyFit(buildSnapGeometry(g))).toBe(false);
  });

  it('refuses rounded squares whose corners are under 90% of the half-width', () => {
    for (const f of [0.85, 0.9]) {
      const w = 0.3, rc = f * w;
      const s = new THREE.Shape();
      s.moveTo(-w + rc, -w); s.lineTo(w - rc, -w); s.absarc(w - rc, -w + rc, rc, -Math.PI / 2, 0, false);
      s.lineTo(w, w - rc); s.absarc(w - rc, w - rc, rc, 0, Math.PI / 2, false);
      s.lineTo(-w + rc, w); s.absarc(-w + rc, w - rc, rc, Math.PI / 2, Math.PI, false);
      s.lineTo(-w, -w + rc); s.absarc(-w + rc, -w + rc, rc, Math.PI, 1.5 * Math.PI, false);
      const g = new THREE.ExtrudeGeometry(s, { depth: 3, bevelEnabled: false, curveSegments: 6 });
      g.rotateX(-Math.PI / 2);
      expect(anyFit(buildSnapGeometry(g)), `${f}`).toBe(false);
    }
  });
});

describe('spheres are not cylinders', () => {
  it('finds no centre anywhere on a finely cut sphere', () => {
    for (const [w, h] of [[32, 16], [64, 32], [128, 64], [256, 128]]) {
      const geo = buildSnapGeometry(new THREE.SphereGeometry(1, w, h));
      const count = geo.triangles.length / 3;
      // Every triangle of the coarsest; an even sample of the finer ones.
      const step = Math.max(1, Math.floor(count / 400));
      for (let t = 0; t < count; t += step) expect(roundFitsAt(geo, t), `${w}×${h}, triangle ${t}`).toEqual([]);
    }
  });

  it('finds the centre on a capsule’s straight middle, and none on its rounded ends', () => {
    const geo = buildSnapGeometry(new THREE.CapsuleGeometry(0.3, 1, 16, 64));
    const n = new THREE.Vector3();
    for (let t = 0; t < geo.triangles.length / 3; t++) {
      n.copy(normalOf(geo, t));
      const fits = roundFitsAt(geo, t).filter((f) => f.slides);
      if (Math.abs(n.y) < 1e-6) {
        expect(fits, `middle triangle ${t}`).toHaveLength(1);
        expect(fits[0].halfLength).toBeCloseTo(0.5, 4);
      } else if (Math.abs(n.y) > 0.05) {
        expect(fits, `end triangle ${t}`).toEqual([]);
      }
    }
  });
});

describe('a bend prefers the pipe to the path', () => {
  it('snaps a torus to its tube, never to the middle of the ring, however the profile is phased', () => {
    const R = 1, r = 0.1;
    for (const [around, along, phase] of [[12, 48, 0.5], [16, 64, 0.5], [12, 48, 0]]) {
      const rings: Ring[] = [];
      for (let k = 0; k <= along; k++) {
        const u = (k / along) * 2 * Math.PI;
        rings.push((v) => [(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]);
      }
      const geo = buildSnapGeometry(tube(rings, around, phase, () => true, false));
      for (let t = 0; t < geo.triangles.length / 3; t++) {
        const fit = roundFitsAt(geo, t).find((f) => f.slides);
        expect(fit, `${around}×${along} phase ${phase}, triangle ${t}`).toBeDefined();
        expect(Math.abs(Math.hypot(fit!.centre.x, fit!.centre.y) - R)).toBeLessThan(0.02);
        expect(fit!.radius).toBeLessThan(0.11);
      }
    }
  });
});

describe('the slide range depends on the cylinder, not on the triangle', () => {
  it('gives every triangle of a pipe cut off at an angle the same range', () => {
    // Top end sloped: y = 2 + x across a 0.3 m radius.
    const geo = buildSnapGeometry(
      tube([(a) => [0.3 * Math.cos(a), 0, 0.3 * Math.sin(a)], (a) => [0.3 * Math.cos(a), 2 + 0.3 * Math.cos(a), 0.3 * Math.sin(a)]], 12),
    );
    const found = sides(geo);
    const first = found[0].fit!;
    for (const { t, fit } of found) {
      expect(fit, `triangle ${t}`).toBeDefined();
      expect(fit!.centre.distanceTo(first.centre), `triangle ${t}`).toBeLessThan(1e-6);
      expect(fit!.halfLength).toBeCloseTo(first.halfLength, 9);
    }
    // From the bottom to the highest point of the sloped end.
    expect(first.centre.y - first.halfLength).toBeCloseTo(0, 5);
    expect(first.centre.y + first.halfLength).toBeCloseTo(2.3, 5);
  });
});

describe('a large flat face gives the same answer in any hover order', () => {
  function plate() {
    const s = new THREE.Shape();
    const n = 1600;
    s.moveTo(0, 0);
    for (let i = 1; i <= n; i++) s.lineTo((10 * i) / n, 0);
    for (let i = 1; i <= n; i++) s.lineTo(10, (10 * i) / n);
    for (let i = 1; i <= n; i++) s.lineTo(10 - (10 * i) / n, 10);
    for (let i = 1; i < n; i++) s.lineTo(0, 10 - (10 * i) / n);
    s.holes.push(new THREE.Path().absarc(9, 9, 0.3, 0, Math.PI * 2, true));
    return buildSnapGeometry(new THREE.ShapeGeometry(s, 24));
  }

  it('finds the hole from beside it whether or not a far corner was hovered first', () => {
    for (const farFirst of [false, true]) {
      const geo = plate();
      let near = -1, far = -1, nearest = Infinity, farthest = -Infinity;
      for (let t = 0; t < geo.triangles.length / 3; t++) {
        let x = 0, y = 0;
        for (let k = 0; k < 3; k++) {
          const i = geo.triangles[t * 3 + k];
          x += geo.positions[i * 3] / 3;
          y += geo.positions[i * 3 + 1] / 3;
        }
        const d = Math.hypot(x - 9, y - 9);
        if (d < nearest) { nearest = d; near = t; }
        if (d > farthest) { farthest = d; far = t; }
      }
      if (farFirst) roundFitsAt(geo, far);
      expect(roundFitsAt(geo, near), farFirst ? 'far first' : 'near first').toHaveLength(1);
    }
  });
});
