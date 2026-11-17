import { describe, it, expect } from 'vitest';
import { weldVertices, WELD_NORMAL_STEPS } from '../src/parser/weld';

/** Two triangles forming a unit quad in z = 0, each with its own three vertices. */
function quad(normalB: [number, number, number] = [0, 0, 1]) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, ...normalB, ...normalB, ...normalB]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  return { positions, normals, indices };
}

describe('weldVertices', () => {
  it('shares corners that have the same position and normal', () => {
    const q = quad();
    const out = weldVertices(q.positions, q.normals, q.indices);
    expect(out.positions.length / 3).toBe(4);
    // Same triangles: every index still names the same corner position.
    for (let i = 0; i < 6; i++) {
      const before = Array.from(q.positions.subarray(q.indices[i] * 3, q.indices[i] * 3 + 3));
      const after = Array.from(out.positions.subarray(out.indices[i] * 3, out.indices[i] * 3 + 3));
      expect(after).toEqual(before);
    }
  });

  it('keeps a hard edge: same position, different normal stays two vertices', () => {
    const q = quad([0, 1, 0]);
    const out = weldVertices(q.positions, q.normals, q.indices, WELD_NORMAL_STEPS);
    expect(out.positions.length / 3).toBe(6);
  });

  it('merges normals that differ only below the stored precision when asked to', () => {
    const q = quad([0.0004, 0, 0.9999999]);
    expect(weldVertices(q.positions, q.normals, q.indices).positions.length / 3).toBe(6);
    expect(weldVertices(q.positions, q.normals, q.indices, WELD_NORMAL_STEPS).positions.length / 3).toBe(4);
  });

  it('keeps every distinct position, so bounds taken before welding describe the vertices sent', () => {
    // The worker computes `ParsedMesh.bounds` in the pass before welding.
    const q = quad([0, 1, 0]);
    q.positions.set([5, -2, 7], 3 * 3); // a far corner that only one triangle uses
    const out = weldVertices(q.positions, q.normals, q.indices, WELD_NORMAL_STEPS);
    const extent = (p: Float32Array) => {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i++) {
        min[i % 3] = Math.min(min[i % 3], p[i]);
        max[i % 3] = Math.max(max[i % 3], p[i]);
      }
      return { min, max };
    };
    expect(extent(out.positions)).toEqual(extent(q.positions));
  });

  it('returns the inputs untouched when nothing merges', () => {
    const q = quad([0, 1, 0]);
    const out = weldVertices(q.positions, q.normals, q.indices);
    expect(out.positions).toBe(q.positions);
    expect(out.indices).toBe(q.indices);
  });
});
