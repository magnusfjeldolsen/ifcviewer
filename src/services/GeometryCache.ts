/**
 * Cache parsed-IFC mesh buffers in IndexedDB, keyed by the SHA-256 of the
 * source .ifc buffer. On a cache hit we hydrate the scene directly from
 * the stored Float32Array / Uint32Array buffers and skip the expensive
 * web-ifc parse — the ~60 s wait on a 191 MB model collapses to < 2 s.
 *
 * The web-ifc model itself is still needed for property queries; the App
 * kicks off a background re-parse after restoring from cache. This module
 * is concerned only with the geometry side.
 *
 * Storage layout: one IDB record per source .ifc file. Records are evicted
 * oldest-first when their combined size exceeds GEOMETRY_CACHE_CAP_BYTES.
 * Schema-version mismatches are treated as cache misses.
 */

import type { ParsedMesh } from '../parser/IfcParser';
import type { SessionStore } from './SessionStore';

/**
 * Bump when the on-disk shape of CachedMesh changes meaning. Existing
 * entries are treated as misses and silently re-populated on next parse.
 *
 * Reasons to bump:
 *   - Add or remove a CachedMesh field.
 *   - Change units or interpretation of any field.
 *   - Switch the typed-array representation (e.g. Uint16 → Uint32 indices).
 */
export const CACHE_SCHEMA_VERSION = 1;

/** Max bytes across the entire geometry-cache store before eviction kicks in. */
export const GEOMETRY_CACHE_CAP_BYTES = 500 * 1024 * 1024;

export interface CachedMesh {
  expressID: number;
  vertices: ArrayBuffer; // Float32Array.buffer (positions, xyz stride 3)
  normals: ArrayBuffer;  // Float32Array.buffer (normals, xyz stride 3)
  indices: ArrayBuffer;  // Uint32Array.buffer
  color: { r: number; g: number; b: number; a: number };
  transform: number[];   // length 16 (Matrix4 column-major)
}

export interface CachedGeometryRecord {
  hash: string;
  cachedAt: number;
  schemaVersion: number;
  /** Pre-computed at save time so eviction doesn't need to walk meshes. */
  sizeBytes: number;
  meshes: CachedMesh[];
}

/** Convert in-memory ParsedMesh[] to the serializable CachedMesh[] shape. */
export function serializeMeshes(parsed: ParsedMesh[]): CachedMesh[] {
  const out: CachedMesh[] = new Array(parsed.length);
  for (let i = 0; i < parsed.length; i++) {
    const m = parsed[i];
    out[i] = {
      expressID: m.expressID,
      vertices: copyView(m.vertices),
      normals: copyView(m.normals),
      indices: copyView(m.indices),
      color: { r: m.color.r, g: m.color.g, b: m.color.b, a: m.color.a },
      transform: m.transform.slice(),
    };
  }
  return out;
}

/** Convert CachedMesh[] back to ParsedMesh[]. Reconstructs typed-array views. */
export function deserializeMeshes(cached: CachedMesh[]): ParsedMesh[] {
  const out: ParsedMesh[] = new Array(cached.length);
  for (let i = 0; i < cached.length; i++) {
    const c = cached[i];
    out[i] = {
      expressID: c.expressID,
      vertices: new Float32Array(c.vertices),
      normals: new Float32Array(c.normals),
      indices: new Uint32Array(c.indices),
      color: { r: c.color.r, g: c.color.g, b: c.color.b, a: c.color.a },
      transform: c.transform.slice(),
    };
  }
  return out;
}

/** Sum the byte size of a record's mesh buffers + small per-mesh overhead. */
export function computeRecordSize(meshes: CachedMesh[]): number {
  let total = 0;
  for (const m of meshes) {
    total += m.vertices.byteLength + m.normals.byteLength + m.indices.byteLength;
    // Object overhead per mesh (color + transform + expressID): rough estimate.
    total += 168;
  }
  return total;
}

/** SHA-256 of an ArrayBuffer, returned as lowercase hex. */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Thin wrapper around SessionStore's geometry-cache IDB operations.
 * Owns serialization, schema-version checks, and the LRU eviction policy.
 */
export class GeometryCache {
  constructor(
    private store: SessionStore,
    private capBytes: number = GEOMETRY_CACHE_CAP_BYTES,
  ) {}

  /**
   * Save parsed meshes under `hash`. Evicts oldest entries if the new
   * total would exceed the cap. Fire-and-forget: failures are logged and
   * swallowed — a missed cache write is never user-visible.
   */
  async save(hash: string, parsed: ParsedMesh[]): Promise<void> {
    try {
      const meshes = serializeMeshes(parsed);
      const record: CachedGeometryRecord = {
        hash,
        cachedAt: Date.now(),
        schemaVersion: CACHE_SCHEMA_VERSION,
        sizeBytes: computeRecordSize(meshes),
        meshes,
      };
      await this.store.saveCachedGeometry(record);
      await this.evictOldestUntilUnderCap();
    } catch (err) {
      console.warn('GeometryCache: save failed', err);
    }
  }

  /**
   * Load meshes by hash. Returns null on miss, schema-version mismatch,
   * or any IDB error (which is treated as a miss — the caller falls back
   * to a full parse).
   */
  async load(hash: string): Promise<ParsedMesh[] | null> {
    try {
      const record = await this.store.loadCachedGeometry(hash);
      if (!record) return null;
      if (record.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
      // StoredCachedGeometry.meshes is typed `unknown[]` so SessionStore stays
      // free of typed-array knowledge. Trust the schema-version gate above:
      // any record we accept here was produced by `serializeMeshes`.
      return deserializeMeshes(record.meshes as CachedMesh[]);
    } catch (err) {
      console.warn('GeometryCache: load failed', err);
      return null;
    }
  }

  /**
   * Remove the oldest entries until total size is under the cap.
   * Approximate LRU by `cachedAt` — adequate for a handful of large
   * records; we don't need true LRU.
   */
  async evictOldestUntilUnderCap(): Promise<void> {
    const meta = await this.store.getAllCachedGeometryMeta();
    let total = 0;
    for (const m of meta) total += m.sizeBytes;
    if (total <= this.capBytes) return;

    const sorted = meta.slice().sort((a, b) => a.cachedAt - b.cachedAt);
    for (const m of sorted) {
      if (total <= this.capBytes) break;
      await this.store.removeCachedGeometry(m.hash);
      total -= m.sizeBytes;
      console.info(`GeometryCache: evicted ${m.hash.slice(0, 8)}… (${(m.sizeBytes / 1e6).toFixed(1)} MB)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Detach a typed-array view into a fresh ArrayBuffer copy. Typed arrays
 * can be views over a larger buffer (or even a SharedArrayBuffer), so we
 * can't just hand out `view.buffer`. Allocating a fresh ArrayBuffer and
 * copying the bytes guarantees the result is an owned, plain ArrayBuffer
 * that IDB can serialize without surprises.
 */
function copyView(view: Float32Array | Uint32Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
  );
  return out;
}
