/**
 * IFC worker — the single owner of all web-ifc state.
 *
 * Runs in a dedicated module Web Worker (NOT a SharedArrayBuffer / pthread
 * worker — no COOP/COEP headers, no `crossOriginIsolated` required). It
 * holds the one `IfcAPI` instance, every open model, and the app-UUID →
 * numeric-web-ifc-id map. The main thread never sees a numeric model id.
 *
 * Responsibilities:
 *  - `parse`        — open a model and stream geometry back in batches.
 *  - `openForProps` — open a model for property queries only (cache-restore).
 *  - `getProps`     — fetch + normalize one element's properties.
 *  - `disposeModel` — close a model and free its per-model caches.
 *  - `dispose`      — tear down the whole web-ifc instance.
 *
 * Serialization: web-ifc is not thread-safe, and even within this single
 * thread an `await` inside a handler would let the next message interleave.
 * So every request runs through `enqueue` — an explicit promise-chain
 * queue. One request completes fully before the next starts. This replaces
 * both the old `App.parseQueue` and `WebIfcPropertyRepository.enqueue`.
 *
 * Error handling: every failure path posts an `error` reply carrying the
 * request's correlation key (`id` or `reqId`). A handler that threw without
 * posting `error` would hang a main-thread `await` forever.
 */

import * as WebIFC from 'web-ifc';

import { fetchElementProperties } from '../inspector/repository/fetchElementProperties';
import { computeUnitTable } from '../inspector/repository/unitTable';
import { buildUnitTable, type UnitTable } from '../inspector/format';
import {
  intersectSeed,
  intersectStep,
  intersectFinalize,
  type RunningIntersection,
} from '../inspector/intersection';
import type { ElementProperties } from '../inspector/types';
import type { FromWorker, ToWorker } from './ifcMessages';
import type { ParsedMesh, StreamProgress } from './types';

/**
 * Product-ID batch size for `parse`. Each batch is one `batch` message.
 * Kept moderate so the main thread builds geometry in reasonable chunks
 * without paying a `postMessage` round-trip per product. The worker never
 * yields, so this only governs message granularity, not parse speed.
 */
const STREAM_BATCH_SIZE = 200;

// --- web-ifc instance + per-model state -------------------------------------

let api: WebIFC.IfcAPI | null = null;
let initPromise: Promise<WebIFC.IfcAPI> | null = null;

/** App UUID → numeric web-ifc model id. The worker is the sole owner. */
const modelIds = new Map<string, number>();
/** App UUID → per-model unit table (lazily computed on first property query). */
const unitTables = new Map<string, UnitTable>();

/**
 * Serial request queue. Each message handler is appended to this chain so
 * one request fully settles before the next begins — web-ifc is single-
 * threaded and not re-entrant.
 */
let queue: Promise<void> = Promise.resolve();

function enqueue(work: () => Promise<void>): void {
  queue = queue.then(work, work);
}

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

/** Lazily create and initialize the `IfcAPI`. Single-threaded build auto-selected. */
async function getApi(): Promise<WebIFC.IfcAPI> {
  if (api) return api;
  if (!initPromise) {
    initPromise = (async () => {
      const created = new WebIFC.IfcAPI();
      // The `.wasm` ships in the bundle alongside the worker chunk; Vite
      // serves it under BASE_URL in both dev and prod. `crossOriginIsolated`
      // is false in a plain worker, so Init() picks the single-threaded build.
      created.SetWasmPath(import.meta.env.BASE_URL, false);
      await created.Init();
      api = created;
      return created;
    })();
  }
  return initPromise;
}

// --- geometry extraction -----------------------------------------------------

/**
 * Extract every `PlacedGeometry` of one `FlatMesh` into `ParsedMesh`
 * records appended to `sink`. Must run inside a `StreamAllMeshes`
 * callback — web-ifc geometry is only valid there.
 */
function extractFlatMesh(
  ifc: WebIFC.IfcAPI,
  flatMesh: WebIFC.FlatMesh,
  modelID: number,
  sink: ParsedMesh[],
): void {
  for (let i = 0; i < flatMesh.geometries.size(); i++) {
    const placedGeom = flatMesh.geometries.get(i);
    const geom = ifc.GetGeometry(modelID, placedGeom.geometryExpressID);

    const verts = ifc.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
    const idxs = ifc.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());

    // Extract vertices (position only, stride of 6: x,y,z,nx,ny,nz).
    const vertexCount = verts.length / 6;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    for (let j = 0; j < vertexCount; j++) {
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
  // Free the inner Vector<PlacedGeometry> in the WASM heap. `flatMesh`
  // itself is a plain JS object (no `.delete` despite the d.ts), but
  // `flatMesh.geometries` is an emscripten-bound vector that DOES have
  // `.delete` and leaks its heap allocation if not freed. Cast through
  // unknown — the d.ts for Vector<T> omits `.delete`.
  (flatMesh.geometries as unknown as { delete(): void }).delete();
}

/** Collect the typed-array buffers in a mesh batch for zero-copy transfer. */
function batchTransferables(meshes: ParsedMesh[]): Transferable[] {
  const transfer: Transferable[] = [];
  for (const m of meshes) {
    transfer.push(m.vertices.buffer, m.normals.buffer, m.indices.buffer);
  }
  return transfer;
}

// --- handlers ----------------------------------------------------------------

/**
 * Parse a model: open it, then stream geometry. The worker is not the UI
 * thread, so it never has to yield — it runs ONE `StreamAllMeshes` pass,
 * extracts geometry inside the callback, and posts `batch` messages as
 * products accumulate. A single pass is faster than the reverted
 * main-thread two-pass streaming.
 */
async function handleParse(id: string, buffer: ArrayBuffer): Promise<void> {
  const ifc = await getApi();
  const modelID = ifc.OpenModel(new Uint8Array(buffer));
  modelIds.set(id, modelID);

  // Pass 1 — count products so `total` is determinate from the first batch.
  // Cheap: no GetGeometry, just visits each FlatMesh.
  let total = 0;
  ifc.StreamAllMeshes(modelID, () => {
    total++;
  });

  // Pass 2 — stream geometry, flushing a batch every STREAM_BATCH_SIZE
  // products. `StreamAllMeshes` cannot be paused, so we accumulate inside
  // the callback and post whenever the batch fills.
  let pending: ParsedMesh[] = [];
  let loaded = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    const meshes = pending;
    pending = [];
    const progress: StreamProgress = { loaded, total };
    post({ type: 'batch', id, meshes, progress }, batchTransferables(meshes));
  };

  ifc.StreamAllMeshes(modelID, (flatMesh: WebIFC.FlatMesh) => {
    extractFlatMesh(ifc, flatMesh, modelID, pending);
    loaded++;
    if (loaded % STREAM_BATCH_SIZE === 0) flush();
  });
  flush();

  // Model kept open — property queries need the STEP graph. Closed by
  // `disposeModel` / `dispose`.
  post({ type: 'parsed', id });
}

/**
 * Open a model for property queries only — no geometry streamed. The
 * geometry-cache fast-restore path uses this: the scene is already up
 * from cached meshes, the worker just needs the model open so later
 * `getProps` messages resolve.
 */
async function handleOpenForProps(id: string, buffer: ArrayBuffer): Promise<void> {
  const ifc = await getApi();
  const modelID = ifc.OpenModel(new Uint8Array(buffer));
  modelIds.set(id, modelID);
  post({ type: 'parsed', id });
}

/**
 * Resolve the per-model unit table, computing and caching it on first use.
 * Extracted so `getOne` and `readProps` share the same lazy-cache path.
 */
async function ensureUnitTable(
  ifc: WebIFC.IfcAPI,
  id: string,
  modelID: number,
): Promise<UnitTable> {
  const cached = unitTables.get(id);
  if (cached) return cached;
  let unitTable: UnitTable;
  try {
    unitTable = await computeUnitTable(
      ifc as unknown as Parameters<typeof computeUnitTable>[0],
      modelID,
    );
  } catch {
    unitTable = buildUnitTable([]);
  }
  unitTables.set(id, unitTable);
  return unitTable;
}

/**
 * Fetch + normalize one element's properties. Single normalization path
 * shared by `getProps` and `intersect` — the worker has one and only one
 * way of producing an `ElementProperties` from web-ifc data.
 */
async function getOne(
  ifc: WebIFC.IfcAPI,
  modelID: number,
  id: string,
  expressId: number,
  unitTable: UnitTable,
): Promise<ElementProperties> {
  return fetchElementProperties(
    ifc as unknown as Parameters<typeof fetchElementProperties>[0],
    modelID,
    id,
    expressId,
    unitTable,
  );
}

/** Fetch + normalize one element's properties and post them back. */
async function handleGetProps(reqId: number, id: string, expressId: number): Promise<void> {
  const ifc = await getApi();
  const modelID = modelIds.get(id);
  if (modelID === undefined) {
    throw new Error(`ifcWorker: unknown modelId "${id}"`);
  }
  const unitTable = await ensureUnitTable(ifc, id, modelID);
  const props = await getOne(ifc, modelID, id, expressId, unitTable);
  post({ type: 'props', reqId, props });
}

// ----------------------------------------------------------------------------
// Phase 1 of dev/plans/handoff-bulk-property-access.md — bulk property
// reduction in the worker. The worker reads each expressId via `getOne` and
// folds it into a running intersection, ever holding at most ONE element's
// props plus the running fold state. Memory is O(1) in N.
// ----------------------------------------------------------------------------

/** ExpressId batch size for `readProps`. The only remaining tuning knob. */
const INTERSECT_CHUNK = 200;

/**
 * Minimum interval (ms) between successive `progress` posts. Keeps the
 * postMessage cost negligible at high throughput while still feeling live
 * (~10/sec). Per-chunk granularity also bounds it from above.
 */
const PROGRESS_MIN_INTERVAL_MS = 100;

/**
 * Fold the properties of `expressIds` into a single synthetic
 * `ElementProperties` and post `intersection`. Posts throttled `progress`
 * messages between chunks.
 *
 * Phase 1: NO cancel handling. Single-bulk-op-at-a-time is acceptable for
 * validating the trade-offs (drill-down latency, fold semantics) before
 * Phase 2 layers in `cancel`, the macrotask yield's second purpose.
 *
 * We DO yield a macrotask between chunks so the main thread sees `progress`
 * posts in real time (postMessage delivery is task-bound, not microtask-
 * bound). The worker's serial queue still gates other messages behind this
 * job — that's the documented trade-off in the handoff doc.
 */
async function handleIntersect(
  reqId: number,
  id: string,
  expressIds: number[],
): Promise<void> {
  const ifc = await getApi();
  const modelID = modelIds.get(id);
  if (modelID === undefined) {
    throw new Error(`ifcWorker: unknown modelId "${id}"`);
  }
  const total = expressIds.length;

  // Empty selection — emit an empty synthetic and bail. The proxy avoids
  // this path in practice (a 0-id model is dropped before posting), but
  // we keep the guard so the worker never crashes on a degenerate request.
  if (total === 0) {
    post({ type: 'progress', reqId, done: 0, total: 0 });
    post({ type: 'intersection', reqId, props: makeEmpty(id) });
    return;
  }

  const unitTable = await ensureUnitTable(ifc, id, modelID);

  let running: RunningIntersection | null = null;
  let done = 0;
  let lastProgressAt = 0;

  for (let start = 0; start < total; start += INTERSECT_CHUNK) {
    const end = Math.min(start + INTERSECT_CHUNK, total);
    for (let i = start; i < end; i++) {
      const props = await getOne(ifc, modelID, id, expressIds[i], unitTable);
      if (running === null) {
        running = intersectSeed(props);
      } else {
        running = intersectStep(running, props);
      }
      done++;
    }
    // Throttled progress: post per-chunk, but never more often than
    // ~PROGRESS_MIN_INTERVAL_MS apart. Force the final post (done === total)
    // through the throttle so the UI sees the terminal value.
    const now = Date.now();
    if (done === total || now - lastProgressAt >= PROGRESS_MIN_INTERVAL_MS) {
      post({ type: 'progress', reqId, done, total });
      lastProgressAt = now;
    }
    // Macrotask yield — lets queued messages (notably `progress` delivery
    // to main) flow before we resume. Also the hook Phase 2 will use to
    // observe a `cancel` flag.
    if (end < total) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  // running cannot be null here — total > 0 means at least one getOne ran.
  const props = intersectFinalize(running as RunningIntersection);
  post({ type: 'intersection', reqId, props });
}

/** Empty synthetic ElementProperties used for the `expressIds.length === 0` case. */
function makeEmpty(modelId: string): ElementProperties {
  return {
    identity: { modelId, expressId: 0, ifcClass: '(mixed)', ifcTypeCode: 0 },
    direct: [],
    psets: [],
    qtos: [],
    materials: [],
    flat: [],
    fetchedAt: Date.now(),
  };
}

/** Close a model in web-ifc and free its per-model caches. */
function handleDisposeModel(id: string): void {
  const modelID = modelIds.get(id);
  modelIds.delete(id);
  unitTables.delete(id);
  if (modelID !== undefined && api) {
    try {
      api.CloseModel(modelID);
    } catch {
      // web-ifc may already be down — nothing to recover.
    }
  }
}

/** Tear down the whole web-ifc instance. */
function handleDispose(): void {
  if (api) {
    try {
      api.Dispose();
    } catch {
      // ignore — best-effort teardown
    }
  }
  api = null;
  initPromise = null;
  modelIds.clear();
  unitTables.clear();
}

// --- message dispatch --------------------------------------------------------

self.onmessage = (event: MessageEvent<ToWorker>): void => {
  const msg = event.data;
  switch (msg.type) {
    case 'parse':
      enqueue(async () => {
        try {
          await handleParse(msg.id, msg.buffer);
        } catch (err) {
          post({ type: 'error', id: msg.id, message: errorMessage(err) });
        }
      });
      break;

    case 'openForProps':
      enqueue(async () => {
        try {
          await handleOpenForProps(msg.id, msg.buffer);
        } catch (err) {
          post({ type: 'error', id: msg.id, message: errorMessage(err) });
        }
      });
      break;

    case 'getProps':
      enqueue(async () => {
        try {
          await handleGetProps(msg.reqId, msg.id, msg.expressId);
        } catch (err) {
          post({ type: 'error', reqId: msg.reqId, message: errorMessage(err) });
        }
      });
      break;

    case 'intersect':
      enqueue(async () => {
        try {
          await handleIntersect(msg.reqId, msg.id, msg.expressIds);
        } catch (err) {
          post({ type: 'error', reqId: msg.reqId, message: errorMessage(err) });
        }
      });
      break;

    case 'disposeModel':
      enqueue(async () => {
        handleDisposeModel(msg.id);
      });
      break;

    case 'dispose':
      enqueue(async () => {
        handleDispose();
      });
      break;
  }
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown worker error';
}
