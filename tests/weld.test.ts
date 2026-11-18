import { describe, it, expect } from 'vitest';
import { weldVertices, weldForTransfer, WeldScratch, WELD_NORMAL_STEPS } from '../src/parser/weld';

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

describe('weldForTransfer', () => {
  it('welds like weldVertices at 8-bit normals, and sends byte normals and 16-bit indices', () => {
    // Two triangles sharing an edge, each with its own corners (as web-ifc emits).
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const normals = new Float32Array(18).map((_, i) => (i % 3 === 2 ? 1 : 0));
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const ref = weldVertices(positions, normals, indices, WELD_NORMAL_STEPS);
    const out = weldForTransfer(positions, normals, indices, new WeldScratch());
    expect(Array.from(out.positions)).toEqual(Array.from(ref.positions));
    expect(Array.from(out.indices)).toEqual(Array.from(ref.indices));
    expect(out.normals).toBeInstanceOf(Int8Array);
    expect(Array.from(out.normals)).toEqual(Array.from(ref.normals).map((v) => Math.round(v * 127)));
    expect(out.indices).toBeInstanceOf(Uint16Array);
  });

  it('clamps a normal a hair over 1 instead of wrapping it', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1]);
    const normals = new Float32Array([0, 0, 1.004, 0, 0, -1.004, 0, 0, 1, 0, 0, 1]);
    const out = weldForTransfer(positions, normals, new Uint32Array([0, 1, 2, 3]), new WeldScratch());
    expect(Array.from(out.normals.subarray(0, 6))).toEqual([0, 0, 127, 0, 0, -127]);
  });

  it('keeps 32-bit indices when the piece has more vertices than 16 bits address', () => {
    const n = 70000;
    const positions = new Float32Array(n * 3).map((_, i) => i);
    const normals = new Float32Array(n * 3);
    const out = weldForTransfer(positions, normals, new Uint32Array([0, 69999]), new WeldScratch());
    expect(out.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(out.indices)).toEqual([0, 69999]);
  });

  it('allocates fresh results even from reused scratch, so a sent piece is never overwritten', () => {
    const scratch = new WeldScratch();
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 2, 2]);
    const normals = new Float32Array(12);
    const a = weldForTransfer(positions, normals, new Uint32Array([0, 1, 2, 3]), scratch);
    const b = weldForTransfer(positions.map((v) => v + 10), normals, new Uint32Array([0, 1, 2, 3]), scratch);
    expect(a.positions[0]).toBe(0);
    expect(b.positions[0]).toBe(10);
    expect(a.positions.buffer).not.toBe(b.positions.buffer);
  });
});
