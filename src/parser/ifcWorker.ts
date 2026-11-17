/**
 * IFC worker — the single owner of all web-ifc state.
 *
 * Runs in a dedicated module Web Worker (NOT a SharedArrayBuffer / pthread
 * worker — no COOP/COEP headers, no `crossOriginIsolated` required). It
 * holds the one `IfcAPI` instance, every open model, and the app-UUID →
 * numeric-web-ifc-id map. The main thread never sees a numeric model id.
 *
 * Responsibilities:
 *  - `parse`        — open a model and stream geometry back in batches; for
 *                     a shared parse, only the chunks the coordinator hands
 *                     out over the `chunkPort` (until `stopShare` or the end).
 *  - `share`        — as a helper: open a copy of a model, stream chunks for
 *                     it, close it. The same script runs as main worker and
 *                     as helper; a helper never answers property queries.
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
import { ModelPropertyCaches, type ModelPropertyCache } from '../inspector/repository/modelPropertyCache';
import { computeUnitTable } from '../inspector/repository/unitTable';
import { buildUnitTable, DEFAULT_UNITS, type UnitTable } from '../inspector/format';
import {
  intersectSeed,
  intersectStep,
  intersectFinalize,
  type RunningIntersection,
} from '../inspector/intersection';
import { elementMatches, type PropertySelector } from '../inspector/matchValue';
import type { ElementProperties, PropertyValue } from '../inspector/types';
import type { FromChunkPort, FromWorker, ToChunkPort, ToWorker } from './ifcMessages';
import type { ParsedMesh } from './types';
import { weldVertices, WELD_NORMAL_STEPS } from './weld';
import { WorkerTimeline } from '../core/LoadTimeline';
import { geometryProductIds } from './geometryProducts';
import { StreamBatcher } from './streamBatcher';
import { openPartFile, PartWriter, type SyncFile } from '../services/geometryParts';
import { ShareRegistry } from './shareRegistry';

/**
 * When `parse` sends a `batch`: after this many products, or after this many
 * ms of streaming, whichever comes first (see `StreamBatcher`). The count
 * keeps the message rate sane on a model of small elements; the clock puts
 * the first geometry on screen within a fraction of a second, and keeps each
 * batch small enough for the main thread to append without a long stall.
 */
const STREAM_BATCH_SIZE = 200;
const STREAM_BATCH_INTERVAL_MS = 200;

// --- web-ifc instance + per-model state -------------------------------------

let api: WebIFC.IfcAPI | null = null;
let initPromise: Promise<WebIFC.IfcAPI> | null = null;

/** App UUID → numeric web-ifc model id. The worker is the sole owner. */
const modelIds = new Map<string, number>();
/** App UUID → per-model unit table (lazily computed on first property query). */
const unitTables = new Map<string, UnitTable>();
/**
 * App UUID → per-model property cache (relationship index + resolved type
 * objects). Created by the first bulk read, used by every read after it, and
 * dropped with the model. See `modelPropertyCache.ts`.
 */
const propertyCaches = new ModelPropertyCaches();

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
  timeline?: WorkerTimeline,
  role: 'worker' | 'helper' = 'worker',
): void {
  for (let i = 0; i < flatMesh.geometries.size(); i++) {
    const placedGeom = flatMesh.geometries.get(i);
    const t0 = performance.now();
    const geom = ifc.GetGeometry(modelID, placedGeom.geometryExpressID);

    const verts = ifc.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
    const idxs = ifc.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());

    // Extract vertices (position only, stride of 6: x,y,z,nx,ny,nz).
    const vertexCount = verts.length / 6;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    // Local bounds ride along in the same pass: see `ParsedMesh.bounds`. They
    // stay true after welding below, which keeps every distinct position.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let j = 0; j < vertexCount; j++) {
      const x = verts[j * 6];
      const y = verts[j * 6 + 1];
      const z = verts[j * 6 + 2];
      positions[j * 3] = x;
      positions[j * 3 + 1] = y;
      positions[j * 3 + 2] = z;
      normals[j * 3] = verts[j * 6 + 3];
      normals[j * 3 + 1] = verts[j * 6 + 4];
      normals[j * 3 + 2] = verts[j * 6 + 5];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    // web-ifc gives nearly every triangle its own three vertices. Sharing the
    // ones that are the same point with the same (8-bit, as drawn) normal cuts
    // the vertex work and memory of a large model by about a fifth.
    const t1 = performance.now();
    const welded = weldVertices(positions, normals, new Uint32Array(idxs), WELD_NORMAL_STEPS);
    if (timeline) {
      const t2 = performance.now();
      timeline.add(`${role}.extract`, t1 - t0);
      timeline.add(`${role}.weld`, t2 - t1);
    }

    const color = placedGeom.color;
    const mesh: ParsedMesh = {
      expressID: flatMesh.expressID,
      vertices: welded.positions,
      normals: welded.normals,
      indices: welded.indices,
      transform: Array.from(placedGeom.flatTransformation),
      color: { r: color.x, g: color.y, b: color.z, a: color.w },
    };
    if (vertexCount > 0) mesh.bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
    sink.push(mesh);

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
 * thread, so it never has to yield — it lists the elements, runs ONE
 * `StreamMeshes` pass over them, extracts geometry inside the callback, and
 * posts `batch` messages as products accumulate. Every reply carries the
 * parse's `token`.
 */
async function handleParse(
  id: string,
  token: number,
  buffer: ArrayBuffer,
  shared: boolean,
  cacheKey: string | undefined,
  timeline: WorkerTimeline,
): Promise<void> {
  timeline.mark('worker.started');
  // Opened while the model opens; awaited once there is geometry to store.
  const file = cacheKey ? openPartFile(cacheKey, 0) : null;
  const opened: { modelID: number | null } = { modelID: null };
  try {
    await parseInto(id, token, buffer, shared, file, timeline, opened);
  } catch (err) {
    // The part file holds a lock for as long as it is open: let it go, so a
    // later sweep can remove the half-written load.
    closeQuietly(file);
    // A model opened for a parse that failed is of no use to anyone.
    if (opened.modelID !== null) closeModel(id, opened.modelID);
    throw err;
  }
}

async function parseInto(
  id: string,
  token: number,
  buffer: ArrayBuffer,
  shared: boolean,
  file: Promise<SyncFile | null> | null,
  timeline: WorkerTimeline,
  opened: { modelID: number | null },
): Promise<void> {
  const ifc = await getApi();
  timeline.mark('worker.ready');
  const t0 = performance.now();
  const modelID = ifc.OpenModel(new Uint8Array(buffer));
  opened.modelID = modelID;
  timeline.add('worker.open', performance.now() - t0);
  timeline.mark('worker.opened');
  modelIds.set(id, modelID);

  // The elements to stream, from the type index (milliseconds). Its length
  // is the progress total: an upper bound, since a product without a body
  // is listed but streams nothing. See `geometryProducts.ts`.
  const ids = geometryProductIds(ifc, modelID);
  post(shared ? { type: 'listed', token, total: ids.length, ids } : { type: 'listed', token, total: ids.length });
  timeline.mark('worker.listed');

  const writer = file ? new PartWriter(await file, 0) : null;

  // Geometry is extracted inside the stream callback (it is only valid
  // there) and posted in batches as the batcher decides.
  const batcher = new StreamBatcher<ParsedMesh>(
    (meshes, products) => postBatch(token, meshes, products, undefined, timeline, 'worker', writer),
    { maxProducts: STREAM_BATCH_SIZE, maxIntervalMs: STREAM_BATCH_INTERVAL_MS },
  );

  if (shared) {
    timeline.mark('worker.waitPort');
    const port = await shares.portFor(token);
    await streamChunks(ifc, modelID, token, port, batcher, timeline, 'worker', writer);
  } else {
    streamIds(ifc, modelID, ids, batcher, timeline);
  }
  batcher.flush();
  timeline.mark('worker.streamed');

  // Model kept open — property queries need the STEP graph. Closed by
  // `disposeModel` / `dispose`.
  post({ type: 'parsed', token, timings: timeline.toJSON() });

  if (writer) post({ type: 'cacheWritten', token, report: writer.finish() });
}

/** Close a model this worker opened, unless a later request has replaced it. */
function closeModel(id: string, modelID: number): void {
  if (modelIds.get(id) === modelID) {
    modelIds.delete(id);
    unitTables.delete(id);
    propertyCaches.drop(id);
  }
  try {
    api?.CloseModel(modelID);
  } catch {
    // web-ifc may be down already
  }
}

/** Close a part file whatever state the load got to (closing twice is harmless). */
function closeQuietly(file: Promise<SyncFile | null> | null): void {
  void file?.then((f) => {
    try {
      f?.close();
    } catch {
      // already closed
    }
  });
}

/**
 * Help another worker parse a model: open it, stream the chunks the
 * coordinator hands out over `port`, close it. A chunk's geometry goes out in
 * one batch, marked with the chunk's index: the main thread counts the chunk
 * delivered when that batch arrives, so if this worker dies mid-chunk none of
 * that chunk was delivered and another worker streams it.
 */
async function handleShare(
  token: number,
  buffer: ArrayBuffer,
  port: MessagePort,
  worker: number,
  cacheKey: string | undefined,
  timeline: WorkerTimeline,
): Promise<void> {
  timeline.mark('helper.started');
  const file = cacheKey ? openPartFile(cacheKey, worker) : null;
  try {
    await shareInto(token, buffer, port, worker, file, timeline);
  } catch (err) {
    closeQuietly(file);
    throw err;
  }
}

async function shareInto(
  token: number,
  buffer: ArrayBuffer,
  port: MessagePort,
  worker: number,
  file: Promise<SyncFile | null> | null,
  timeline: WorkerTimeline,
): Promise<void> {
  const ifc = await getApi();
  const t0 = performance.now();
  const modelID = ifc.OpenModel(new Uint8Array(buffer));
  timeline.add('helper.open', performance.now() - t0);
  timeline.mark('helper.opened');
  const writer = file ? new PartWriter(await file, worker) : null;
  try {
    const batcher = new StreamBatcher<ParsedMesh>(() => {}, {
      maxProducts: Infinity,
      maxIntervalMs: Infinity,
    });
    await streamChunks(ifc, modelID, token, port, batcher, timeline, 'helper', writer);
  } finally {
    ifc.CloseModel(modelID);
  }
  timeline.mark('helper.streamed');
  post({ type: 'shareStreamed', token, timings: timeline.toJSON() });
  // Flushed and closed before saying done: terminating the worker would
  // otherwise lose what the file system has not written yet.
  post({ type: 'shareDone', token, cache: writer?.finish() });
}

/** Coordinator ports, chunk inboxes and early stops of shared parses, by token. */
const shares = new ShareRegistry<MessagePort>();

/**
 * Stream the chunks the coordinator hands out over `port` until it says
 * there are no more (or the main thread stops the parse). After each chunk
 * its geometry is posted to the main thread with the chunk's index, and the
 * coordinator asked for another.
 */
async function streamChunks(
  ifc: WebIFC.IfcAPI,
  modelID: number,
  token: number,
  port: MessagePort,
  batcher: StreamBatcher<ParsedMesh>,
  timeline: WorkerTimeline,
  role: 'worker' | 'helper' = 'worker',
  writer: PartWriter | null = null,
): Promise<void> {
  const inbox = shares.open(token);
  port.onmessage = (e: MessageEvent<ToChunkPort>): void => inbox.push(e.data);
  const tell = (msg: FromChunkPort): void => port.postMessage(msg);
  tell({ type: 'ready' });
  try {
    for (;;) {
      const tw = performance.now();
      const chunk = await inbox.next();
      timeline.add(`${role}.waitChunk`, performance.now() - tw);
      if (chunk.ids === null) break;
      streamIds(ifc, modelID, chunk.ids, batcher, timeline, role);
      const { items, products } = batcher.take();
      // Always posted, even empty: it is what marks the chunk delivered.
      postBatch(token, items, products, chunk.index, timeline, role, writer);
      tell({ type: 'done', index: chunk.index });
    }
  } finally {
    shares.close(token);
    port.onmessage = null;
    port.close();
  }
}

/** `StreamMeshes` over `ids`, extracting every piece into the batcher. */
function streamIds(
  ifc: WebIFC.IfcAPI,
  modelID: number,
  ids: number[],
  batcher: StreamBatcher<ParsedMesh>,
  timeline: WorkerTimeline,
  role: 'worker' | 'helper' = 'worker',
): void {
  const t0 = performance.now();
  ifc.StreamMeshes(modelID, ids, (flatMesh: WebIFC.FlatMesh) => {
    timeline.mark(`${role}.firstMesh`);
    extractFlatMesh(ifc, flatMesh, modelID, batcher.sink, timeline, role);
    batcher.endProduct();
  });
  timeline.add(`${role}.stream`, performance.now() - t0);
}

function postBatch(
  token: number,
  meshes: ParsedMesh[],
  products: number,
  chunk: number | undefined,
  timeline: WorkerTimeline,
  role: 'worker' | 'helper' = 'worker',
  writer: PartWriter | null = null,
): void {
  if (chunk === undefined && meshes.length === 0 && products === 0) return;
  if (writer && meshes.length > 0) {
    // Packed (copied) before the buffers are transferred away below.
    const tw = performance.now();
    writer.write(meshes);
    timeline.add(`${role}.cacheWrite`, performance.now() - tw);
  }
  const tp = performance.now();
  const msg: FromWorker = chunk === undefined
    ? { type: 'batch', token, meshes, products }
    : { type: 'batch', token, meshes, products, chunk };
  post(msg, batchTransferables(meshes));
  timeline.add(`${role}.post`, performance.now() - tp);
  if (meshes.length > 0) timeline.mark(`${role}.firstBatchPosted`);
}

/**
 * Open a model for property queries only — no geometry streamed. The
 * geometry-cache fast-restore path uses this: the scene is already up
 * from cached meshes, the worker just needs the model open so later
 * `getProps` messages resolve.
 */
async function handleOpenForProps(id: string, token: number, buffer: ArrayBuffer): Promise<void> {
  const ifc = await getApi();
  const modelID = ifc.OpenModel(new Uint8Array(buffer));
  modelIds.set(id, modelID);
  post({ type: 'parsed', token });
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
  cache: ModelPropertyCache | undefined,
): Promise<ElementProperties> {
  return fetchElementProperties(
    ifc as unknown as Parameters<typeof fetchElementProperties>[0],
    modelID,
    id,
    expressId,
    unitTable,
    cache,
  );
}

/**
 * Fetch + normalize one element's properties and post them back.
 *
 * Uses the model's property cache if a bulk read has already built it, but
 * never builds it: on a large model the relationship index costs a few
 * hundred milliseconds up front, which a single inspector click (a few
 * milliseconds uncached) should not pay.
 */
async function handleGetProps(reqId: number, id: string, expressId: number): Promise<void> {
  const ifc = await getApi();
  const modelID = modelIds.get(id);
  if (modelID === undefined) {
    throw new Error(`ifcWorker: unknown modelId "${id}"`);
  }
  const unitTable = await ensureUnitTable(ifc, id, modelID);
  const props = await getOne(ifc, modelID, id, expressId, unitTable, propertyCaches.peek(id));
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
  const cache = propertyCaches.for(id, ifc, modelID);

  for (let start = 0; start < total; start += INTERSECT_CHUNK) {
    if (cancelled.has(reqId)) return false;

    const end = Math.min(start + INTERSECT_CHUNK, total);
    for (let i = start; i < end; i++) {
      onEach(await getOne(ifc, modelID, id, expressIds[i], unitTable, cache));
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
async function handleGetLengthUnit(reqId: number, id: string): Promise<void> {
  const ifc = await getApi();
  const modelID = modelIds.get(id);
  if (modelID === undefined) {
    throw new Error(`ifcWorker: unknown modelId "${id}"`);
  }
  const unitTable = await ensureUnitTable(ifc, id, modelID);
  post({ type: 'lengthUnit', reqId, symbol: unitTable.get('length') ?? DEFAULT_UNITS.length });
}

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
  propertyCaches.drop(id);
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
  propertyCaches.clear();
}

// --- message dispatch --------------------------------------------------------

self.onmessage = (event: MessageEvent<ToWorker>): void => {
  const msg = event.data;
  switch (msg.type) {
    case 'parse': {
      // Stamped on arrival, before the queue: the gap to `worker.started` is
      // time spent waiting behind other requests.
      const timeline = new WorkerTimeline();
      timeline.mark('worker.received');
      enqueue(async () => {
        try {
          await handleParse(msg.id, msg.token, msg.buffer, msg.shared === true, msg.cacheKey, timeline);
        } catch (err) {
          post({ type: 'error', token: msg.token, message: errorMessage(err) });
        }
      });
      break;
    }

    case 'share': {
      const timeline = new WorkerTimeline();
      timeline.mark('helper.received');
      enqueue(async () => {
        try {
          await handleShare(msg.token, msg.buffer, msg.port, msg.worker, msg.cacheKey, timeline);
        } catch (err) {
          post({ type: 'error', token: msg.token, message: errorMessage(err) });
        }
      });
      break;
    }

    // NOT enqueued: the shared parse waiting for it holds the queue.
    case 'chunkPort':
      shares.providePort(msg.token, msg.port);
      break;

    // NOT enqueued either: it must reach the parse that holds the queue.
    case 'stopShare':
      shares.stop(msg.token);
      break;

    case 'openForProps':
      enqueue(async () => {
        try {
          await handleOpenForProps(msg.id, msg.token, msg.buffer);
        } catch (err) {
          post({ type: 'error', token: msg.token, message: errorMessage(err) });
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

    case 'getLengthUnit':
      enqueue(async () => {
        try {
          await handleGetLengthUnit(msg.reqId, msg.id);
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
