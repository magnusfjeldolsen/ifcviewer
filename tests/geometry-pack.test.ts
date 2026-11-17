import { describe, it, expect } from 'vitest';
import { packMeshes, packedSize, unpackMeshes } from '../src/services/geometryPack';
import type { ParsedMesh } from '../src/parser/types';

function mesh(id: number, verts: number, withBounds = true): ParsedMesh {
  const vertices = new Float32Array(verts * 3).map((_, i) => 1000000.125 + i * 0.37 + id);
  const normals = new Float32Array(verts * 3).map((_, i) => Math.sin(i + id));
  const indices = new Uint32Array(verts).map((_, i) => (i * 7) % verts);
  const m: ParsedMesh = {
    expressID: id,
    vertices,
    normals,
    indices,
    transform: Array.from({ length: 16 }, (_, i) => i * 0.1 + 1e-9 * id),
    color: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 },
  };
  if (withBounds) m.bounds = { min: [1, 2, 3], max: [4.5, 5.5, 6.25] };
  return m;
}

describe('packMeshes / unpackMeshes', () => {
  it('round-trips positions, indices, colours, transforms and bounds exactly', () => {
    // Odd vertex counts exercise the padding after the byte normals.
    const meshes = [mesh(5, 3), mesh(7, 5, false), mesh(9, 0), mesh(11, 1)];
    const back = unpackMeshes(packMeshes(meshes));
    expect(back).toHaveLength(4);
    back.forEach((b, i) => {
      const m = meshes[i];
      expect(b.expressID).toBe(m.expressID);
      expect(Array.from(b.vertices)).toEqual(Array.from(m.vertices));
      expect(Array.from(b.indices)).toEqual(Array.from(m.indices));
      expect(b.color).toEqual(m.color);
      expect(b.transform).toEqual(m.transform);
      expect(b.bounds).toEqual(m.bounds);
    });
  });

  it('keeps normals to within the 8-bit resolution they are drawn at', () => {
    const m = mesh(1, 50);
    const [b] = unpackMeshes(packMeshes([m]));
    for (let i = 0; i < m.normals.length; i++) expect(Math.abs(b.normals[i] - m.normals[i])).toBeLessThanOrEqual(0.5 / 127 + 1e-7);
  });

  it('keeps 32-bit indices for a piece with more vertices than 16 bits can address', () => {
    const big = mesh(3, 70000);
    big.indices = new Uint32Array([0, 65536, 69999, 1, 2, 3]);
    const [b] = unpackMeshes(packMeshes([big, mesh(4, 3)]).slice(0));
    expect(Array.from(b.indices)).toEqual([0, 65536, 69999, 1, 2, 3]);
  });

  it('stores small pieces’ indices in 16 bits, so a part is smaller', () => {
    const m = mesh(1, 100);
    const raw = 8 + 30 * 8 + m.vertices.byteLength + m.indices.byteLength + 300;
    expect(packedSize([m])).toBe(raw - m.indices.byteLength / 2);
  });

  it('packs to exactly the size it announces', () => {
    const meshes = [mesh(1, 3), mesh(2, 4), mesh(3, 70000)];
    expect(packMeshes(meshes).byteLength).toBe(packedSize(meshes));
  });

  it('packs an empty batch', () => {
    expect(unpackMeshes(packMeshes([]))).toEqual([]);
  });

  it('refuses a buffer that is not a part, or is cut short, rather than return wrong geometry', () => {
    expect(() => unpackMeshes(new ArrayBuffer(4))).toThrow();
    expect(() => unpackMeshes(new Uint32Array([1, 2, 3]).buffer)).toThrow(/not a packed part/);
    const whole = packMeshes([mesh(1, 10)]);
    expect(() => unpackMeshes(whole.slice(0, whole.byteLength - 8))).toThrow(/truncated/);
  });
});
