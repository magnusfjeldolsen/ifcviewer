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
 *  - `intersect`    — fold N elements' properties into one synthetic result.
 *  - `enumerateIds` — list the expressIds of a class (or of every product).
 *  - `findMatching` — run a value-match predicate, reply with ids only.
 *  - `cancel`       — abandon an in-flight bulk job (NOT queued — see below).
 *  - `disposeModel` — close a model and free its per-model caches.
 *  - `dispose`      — tear down the whole web-ifc instance.
 *
 * Serialization: web-ifc is not thread-safe, and even within this single
 * thread an `await` inside a handler would let the next message interleave.
 * So every request runs through `enqueue` — an explicit promise-chain
 * queue. One request completes fully before the next starts. This replaces
 * both the old `App.parseQueue` and `WebIfcPropertyRepository.enqueue`.
 *
 * The one deliberate exception is `cancel`, which is handled synchronously
 * in `onmessage` and never enqueued. Queuing it would be useless: the job
 * it cancels is at the head of the queue, so the cancel could only run
 * after that job had already finished.
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
import { elementMatches, type PropertySelector } from '../inspector/matchValue';
import type { ElementProperties, PropertyValue } from '../inspector/types';
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
// dev/plans/handoff-bulk-property-access.md — bulk property reduction in the
// worker. The worker reads each expressId via `getOne` and folds it into a
// running result, ever holding at most ONE element's props plus the fold
// state. Memory is O(1) in N. Phase 2 adds cancellation, id enumeration and
// the value-match predicate on top of the same `readProps` spine.
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
 * Bulk requests that have been dispatched and not yet settled. A `cancel`
 * for a reqId that isn't here is ignored outright, which is what keeps
 * `cancelled` from growing without bound: nothing can be flagged unless a
 * job is actually running (or queued) under that id.
 */
const pendingBulk = new Set<number>();

/**
 * Bulk requests the main thread has abandoned. Written synchronously by the
 * `cancel` message (outside the queue) and read by the running job at its
 * chunk boundaries.
 */
const cancelled = new Set<number>();

/**
 * Register a bulk reqId as live. Called synchronously at dispatch, NOT when
 * the job starts running: a job sitting in the queue behind a long-running
 * one is exactly the case that most needs to be cancellable, and it isn't
 * "pending" yet by any runtime measure.
 */
function markPending(reqId: number): void {
  pendingBulk.add(reqId);
}

/** Record a cancel request. Only meaningful for a bulk job we know about. */
function markCancelled(reqId: number): void {
  if (pendingBulk.has(reqId)) cancelled.add(reqId);
}

/**
 * Run one bulk job, guaranteeing the bookkeeping is symmetric: the reqId
 * stops being pending and its cancel flag is dropped when the job settles,
 * however it settles. Without the `finally`, a thrown job would leak both.
 */
async function runBulk(reqId: number, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } finally {
    pendingBulk.delete(reqId);
    cancelled.delete(reqId);
  }
}

/**
 * Read `expressIds` in chunks, handing each element's normalized props to
 * `onEach`. The single spine under every bulk primitive — `intersect` and
 * `findMatching` both fold through here, so normalization, chunking,
 * progress and cancellation have exactly one implementation.
 *
 * Returns `true` if the whole list was read, `false` if the job was
 * cancelled part-way (in which case the caller must post nothing — a
 * partial result is never committed).
 *
 * Between chunks it yields a **macrotask** (`setTimeout(0)`), not a
 * microtask: incoming `postMessage`s are delivered as tasks, so a microtask
 * await would never let a `cancel` land. The same yield is what lets
 * `progress` posts reach the main thread in real time.
 *
 * Note the yield does NOT let other *queued* jobs run — they are gated
 * behind this one by the serial queue. That head-of-line blocking is the
 * accepted trade-off documented in the handoff doc; cancellation is what
 * keeps it bounded, since a superseded job stops within one chunk.
 */
async function readProps(
  ifc: WebIFC.IfcAPI,
  modelID: number,
  id: string,
  expressIds: readonly number[],
  reqId: number,
  unitTable: UnitTable,
  onEach: (props: ElementProperties) => void,
): Promise<boolean> {
  const total = expressIds.length;
  let done = 0;
  let lastProgressAt = 0;

  for (let start = 0; start < total; start += INTERSECT_CHUNK) {
    if (cancelled.has(reqId)) return false;

    const end = Math.min(start + INTERSECT_CHUNK, total);
    for (let i = start; i < end; i++) {
      onEach(await getOne(ifc, modelID, id, expressIds[i], unitTable));
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

    if (end < total) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  return !cancelled.has(reqId);
}

/**
 * Fold the properties of `expressIds` into a single synthetic
 * `ElementProperties` and post `intersection`. Holds only the running fold
 * state — O(1) memory in N.
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

  // Empty selection — emit an empty synthetic and bail. The proxy avoids
  // this path in practice (a 0-id model is dropped before posting), but
  // we keep the guard so the worker never crashes on a degenerate request.
  if (expressIds.length === 0) {
    post({ type: 'progress', reqId, done: 0, total: 0 });
    post({ type: 'intersection', reqId, props: makeEmpty(id) });
    return;
  }

  const unitTable = await ensureUnitTable(ifc, id, modelID);

  // Held in a box rather than a bare `let` so the fold state is visibly
  // owned by this call and not re-narrowed by the closure below.
  const acc: { running: RunningIntersection | null } = { running: null };
  const completed = await readProps(
    ifc,
    modelID,
    id,
    expressIds,
    reqId,
    unitTable,
    (props) => {
      acc.running = acc.running === null ? intersectSeed(props) : intersectStep(acc.running, props);
    },
  );

  // Cancelled — post nothing. The proxy has already settled the caller's
  // promise; a late reply would only have to be dropped by its stale guard.
  if (!completed) return;

  // Unreachable: a completed read of a non-empty list ran at least one
  // getOne, which seeds the fold.
  if (acc.running === null) {
    throw new Error('ifcWorker: intersect completed without reading any element');
  }
  post({ type: 'intersection', reqId, props: intersectFinalize(acc.running) });
}

/**
 * Resolve the candidate expressIds for one IFC type, or for every product
 * when `ifcType` is undefined / null.
 *
 * `IFCPRODUCT` with `includeInherited` is the centralized "all products"
 * definition — one supertype code rather than a hand-maintained list of
 * concrete classes that would silently rot as the schema grows.
 *
 * An explicit type is queried with `includeInherited: false`, so IfcWall
 * means IfcWall and not also IfcWallStandardCase — subtype-widening would
 * select elements whose displayed class differs from the one the user
 * picked.
 *
 * The caller passes a NUMERIC code (`ElementIdentity.ifcTypeCode`, read off
 * the element itself). Do NOT reintroduce `GetTypeCodeFromName` here: it
 * hashes its argument rather than looking it up, so `'IfcSlab'` yields
 * 200263316 while the real IFCSLAB is 1529196076 — a wrong-but-plausible
 * code that returns an empty (or, on collision, an unrelated) result set
 * with no error to notice.
 */
function candidateIds(
  ifc: WebIFC.IfcAPI,
  modelID: number,
  ifcType: number | null | undefined,
): number[] {
  const allProducts = ifcType === null || ifcType === undefined;
  const vec = ifc.GetLineIDsWithType(modelID, allProducts ? WebIFC.IFCPRODUCT : ifcType, allProducts);
  const ids: number[] = [];
  for (let i = 0; i < vec.size(); i++) ids.push(vec.get(i));
  return ids;
}

/** List the expressIds of one type (or of every product) and post `ids`. */
async function handleEnumerateIds(
  reqId: number,
  id: string,
  ifcType: number | undefined,
): Promise<void> {
  const ifc = await getApi();
  const modelID = modelIds.get(id);
  if (modelID === undefined) {
    throw new Error(`ifcWorker: unknown modelId "${id}"`);
  }
  post({ type: 'ids', reqId, ids: candidateIds(ifc, modelID, ifcType) });
}

/**
 * Run `selector == value` over the candidate set and post the matching
 * expressIds. The predicate runs here, not on main, so a 50 000-element
 * class never ships 50 000 property bags across the boundary — only the
 * matching ids come back.
 */
async function handleFindMatching(
  reqId: number,
  id: string,
  ifcType: number | null,
  selector: PropertySelector,
  value: PropertyValue,
): Promise<void> {
  const ifc = await getApi();
  const modelID = modelIds.get(id);
  if (modelID === undefined) {
    throw new Error(`ifcWorker: unknown modelId "${id}"`);
  }

  const candidates = candidateIds(ifc, modelID, ifcType);
  if (candidates.length === 0) {
    post({ type: 'progress', reqId, done: 0, total: 0 });
    post({ type: 'ids', reqId, ids: [] });
    return;
  }

  const unitTable = await ensureUnitTable(ifc, id, modelID);

  const matches: number[] = [];
  const completed = await readProps(
    ifc,
    modelID,
    id,
    candidates,
    reqId,
    unitTable,
    (props) => {
      if (elementMatches(props, selector, value)) matches.push(props.identity.expressId);
    },
  );

  if (!completed) return;
  post({ type: 'ids', reqId, ids: matches });
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
      markPending(msg.reqId);
      enqueue(async () => {
        try {
          await runBulk(msg.reqId, () => handleIntersect(msg.reqId, msg.id, msg.expressIds));
        } catch (err) {
          post({ type: 'error', reqId: msg.reqId, message: errorMessage(err) });
        }
      });
      break;

    case 'enumerateIds':
      enqueue(async () => {
        try {
          await handleEnumerateIds(msg.reqId, msg.id, msg.ifcType);
        } catch (err) {
          post({ type: 'error', reqId: msg.reqId, message: errorMessage(err) });
        }
      });
      break;

    case 'findMatching':
      markPending(msg.reqId);
      enqueue(async () => {
        try {
          await runBulk(msg.reqId, () =>
            handleFindMatching(msg.reqId, msg.id, msg.ifcType, msg.selector, msg.value),
          );
        } catch (err) {
          post({ type: 'error', reqId: msg.reqId, message: errorMessage(err) });
        }
      });
      break;

    // NOT enqueued — deliberately. The job being cancelled is at the head
    // of the queue, so anything queued behind it could only be dispatched
    // after it finished, which is precisely too late. Handling this
    // synchronously is what makes cancellation work at all.
    case 'cancel':
      markCancelled(msg.reqId);
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
