/**
 * Shared parse data shapes — used by both the main thread and the IFC
 * worker. Kept in their own module (not on `IfcParser`, which was deleted
 * by `web-worker-parse`) so the worker can import the types without
 * pulling in any main-thread or DOM dependency.
 *
 * `ParsedMesh`'s typed arrays are transfer-friendly: their backing
 * `ArrayBuffer`s cross the worker boundary zero-copy via `postMessage`
 * Transferables.
 */

import type { WorkerTimings } from '../core/LoadTimeline';
import type { CacheWriteReport } from '../services/geometryParts';

export interface ParsedMesh {
  expressID: number;
  vertices: Float32Array;
  /**
   * 16-bit when every vertex of the piece fits, as the worker sends them: a
   * piece's indices are half the size, and so is the garbage they become on
   * the main thread once appended.
   */
  indices: Uint32Array | Uint16Array;
  /**
   * Unit normals, or as signed bytes (×127) as the worker sends them — the
   * resolution they are drawn at — a quarter the size of floats. Readers
   * normalise either.
   */
  normals: Float32Array | Int8Array;
  transform: number[];
  color: { r: number; g: number; b: number; a: number };
  /**
   * Bounding box of `vertices`, before `transform`. Computed by the worker in
   * the loop that already visits every vertex, so the main thread can size
   * the view without walking them again. Optional: geometry cached before it
   * existed has none, and readers fall back to the vertices.
   */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

export interface ParsedModel {
  /** App-side UUID for the model. */
  id: string;
  meshes: ParsedMesh[];
}

/**
 * A finished streamed parse. The meshes went to the batch callback as they
 * arrived and are not gathered here: holding every one until the end doubled
 * the memory of a large load, next to the copy the renderer already made.
 */
export interface StreamedModel {
  id: string;
  meshCount: number;
  /** Where the worker's time went; absent if the worker did not report it. */
  timings?: WorkerTimings;
  /** With a cache key: resolves once the workers' cache parts are stored (or failed). */
  cache?: Promise<CacheWriteReport>;
}

/**
 * Progress of a streamed parse, reported alongside each `batch` message.
 * Counted in products (≈ IFC elements with geometry), not meshes — one
 * product can yield several geometry meshes. `total` is known from the first
 * batch, read from the model's type index rather than by visiting every
 * product, so it is an upper bound: products without a body are counted but
 * deliver nothing. The last batch's `loaded` is the exact count.
 */
export interface StreamProgress {
  /** Products whose geometry has been delivered so far. */
  loaded: number;
  /** Products listed for streaming; `loaded` ends at or a little below it. */
  total: number;
}
