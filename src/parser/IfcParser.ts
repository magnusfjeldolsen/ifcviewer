import * as WebIFC from 'web-ifc';
import { FrameYielder } from '../utils/frameYield';

export interface ParsedMesh {
  expressID: number;
  vertices: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  transform: number[];
  color: { r: number; g: number; b: number; a: number };
}

export interface ParsedModel {
  id: string;
  modelID: number;
  meshes: ParsedMesh[];
}

/**
 * Progress of a streamed parse, reported to `parseStreaming`'s `onBatch`.
 * Counted in products (≈ IFC elements with geometry), not meshes — one
 * product can yield several geometry meshes. `total` is known up front,
 * after the ID-collection pass, so the count is determinate from the
 * first batch.
 */
export interface StreamProgress {
  /** Products whose geometry has been delivered so far. */
  loaded: number;
  /** Total products with geometry in the model. */
  total: number;
}

/**
 * Product-ID batch size for `parseStreaming`. Each batch is one synchronous
 * `StreamMeshes` call and one `onBatch` callback. Kept small so progress is
 * reported at a fine granularity; the actual event-loop yields are
 * time-boxed by `FrameYielder`, independent of batch size.
 */
const STREAM_BATCH_SIZE = 50;

export class IfcParser {
  // Public so App can route the web-ifc modelID through the property repository.
  // Kept open after parse; App owns CloseModel on remove / reset / dispose.
  api: WebIFC.IfcAPI | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    this.api = new WebIFC.IfcAPI();
    // WASM files are in public/ — Vite serves them at BASE_URL in both dev and prod
    this.api.SetWasmPath(import.meta.env.BASE_URL, false);
    await this.api.Init();
    this.initialized = true;
  }

  async parse(buffer: ArrayBuffer, id: string): Promise<ParsedModel> {
    if (!this.api || !this.initialized) {
      throw new Error('IfcParser not initialized. Call init() first.');
    }

    const modelID = this.api.OpenModel(new Uint8Array(buffer));
    const meshes: ParsedMesh[] = [];
    this.api.StreamAllMeshes(modelID, (flatMesh: WebIFC.FlatMesh) => {
      this.extractFlatMesh(flatMesh, modelID, meshes);
    });

    // NOTE: model is intentionally kept open after parse.
    // The Element Properties Inspector (Phase 1+) needs the web-ifc heap
    // for property queries. Lifetime is now owned by App: CloseModel is
    // called from App.removeModel, App.resetView, and App.dispose.

    return { id, modelID, meshes };
  }

  /**
   * Progressive variant of `parse`. Geometry is delivered in batches via
   * `onBatch` so the caller can fill the scene incrementally instead of
   * showing nothing until the whole model is parsed.
   *
   * How it works (verified against web-ifc 0.0.77 — see the parse-streaming
   * spike): web-ifc's streamed geometry is only valid *inside* a stream
   * callback, and `StreamAllMeshes` is a single monolithic call that can't
   * yield. So we run it once cheaply just to collect the product
   * `expressID`s (no `GetGeometry`), then re-stream those IDs in batches
   * via `StreamMeshes` — extracting geometry inside that callback — and
   * yield to the event loop between batches so the browser can paint.
   *
   * `StreamMeshes` over the exact product-ID set reproduces the same
   * meshes as `StreamAllMeshes`; feeding it arbitrary IDs over-produces
   * (it would also stream openings, mapped items, sub-parts).
   *
   * Returns the full `ParsedModel` at the end, same as `parse`, so callers
   * that also need the complete mesh list (e.g. the geometry cache) work
   * unchanged.
   *
   * `onBatch` receives each batch of meshes plus a `StreamProgress` with a
   * determinate `loaded / total` product count.
   */
  async parseStreaming(
    buffer: ArrayBuffer,
    id: string,
    onBatch: (meshes: ParsedMesh[], progress: StreamProgress) => void,
  ): Promise<ParsedModel> {
    if (!this.api || !this.initialized) {
      throw new Error('IfcParser not initialized. Call init() first.');
    }
    const api = this.api;
    const modelID = api.OpenModel(new Uint8Array(buffer));

    // Pass 1 — collect product expressIDs only (cheap: no GetGeometry).
    const productIds: number[] = [];
    api.StreamAllMeshes(modelID, (flatMesh: WebIFC.FlatMesh) => {
      productIds.push(flatMesh.expressID);
    });

    // Pass 2 — re-stream the IDs in batches, extracting geometry inside
    // the callback. The yield is time-boxed (see FrameYielder): the loop
    // runs flat-out in ~frame-sized bursts and only cedes the main thread
    // when the budget is spent, so the scene paints progressively without
    // paying a yield + re-render on every single batch.
    const all: ParsedMesh[] = [];
    const yielder = new FrameYielder();
    const total = productIds.length;
    let loaded = 0;
    for (let i = 0; i < productIds.length; i += STREAM_BATCH_SIZE) {
      const batchIds = productIds.slice(i, i + STREAM_BATCH_SIZE);
      const batch: ParsedMesh[] = [];
      api.StreamMeshes(modelID, batchIds, (flatMesh: WebIFC.FlatMesh) => {
        this.extractFlatMesh(flatMesh, modelID, batch);
      });
      for (const m of batch) all.push(m);
      // Every productId came from StreamAllMeshes, so each has geometry —
      // one batch processes exactly batchIds.length products.
      loaded += batchIds.length;
      if (batch.length > 0) onBatch(batch, { loaded, total });
      await yielder.yieldIfNeeded();
    }

    // Model kept open after parse — see the note in `parse`.
    return { id, modelID, meshes: all };
  }

  /**
   * Extract every `PlacedGeometry` of one `FlatMesh` into `ParsedMesh`
   * records appended to `sink`. Shared by `parse` (StreamAllMeshes) and
   * `parseStreaming` (StreamMeshes). Must run inside a stream callback —
   * web-ifc geometry is only valid there.
   */
  private extractFlatMesh(
    flatMesh: WebIFC.FlatMesh,
    modelID: number,
    sink: ParsedMesh[],
  ): void {
    for (let i = 0; i < flatMesh.geometries.size(); i++) {
      const placedGeom = flatMesh.geometries.get(i);
      const geom = this.api!.GetGeometry(modelID, placedGeom.geometryExpressID);

      const verts = this.api!.GetVertexArray(
        geom.GetVertexData(),
        geom.GetVertexDataSize(),
      );
      const idxs = this.api!.GetIndexArray(
        geom.GetIndexData(),
        geom.GetIndexDataSize(),
      );

      // Extract vertices (position only, stride of 6: x,y,z,nx,ny,nz)
      const positions = new Float32Array((verts.length / 6) * 3);
      const normals = new Float32Array((verts.length / 6) * 3);
      for (let j = 0; j < verts.length / 6; j++) {
        positions[j * 3] = verts[j * 6];
        positions[j * 3 + 1] = verts[j * 6 + 1];
        positions[j * 3 + 2] = verts[j * 6 + 2];
        normals[j * 3] = verts[j * 6 + 3];
        normals[j * 3 + 1] = verts[j * 6 + 4];
        normals[j * 3 + 2] = verts[j * 6 + 5];
      }

      const color = placedGeom.color;

      sink.push({
        expressID: flatMesh.expressID,
        vertices: positions,
        normals,
        indices: new Uint32Array(idxs),
        transform: Array.from(placedGeom.flatTransformation),
        color: { r: color.x, g: color.y, b: color.z, a: color.w },
      });

      geom.delete();
    }
    // Free the inner Vector<PlacedGeometry> in WASM heap. `flatMesh` itself
    // is a plain JS object (no `.delete` despite the d.ts), but
    // `flatMesh.geometries` is an emscripten-bound vector that DOES have
    // `.delete` and leaks its heap allocation if not freed. Cast through
    // unknown — the d.ts for Vector<T> omits `.delete`.
    (flatMesh.geometries as unknown as { delete(): void }).delete();
  }

  /**
   * Open a model in web-ifc without streaming geometry. Used by the
   * geometry-cache fast-restore path: scene is already up from cached
   * meshes, we just need web-ifc's STEP graph populated so the property
   * inspector can answer queries. Skipping StreamAllMeshes saves the bulk
   * of the parse time on large models.
   *
   * Caller owns CloseModel via the same hooks as parse() (App.removeModel,
   * App.resetView, App.dispose).
   */
  async openForProperties(buffer: ArrayBuffer): Promise<number> {
    if (!this.api || !this.initialized) {
      throw new Error('IfcParser not initialized. Call init() first.');
    }
    const data = new Uint8Array(buffer);
    return this.api.OpenModel(data);
  }

  dispose(): void {
    if (this.api) {
      this.api.Dispose();
      this.api = null;
      this.initialized = false;
    }
  }
}
