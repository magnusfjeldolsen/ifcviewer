import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildSnapGeometry, type SnapGeometry } from '../src/tools/snapGeometry';
import { roundFitsAt, STEP_BUDGET } from '../src/tools/roundFit';

/**
 * Issue #63, pre-push review: what one hover may cost, counted in steps (not
 * milliseconds, so the test means the same on every machine), and two ways
 * the slide range went wrong.
 */

/** A (nu × nv) quad grid laid on f(u, v), u and v in [0, 1]. */
function grid(nu: number, nv: number, f: (u: number, v: number) => [number, number, number]) {
  const positions: number[] = [];
  const index: number[] = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) positions.push(...f(i / nu, j / nv));
  const w = nu + 1;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * w + i;
      index.push(a, a + 1, a + w + 1, a, a + w + 1, a + w);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  return buildSnapGeometry(g);
}

/** The most steps any of `samples` evenly spaced triangles costs on first hover, and how many found a centre. */
function costOf(geo: SnapGeometry, samples = 24) {
  const count = geo.triangles.length / 3;
  const stride = Math.max(1, Math.floor(count / samples));
  let most = 0;
  let found = 0;
  for (let t = 0; t < count; t += stride) {
    const cost = { steps: 0 };
    if (roundFitsAt(geo, t, cost).some((f) => f.slides)) found++;
    most = Math.max(most, cost.steps);
    // Asking again is a lookup.
    const again = { steps: 0 };
    roundFitsAt(geo, t, again);
    expect(again.steps).toBe(0);
  }
  return { most, found };
}

describe('the cost of one hover is bounded', () => {
  it('turns a curved façade away cheaply — an open 120° arc of radius 30 m', () => {
    // Once 100–400 ms a triangle: the broken cut's thousands of points went
    // through the defect rule. It cannot pass that rule without turning
    // through 225°, so now it is turned away before.
    const arc = (u: number, v: number): [number, number, number] => {
      const a = u * ((2 * Math.PI) / 3);
      return [30 * Math.cos(a), v * 10, 30 * Math.sin(a)];
    };
    const tall = costOf(grid(1500, 20, arc));
    expect(tall.found).toBe(0);
    expect(tall.most).toBeLessThan(8_000);
    const long = costOf(grid(3000, 4, arc));
    expect(long.found).toBe(0);
    expect(long.most).toBeLessThan(15_000);
  });

  it('turns a 180° vault away cheaply', () => {
    const vault = costOf(grid(1000, 50, (u, v) => [8 * Math.cos(u * Math.PI), 8 * Math.sin(u * Math.PI), v * 40]));
    expect(vault.found).toBe(0);
    expect(vault.most).toBeLessThan(6_000);
  });

  it('turns a finely cut elliptic tank away without refitting it hundreds of times', () => {
    for (const ratio of [0.8, 0.5]) {
      const g = new THREE.CylinderGeometry(1, 1, 4, 2048, 2, true);
      g.scale(1, 1, ratio);
      const tank = costOf(buildSnapGeometry(g), 12);
      expect(tank.found).toBe(0);
      expect(tank.most).toBeLessThan(25_000);
    }
  });

  it('turns near-flat terrain away cheaply', () => {
    const terrain = costOf(grid(200, 200, (u, v) => [u * 300, 0.01 * Math.sin(u * 3), v * 300]));
    expect(terrain.found).toBe(0);
    expect(terrain.most).toBeLessThan(6_000);
  });

  it('fits a 409 600-triangle cylinder without scanning the whole piece', () => {
    // Once an 82 ms scan of every edge of the piece on first hover.
    const cylinder = costOf(buildSnapGeometry(new THREE.CylinderGeometry(2, 2, 40, 512, 400, true)), 12);
    expect(cylinder.found).toBeGreaterThan(0);
    expect(cylinder.most).toBeLessThan(12_000);
  });

  it('never spends more than the budget, and remembers running out as nothing found', () => {
    // A ring of 8000 segments is past the 4096 a cut will walk.
    const geo = buildSnapGeometry(new THREE.CylinderGeometry(1, 1, 2, 8000, 1, true));
    const cost = { steps: 0 };
    const first = roundFitsAt(geo, 0, cost);
    expect(cost.steps).toBeLessThanOrEqual(STEP_BUDGET + 4096);
    expect(first.filter((f) => f.slides)).toEqual([]);
    const again = { steps: 0 };
    expect(roundFitsAt(geo, 0, again)).toEqual(first);
    expect(again.steps).toBe(0);
  });
});

describe('the slide range belongs to the cylinder under the cursor', () => {
  /** A turned column, radius 0.3 m, with a 0.2 m neck from 1.5 to 1.7 m, its axis through the piece's origin. */
  function neckedColumn() {
    const profile = [[0.3, 0], [0.3, 1.4], [0.2, 1.5], [0.2, 1.7], [0.3, 1.8], [0.3, 3]].map(([x, y]) => new THREE.Vector2(x, y));
    return buildSnapGeometry(new THREE.LatheGeometry(profile, 24));
  }
  function triangleWhere(geo: SnapGeometry, test: (radius: number, y: number) => boolean) {
    for (let t = 0; t < geo.triangles.length / 3; t++) {
      let r = 0;
      let y = 0;
      for (let k = 0; k < 3; k++) {
        const i = geo.triangles[t * 3 + k];
        r += Math.hypot(geo.positions[i * 3], geo.positions[i * 3 + 2]) / 3;
        y += geo.positions[i * 3 + 1] / 3;
      }
      if (test(r, y)) return t;
    }
    throw new Error('no such triangle');
  }
  const rangeOf = (geo: SnapGeometry, t: number) => {
    const fit = roundFitsAt(geo, t).find((f) => f.slides)!;
    expect(fit).toBeDefined();
    return [fit.centre.y - fit.halfLength, fit.centre.y + fit.halfLength];
  };

  for (const neckFirst of [true, false]) {
    it(`keeps a column and its coaxial neck apart — ${neckFirst ? 'neck' : 'column'} hovered first`, () => {
      const geo = neckedColumn();
      const neck = triangleWhere(geo, (r, y) => Math.abs(r - 0.2) < 0.02 && y > 1.5 && y < 1.7);
      const shaft = triangleWhere(geo, (r, y) => Math.abs(r - 0.3) < 0.02 && y < 1.2);
      const [first, second] = neckFirst ? [neck, shaft] : [shaft, neck];
      const ranges = new Map([[first, rangeOf(geo, first)], [second, rangeOf(geo, second)]]);
      const [neckFrom, neckTo] = ranges.get(neck)!;
      expect(neckFrom).toBeCloseTo(1.5, 5);
      expect(neckTo).toBeCloseTo(1.7, 5);
      const [shaftFrom, shaftTo] = ranges.get(shaft)!;
      expect(shaftFrom).toBeCloseTo(0, 5);
      expect(shaftTo).toBeCloseTo(1.4, 5);
    });
  }

  it('keeps two bars end to end on one axis to their own lengths', () => {
    // One element, two pieces of bar: 0–1 m and 3–4 m along x.
    const bar = (from: number) => {
      const g = new THREE.CylinderGeometry(0.01, 0.01, 1, 12);
      g.rotateZ(-Math.PI / 2);
      g.translate(from + 0.5, 0, 0);
      return g;
    };
    const a = bar(0);
    const b = bar(3);
    const positions = [...(a.toNonIndexed().getAttribute('position').array as Float32Array), ...(b.toNonIndexed().getAttribute('position').array as Float32Array)];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const geo = buildSnapGeometry(g);
    const ranges = new Set<string>();
    for (let t = 0; t < geo.triangles.length / 3; t++) {
      const fit = roundFitsAt(geo, t).find((f) => f.slides);
      if (!fit) continue;
      const along = fit.centre.x;
      ranges.add(`${(along - fit.halfLength).toFixed(4)}..${(along + fit.halfLength).toFixed(4)}`);
    }
    expect([...ranges].sort()).toEqual(['0.0000..1.0000', '3.0000..4.0000']);
  });
});
