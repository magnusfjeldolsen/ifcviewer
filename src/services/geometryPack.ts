/**
 * One batch of parsed meshes as one `ArrayBuffer`, for the geometry cache.
 *
 * The cache stores a model as many such parts, written by the workers as the
 * batches stream out and read back one at a time on reload. A single buffer
 * per part is what makes both ends cheap: IndexedDB clones it as one block,
 * and reading it back costs no per-mesh objects beyond the views.
 *
 * Layout (little-endian, every section 4-byte aligned):
 *
 *   u32 magic 'IFG2'   u32 meshCount
 *   f64 × META_FLOATS per mesh: expressID, vertexCount, indexCount,
 *       r, g, b, a, transform[16], hasBounds, min xyz, max xyz
 *   per mesh: f32 positions[vertexCount × 3],
 *             indices[indexCount] as u16 when every vertex fits, else u32
 *             (padded to 4 bytes), i8 normals[vertexCount × 3] (padded to 4)
 *
 * Positions, indices, colours, transforms and bounds come back exactly.
 * Most pieces have fewer than 65,536 vertices, so 16-bit indices cut what
 * the cache stores — and writes and reads — by about a tenth.
 * Normals are stored as signed bytes (×127): the viewer draws them as 8-bit
 * normals anyway, and welding already merged normals at that resolution. A
 * normal read back can differ from the parsed one by about half a degree.
 */

import type { ParsedMesh } from '../parser/types';

const MAGIC = 0x32474649; // 'IFG2'
const META_FLOATS = 3 + 4 + 16 + 1 + 6;
const HEADER_BYTES = 8;

const align4 = (n: number): number => (n + 3) & ~3;

/** Whether a piece's indices are stored as 16-bit: it is decided by its vertex count. */
const shortIndices = (vertexCount: number): boolean => vertexCount <= 0x10000;

const indexBytes = (vertexCount: number, indexCount: number): number =>
  shortIndices(vertexCount) ? align4(indexCount * 2) : indexCount * 4;

/** Bytes `packMeshes` will produce for `meshes`. */
export function packedSize(meshes: readonly ParsedMesh[]): number {
  let bytes = HEADER_BYTES + meshes.length * META_FLOATS * 8;
  for (const m of meshes) {
    bytes += m.vertices.byteLength + indexBytes(m.vertices.length / 3, m.indices.length) + align4(m.vertices.length);
  }
  return bytes;
}

export function packMeshes(meshes: readonly ParsedMesh[]): ArrayBuffer {
  const out = new ArrayBuffer(packedSize(meshes));
  const head = new Uint32Array(out, 0, 2);
  head[0] = MAGIC;
  head[1] = meshes.length;
  const meta = new Float64Array(out, HEADER_BYTES, meshes.length * META_FLOATS);
  let offset = HEADER_BYTES + meshes.length * META_FLOATS * 8;
  meshes.forEach((m, i) => {
    const o = i * META_FLOATS;
    const vertexCount = m.vertices.length / 3;
    meta[o] = m.expressID;
    meta[o + 1] = vertexCount;
    meta[o + 2] = m.indices.length;
    meta[o + 3] = m.color.r;
    meta[o + 4] = m.color.g;
    meta[o + 5] = m.color.b;
    meta[o + 6] = m.color.a;
    for (let k = 0; k < 16; k++) meta[o + 7 + k] = m.transform[k];
    if (m.bounds) {
      meta[o + 23] = 1;
      meta.set(m.bounds.min, o + 24);
      meta.set(m.bounds.max, o + 27);
    }
    new Float32Array(out, offset, m.vertices.length).set(m.vertices);
    offset += m.vertices.byteLength;
    if (shortIndices(vertexCount)) new Uint16Array(out, offset, m.indices.length).set(m.indices);
    else new Uint32Array(out, offset, m.indices.length).set(m.indices);
    offset += indexBytes(vertexCount, m.indices.length);
    const normals = new Int8Array(out, offset, m.normals.length);
    for (let k = 0; k < m.normals.length; k++) normals[k] = Math.round(m.normals[k] * 127);
    offset += align4(m.normals.length);
  });
  return out;
}

/**
 * The meshes in a packed part. Positions are views into `buf` (no copy);
 * 16-bit indices and byte normals are expanded back. Throws on a buffer that is
 * not a packed part, so a corrupt entry is a cache miss, never wrong geometry.
 */
export function unpackMeshes(buf: ArrayBuffer): ParsedMesh[] {
  if (buf.byteLength < HEADER_BYTES) throw new Error('geometry part: too short');
  const head = new Uint32Array(buf, 0, 2);
  if (head[0] !== MAGIC) throw new Error('geometry part: not a packed part');
  const count = head[1];
  const metaBytes = count * META_FLOATS * 8;
  if (HEADER_BYTES + metaBytes > buf.byteLength) throw new Error('geometry part: truncated');
  const meta = new Float64Array(buf, HEADER_BYTES, count * META_FLOATS);
  let offset = HEADER_BYTES + metaBytes;
  const out: ParsedMesh[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * META_FLOATS;
    const vertexCount = meta[o + 1];
    const indexCount = meta[o + 2];
    const need = vertexCount * 12 + indexBytes(vertexCount, indexCount) + align4(vertexCount * 3);
    if (offset + need > buf.byteLength) throw new Error('geometry part: truncated');
    const vertices = new Float32Array(buf, offset, vertexCount * 3);
    offset += vertexCount * 12;
    const indices = shortIndices(vertexCount)
      ? Uint32Array.from(new Uint16Array(buf, offset, indexCount))
      : new Uint32Array(buf, offset, indexCount);
    offset += indexBytes(vertexCount, indexCount);
    const packed = new Int8Array(buf, offset, vertexCount * 3);
    offset += align4(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    for (let k = 0; k < normals.length; k++) normals[k] = packed[k] / 127;
    const mesh: ParsedMesh = {
      expressID: meta[o],
      vertices,
      normals,
      indices,
      color: { r: meta[o + 3], g: meta[o + 4], b: meta[o + 5], a: meta[o + 6] },
      transform: Array.from(meta.subarray(o + 7, o + 23)),
    };
    if (meta[o + 23] === 1) {
      mesh.bounds = {
        min: [meta[o + 24], meta[o + 25], meta[o + 26]],
        max: [meta[o + 27], meta[o + 28], meta[o + 29]],
      };
    }
    out[i] = mesh;
  }
  return out;
}
