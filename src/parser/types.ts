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

export interface ParsedMesh {
  expressID: number;
  vertices: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  transform: number[];
  color: { r: number; g: number; b: number; a: number };
}

export interface ParsedModel {
  /** App-side UUID for the model. */
  id: string;
  meshes: ParsedMesh[];
}

/**
 * Progress of a streamed parse, reported alongside each `batch` message.
 * Counted in products (≈ IFC elements with geometry), not meshes — one
 * product can yield several geometry meshes. `total` is known up front,
 * after web-ifc's `StreamAllMeshes` callback has visited every product,
 * so the count is determinate from the first batch onward.
 */
export interface StreamProgress {
  /** Products whose geometry has been delivered so far. */
  loaded: number;
  /** Total products with geometry in the model. */
  total: number;
}
