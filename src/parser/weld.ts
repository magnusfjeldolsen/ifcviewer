/**
 * The renderer stores normals as signed bytes (`ModelBatch`), so two normals
 * that round to the same byte triple are drawn identically.
 */
export const WELD_NORMAL_STEPS = 127;

/**
 * Merge vertices that share a position (bit for bit) and a normal, and
 * rewrite the index to share them.
 *
 * web-ifc emits about 2.7 vertices per triangle on a real model: coplanar
 * triangles each carry their own copy of a corner, because their computed
 * normals differ in the last few bits. The GPU only reuses a vertex's shading
 * when the index points at the same vertex again, so the vertex stage — the
 * bottleneck once draw calls are batched — did far more work than needed.
 *
 * With `normalSteps` > 0, normals are compared after rounding each component
 * to that many steps, which is how `ModelBatch` stores them anyway; 0 compares
 * them bit for bit. Positions are always compared exactly, and a hard edge
 * keeps its two normals because they differ by far more than a step. The kept
 * vertex is the first occurrence, unchanged.
 *
 * Measured on a 340 MB model: 19.6M → 15.8M vertices, GPU frame 36 → 32.5 ms
 * on an integrated GPU.
 *
 * Returns the inputs untouched when there is nothing to merge.
 */
export function weldVertices(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  normalSteps = 0,
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const n = positions.length / 3;
  if (n < 4 || normals.length !== positions.length) return { positions, normals, indices };

  // Compare bit patterns, not float values: exact, and no -0 / NaN surprises.
  const p = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  let q: Uint32Array | Int32Array;
  if (normalSteps > 0) {
    q = new Int32Array(normals.length);
    for (let i = 0; i < normals.length; i++) q[i] = Math.round(normals[i] * normalSteps);
  } else {
    q = new Uint32Array(normals.buffer, normals.byteOffset, normals.length);
  }

  let size = 1;
  while (size < n * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const remap = new Uint32Array(n);
  /** First occurrence (original index) of each kept vertex. */
  const kept = new Uint32Array(n);
  let unique = 0;

  for (let i = 0; i < n; i++) {
    const o = i * 3;
    let h = Math.imul(p[o] ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ p[o + 1], 0xc2b2ae35);
    h = Math.imul(h ^ p[o + 2], 0x27d4eb2f);
    h = Math.imul(h ^ q[o], 0x165667b1);
    h = Math.imul(h ^ q[o + 1], 0x9e3779b1);
    h = Math.imul(h ^ q[o + 2], 0x85ebca77);
    h ^= h >>> 15;
    let slot = h & mask;
    for (;;) {
      const entry = table[slot];
      if (entry < 0) {
        table[slot] = unique;
        kept[unique] = i;
        remap[i] = unique++;
        break;
      }
      const j = kept[entry] * 3;
      if (
        p[j] === p[o] && p[j + 1] === p[o + 1] && p[j + 2] === p[o + 2] &&
        q[j] === q[o] && q[j + 1] === q[o + 1] && q[j + 2] === q[o + 2]
      ) {
        remap[i] = entry;
        break;
      }
      slot = (slot + 1) & mask;
    }
  }

  if (unique === n) return { positions, normals, indices };

  const outP = new Float32Array(unique * 3);
  const outN = new Float32Array(unique * 3);
  for (let k = 0; k < unique; k++) {
    const s = kept[k] * 3;
    outP[k * 3] = positions[s];
    outP[k * 3 + 1] = positions[s + 1];
    outP[k * 3 + 2] = positions[s + 2];
    outN[k * 3] = normals[s];
    outN[k * 3 + 1] = normals[s + 1];
    outN[k * 3 + 2] = normals[s + 2];
  }
  const outI = new Uint32Array(indices.length);
  for (let k = 0; k < indices.length; k++) outI[k] = remap[indices[k]];
  return { positions: outP, normals: outN, indices: outI };
}
