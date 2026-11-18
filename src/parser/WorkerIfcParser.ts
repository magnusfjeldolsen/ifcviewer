/**
 * Main-thread proxy for the IFC worker's geometry path.
 *
 * Owns the `Worker` instance and translates `parseStreaming` /
 * `openForProperties` / `disposeModel` / `dispose` calls into messages.
 * The worker (`ifcWorker.ts`) does the actual web-ifc work; this class
 * only correlates replies back to the right promise.
 *
 * The property path has its own proxy — `WorkerPropertyRepository` — that
 * shares the SAME worker instance (passed in via the constructor) so all
 * web-ifc state lives in one place and requests serialize naturally.
 *
 * ## Tokens
 *
 * Every parse and every properties-only open gets a **token**, and every
 * message about it carries that token. Replies are matched by token, never by
 * model id: one model id can have several requests in the worker's queue (a
 * restore that opens a model for properties, finds its cache entry broken and
 * parses it instead; Reset View twice), and a reply meant for an earlier one
 * must not settle, or feed, a later one.
 *
 * ## Helpers
 *
 * A large model's geometry is streamed by more than one worker. The main
 * worker opens the model, lists its elements and starts streaming; helper
 * workers open their own copy of the file meanwhile and join in. A small
 * coordinator worker hands the element ids out in chunks (`ChunkCoordinator`)
 * to whichever worker asks. A chunk counts as delivered only when its
 * geometry has reached this thread, which tells the coordinator so: a helper
 * that fails can then give back exactly the chunks that never arrived —
 * nothing is lost and nothing is drawn twice. Only the main worker keeps the
 * model: property queries never see a helper. How many helpers a model gets
 * is `planHelpers`' call.
 */

import type { FromWorker, ToCoordinator, ToWorker } from './ifcMessages';
import type { ParsedMesh, StreamedModel, StreamProgress } from './types';
import { mergeWorkerTimings, type LoadTimeline, type WorkerTimings } from '../core/LoadTimeline';
import { HELPER_MEMORY_FACTOR, planHelpers } from './parsePlan';
import type { CacheWriteReport } from '../services/geometryParts';

/**
 * Minimal `Worker` surface this proxy depends on. Lets unit tests inject
 * a stub instead of a real Worker (which jsdom / node cannot host).
 */
export interface WorkerLike {
  postMessage(message: ToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Key of the main worker in a shared parse; helpers are 1, 2, … */
const MAIN = 0;

/** A parse whose geometry is shared with helper workers. */
interface SharedParse {
  id: string;
  token: number;
  buffer: ArrayBuffer;
  helperCount: number;
  /** Memory the helpers are assumed to hold, against the global budget. */
  helperBytes: number;
  cacheKey?: string;
  /** Runs the `ChunkCoordinator`. */
  coordinator: WorkerLike;
  /** The coordinator's ends of the workers' ports, until the plan carries them over. */
  coordinatorPorts: MessagePort[] | null;
  /** Helpers that could not be created. */
  failedEarly: number[];
  /** Helpers not yet terminated, by key (1, 2, …; the main worker is 0). */
  helpers: Map<number, WorkerLike>;
  /** Helpers whose geometry is all delivered (or never will be: failed, never started). */
  streamed: Set<number>;
  /** Sharing was called off (model removed, worker failed). */
  cancelled: boolean;
  /** The main worker's `parsed` has arrived. */
  mainDone: boolean;
  timings: WorkerTimings[];
}

/** Collects the workers' cache-write reports for one load. */
interface CacheReports {
  /** The model, so removing it can spoil a write that outlived its parse. */
  id: string;
  expected: number;
  reports: CacheWriteReport[];
  resolve: (report: CacheWriteReport) => void;
}

/** Per-request in-flight parse / openForProps state. */
interface PendingModel {
  id: string;
  resolve: (model: StreamedModel) => void;
  reject: (err: Error) => void;
  /** Meshes delivered so far. They are not kept: `onBatch` owns them. */
  meshCount: number;
  /** Elements delivered so far, and how many were listed. */
  loaded: number;
  total: number;
  /** Per-batch callback — undefined for `openForProperties` (no geometry). */
  onBatch?: (meshes: ParsedMesh[], progress: StreamProgress) => void;
  timeline?: LoadTimeline;
  shared?: SharedParse;
}

export interface ParseOptions {
  /**
   * Have the workers store the geometry in the cache under this key as they
   * stream it (see `geometryParts.ts`). `StreamedModel.cache` then says when
   * the parts are stored.
   */
  cacheKey?: string;
}

export interface WorkerIfcParserOptions {
  /** Creates a helper worker (tests inject stubs). */
  createHelper?: () => WorkerLike;
  /** Creates the chunk coordinator's worker (tests inject stubs). */
  createCoordinator?: () => WorkerLike;
  /**
   * How many helpers a file of `bytes` gets, given the bytes helpers of other
   * loads already hold. Defaults to `planHelpers`.
   */
  helpersFor?: (bytes: number, helperBytesInUse: number) => number;
}

/**
 * Build the default worker. Extracted so the constructor can fall back to
 * it while tests inject a `WorkerLike` stub. `new URL(..., import.meta.url)`
 * with `{ type: 'module' }` is the standard Vite worker form — Vite bundles
 * `ifcWorker.ts` (and its `web-ifc` import) into a separate chunk.
 */
function createDefaultWorker(): WorkerLike {
  return new Worker(new URL('./ifcWorker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

function createCoordinatorWorker(): WorkerLike {
  return new Worker(new URL('./chunkCoordinatorWorker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

function defaultHelpersFor(bytes: number, helperBytesInUse: number): number {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  return planHelpers({
    fileBytes: bytes,
    cores: nav?.hardwareConcurrency,
    deviceMemoryGB: nav?.deviceMemory,
    helperBytesInUse,
  });
}

const FAILED_WRITE: CacheWriteReport = { ok: false, parts: 0, bytes: 0 };

export class WorkerIfcParser {
  private worker: WorkerLike;
  /** In-flight parses / opens, by token. */
  private pending = new Map<number, PendingModel>();
  /** Cache writes still outstanding, by token. Outlive the parse. */
  private cacheReports = new Map<number, CacheReports>();
  /** Shared parses whose helpers may still be running, by token. */
  private shares = new Map<number, SharedParse>();
  private nextToken = 1;
  /** Memory all live helpers are assumed to hold (see `HELPER_MEMORY_FACTOR`). */
  private helperBytesInUse = 0;
  /**
   * Extra message sink — `WorkerPropertyRepository` registers here so it
   * can receive `props` / property-scoped `error` messages over the SAME
   * worker. Only one worker exists; one `onmessage` multiplexes both.
   */
  private extraSink: ((msg: FromWorker) => void) | null = null;
  /** Listeners notified when the worker thread itself crashes. */
  private crashListeners: (() => void)[] = [];
  private createHelper: () => WorkerLike;
  private createCoordinator: () => WorkerLike;
  private helpersFor: (bytes: number, helperBytesInUse: number) => number;

  /**
   * @param worker  Optional injected worker (tests). Defaults to the real
   *                module worker created from `ifcWorker.ts`.
   */
  constructor(worker?: WorkerLike, options: WorkerIfcParserOptions = {}) {
    this.worker = worker ?? createDefaultWorker();
    // An injected main worker means a test: no helpers unless it asks.
    this.createHelper = options.createHelper ?? createDefaultWorker;
    this.createCoordinator = options.createCoordinator ?? createCoordinatorWorker;
    this.helpersFor = options.helpersFor ?? (worker ? () => 0 : defaultHelpersFor);
    this.worker.onmessage = (event): void => this.onMessage(event.data);
    this.worker.onerror = (event: unknown): void => {
      // A worker-level error (not a posted `error` message) would leave
      // every in-flight request hanging. Reject them all and notify
      // listeners (WorkerPropertyRepository) so they can do the same.
      // The event's message, when it has one, says why (often memory).
      const detail = (event as { message?: unknown } | null)?.message;
      const err = new Error(typeof detail === 'string' && detail ? `IFC worker crashed: ${detail}` : 'IFC worker crashed');
      for (const [token, p] of this.pending) {
        if (p.shared) this.endShare(p.shared, false);
        this.settleCache(token, FAILED_WRITE, true);
        p.reject(err);
      }
      this.pending.clear();
      for (const token of [...this.cacheReports.keys()]) this.settleCache(token, FAILED_WRITE, true);
      for (const listener of this.crashListeners) listener();
    };
  }

  /** The underlying worker — shared with `WorkerPropertyRepository`. */
  getWorker(): WorkerLike {
    return this.worker;
  }

  /**
   * Register the property-path message sink. `WorkerPropertyRepository`
   * calls this so `props` / property-scoped `error` messages reach it
   * over the one shared worker. Only one sink is supported.
   */
  setExtraMessageSink(sink: (msg: FromWorker) => void): void {
    this.extraSink = sink;
  }

  /** Subscribe to worker-thread crashes (distinct from posted `error`s). */
  onCrash(listener: () => void): void {
    this.crashListeners.push(listener);
  }

  /**
   * Parse a model with progressive geometry delivery. `onBatch` fires once
   * per `batch` message from any worker, and is the only holder of those
   * meshes: the returned promise resolves with how many there were, not the
   * meshes themselves. With helpers, batches arrive in no fixed element order.
   *
   * The `.ifc` buffer is copied, not transferred, to the worker (see below).
   */
  parseStreaming(
    buffer: ArrayBuffer,
    id: string,
    onBatch: (meshes: ParsedMesh[], progress: StreamProgress) => void,
    timeline?: LoadTimeline,
    options: ParseOptions = {},
  ): Promise<StreamedModel> {
    const token = this.nextToken++;
    let cache: Promise<CacheWriteReport> | undefined;
    if (options.cacheKey) {
      cache = new Promise<CacheWriteReport>((resolve) => {
        this.cacheReports.set(token, { id, expected: 1, reports: [], resolve });
      });
    }
    const done = new Promise<StreamedModel>((resolve, reject) => {
      const t0 = performance.now();
      const p: PendingModel = { id, resolve, reject, meshCount: 0, loaded: 0, total: 0, onBatch, timeline };
      let helperCount = Math.max(0, Math.floor(this.helpersFor(buffer.byteLength, this.helperBytesInUse)));
      // The coordinator first: if it cannot be created, the parse is simply
      // not shared — the main worker must never be told to wait for chunks
      // that nobody will hand out.
      let coordinator: WorkerLike | null = null;
      if (helperCount > 0) {
        try {
          coordinator = this.createCoordinator();
        } catch {
          helperCount = 0;
        }
      }
      if (coordinator) {
        const shared: SharedParse = {
          id,
          token,
          buffer,
          helperCount,
          helperBytes: helperCount * HELPER_MEMORY_FACTOR * buffer.byteLength,
          cacheKey: options.cacheKey,
          coordinator,
          coordinatorPorts: null,
          failedEarly: [],
          helpers: new Map(),
          streamed: new Set(),
          cancelled: false,
          mainDone: false,
          timings: [],
        };
        p.shared = shared;
        this.shares.set(token, shared);
        this.helperBytesInUse += shared.helperBytes;
      }
      this.pending.set(token, p);
      // We intentionally do NOT transfer the buffer. The main thread still
      // needs the original alive after this call — for `sessionStore.saveModel`
      // (IDB persistence) and `App.bufferCache` (used by `resetView`).
      // Transferring detaches the main-thread ArrayBuffer, which made the IDB
      // save silently fail and turned a reload into "File missing — re-upload"
      // for every model. The worker gets a structured-clone copy; the cost is
      // one copy of the .ifc bytes, which is fine.
      const msg: ToWorker = { type: 'parse', id, token, buffer };
      if (p.shared) msg.shared = true;
      if (options.cacheKey) msg.cacheKey = options.cacheKey;
      this.worker.postMessage(msg);
      if (p.shared) this.startSharing(p, p.shared);
      // postMessage clones the buffer before it returns.
      timeline?.add('main.postParse', performance.now() - t0);
      timeline?.mark('main.posted');
    });
    return cache ? done.then((model) => ({ ...model, cache })) : done;
  }

  /**
   * Open a model in the worker for property queries only — no geometry
   * streamed. Used by the geometry-cache fast-restore path. Resolves once
   * the worker posts `parsed`. The `.ifc` buffer is structured-cloned (not
   * transferred — see the rationale on `parseStreaming`).
   */
  openForProperties(buffer: ArrayBuffer, id: string): Promise<void> {
    const token = this.nextToken++;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(token, {
        id,
        resolve: () => resolve(),
        reject,
        meshCount: 0,
        loaded: 0,
        total: 0,
      });
      this.worker.postMessage({ type: 'openForProps', id, token, buffer });
    });
  }

  /**
   * Close a model in the worker and free its per-model caches. A shared
   * parse of it still running is cut short first: the helpers go, and the
   * main worker is told there is nothing more to stream, so it reaches the
   * close. Its geometry is not cached.
   */
  disposeModel(id: string): void {
    for (const shared of [...this.shares.values()]) if (shared.id === id) this.endShare(shared);
    for (const [token, c] of [...this.cacheReports]) if (c.id === id) this.settleCache(token, FAILED_WRITE, true);
    this.worker.postMessage({ type: 'disposeModel', id });
  }

  /** Tear down the worker: dispose web-ifc, then terminate the thread. */
  dispose(): void {
    for (const shared of [...this.shares.values()]) this.endShare(shared, false);
    for (const token of [...this.cacheReports.keys()]) this.settleCache(token, FAILED_WRITE, true);
    this.worker.postMessage({ type: 'dispose' });
    this.worker.terminate();
  }

  // --- internals -------------------------------------------------------------


  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'listed': {
        const p = this.pending.get(msg.token);
        if (!p) return;
        p.total = msg.total;
        if (p.shared && msg.ids) this.plan(p.shared, msg.ids);
        break;
      }
      case 'batch':
        this.onBatchMessage(MAIN, msg);
        break;
      case 'parsed': {
        const p = this.pending.get(msg.token);
        if (!p) return;
        if (p.shared) {
          if (msg.timings) p.shared.timings.unshift(msg.timings);
          p.shared.mainDone = true;
          this.maybeFinish(p.shared);
          return;
        }
        this.pending.delete(msg.token);
        p.resolve({ id: p.id, meshCount: p.meshCount, timings: msg.timings });
        break;
      }
      case 'cacheWritten':
        this.addCacheReport(msg.token, msg.report);
        break;
      case 'error': {
        if (msg.token === undefined) {
          // A property-query error (correlated by reqId) — hand off.
          this.extraSink?.(msg);
          return;
        }
        const p = this.pending.get(msg.token);
        if (!p) return;
        this.pending.delete(msg.token);
        if (p.shared) this.endShare(p.shared);
        this.settleCache(msg.token, FAILED_WRITE, true);
        p.reject(new Error(msg.message));
        break;
      }
      case 'props':
      case 'intersection':
      case 'ids':
      case 'lengthUnit':
      case 'progress':
        // Property-query / bulk-reduction / progress reply — belongs to
        // WorkerPropertyRepository.
        this.extraSink?.(msg);
        break;
      case 'shareStreamed':
      case 'shareDone':
        // Only helpers send these.
        break;
    }
  }

  /** A `batch` from worker `key` of a parse. */
  private onBatchMessage(key: number, msg: Extract<FromWorker, { type: 'batch' }>): void {
    const p = this.pending.get(msg.token);
    if (!p) return;
    p.meshCount += msg.meshes.length;
    p.loaded += msg.products;
    if (msg.meshes.length > 0 || msg.products > 0) {
      try {
        p.onBatch?.(msg.meshes, { loaded: p.loaded, total: Math.max(p.total, p.loaded) });
      } catch (err) {
        // The page could not take the geometry (typically out of memory
        // appending it). Thrown here, in a message handler, it would reach
        // nobody and the load would carry on half-built: fail it instead.
        this.abortLoad(msg.token, p, err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
    // The chunk's geometry is here: only now does it count as delivered.
    if (msg.chunk !== undefined && p.shared && !p.shared.cancelled) {
      this.tellCoordinator(p.shared, { type: 'received', worker: key, index: msg.chunk });
    }
  }

  /**
   * Start the helpers, and give every worker its port to the coordinator.
   * The helpers open their copy of the file while the main worker opens its
   * own; the chunks come once the main worker has listed the elements (`plan`).
   */
  private startSharing(p: PendingModel, shared: SharedParse): void {
    const { id, token } = shared;
    const t0 = performance.now();
    const channels = Array.from({ length: shared.helperCount + 1 }, () => new MessageChannel());
    shared.coordinatorPorts = channels.map((c) => c.port1);
    shared.coordinator.onerror = (): void => this.failShare(shared, 'chunk coordinator crashed');
    this.worker.postMessage({ type: 'chunkPort', token, port: channels[MAIN].port2 }, [channels[MAIN].port2]);
    for (let key = 1; key <= shared.helperCount; key++) {
      let helper: WorkerLike;
      try {
        helper = this.createHelper();
      } catch {
        shared.failedEarly.push(key);
        shared.streamed.add(key);
        continue;
      }
      shared.helpers.set(key, helper);
      const reports = this.cacheReports.get(token);
      if (reports) reports.expected++;
      helper.onmessage = (event): void => this.onHelperMessage(shared, key, event.data);
      helper.onerror = (): void => this.helperFailed(shared, key);
      // The file is copied to each helper, like to the main worker (see
      // `parseStreaming`); the port is transferred.
      const port = channels[key].port2;
      const msg: ToWorker = { type: 'share', id, token, buffer: shared.buffer, port, worker: key };
      if (shared.cacheKey) msg.cacheKey = shared.cacheKey;
      helper.postMessage(msg, [port]);
    }
    p.timeline?.add('main.postShare', performance.now() - t0);
  }

  /** The main worker has listed the elements: the coordinator can hand them out. */
  private plan(shared: SharedParse, ids: number[]): void {
    const ports = shared.coordinatorPorts;
    if (shared.cancelled || !ports) return;
    shared.coordinatorPorts = null;
    (shared.coordinator as unknown as { postMessage(m: ToCoordinator, t: Transferable[]): void }).postMessage(
      { type: 'plan', ids, ports },
      ports,
    );
    // Helpers that could not even be created hand nothing back, but the
    // coordinator must not wait for them.
    for (const key of shared.failedEarly) this.tellCoordinator(shared, { type: 'fail', worker: key });
  }

  private onHelperMessage(shared: SharedParse, key: number, msg: FromWorker): void {
    if (!shared.helpers.has(key)) return;
    if ('token' in msg && msg.token !== shared.token) return;
    switch (msg.type) {
      case 'batch':
        this.onBatchMessage(key, msg);
        break;
      case 'shareStreamed':
        if (msg.timings) shared.timings.push(msg.timings);
        shared.streamed.add(key);
        this.maybeFinish(shared);
        break;
      case 'shareDone':
        shared.streamed.add(key);
        this.terminateHelper(shared, key);
        this.addCacheReport(shared.token, msg.cache ?? FAILED_WRITE);
        this.maybeFinish(shared);
        break;
      case 'error':
        this.helperFailed(shared, key);
        break;
    }
  }

  /**
   * A helper died or reported an error. The coordinator hands out again every
   * chunk of it whose geometry this thread has not received — and only those:
   * it counts what arrived here, not what the helper said it finished.
   */
  private helperFailed(shared: SharedParse, key: number): void {
    if (!shared.helpers.has(key)) return;
    if (!shared.streamed.has(key)) {
      // Before the plan, the coordinator has nothing to take back yet; it
      // hears about this helper together with the plan.
      if (shared.coordinatorPorts) shared.failedEarly.push(key);
      else this.tellCoordinator(shared, { type: 'fail', worker: key });
    }
    shared.streamed.add(key);
    this.terminateHelper(shared, key);
    this.addCacheReport(shared.token, FAILED_WRITE);
    this.maybeFinish(shared);
  }

  /**
   * Fail a load from this side: stop its helpers, spoil its cache write,
   * close the model the main worker opened for it (after its parse, which
   * runs to the end and is ignored), and reject.
   */
  private abortLoad(token: number, p: PendingModel, err: Error): void {
    this.pending.delete(token);
    if (p.shared) this.endShare(p.shared);
    this.settleCache(token, FAILED_WRITE, true);
    this.worker.postMessage({ type: 'disposeModel', id: p.id });
    p.reject(err);
  }

  /** The coordinator itself failed: nothing can be handed out any more. */
  private failShare(shared: SharedParse, message: string): void {
    const p = this.pending.get(shared.token);
    if (!p || p.shared !== shared) return;
    this.pending.delete(shared.token);
    // The main worker opened the model for this parse; nobody will use it.
    this.endShare(shared);
    this.settleCache(shared.token, FAILED_WRITE, true);
    this.worker.postMessage({ type: 'disposeModel', id: shared.id });
    p.reject(new Error(message));
  }

  private terminateHelper(shared: SharedParse, key: number): void {
    const helper = shared.helpers.get(key);
    shared.helpers.delete(key);
    helper?.terminate();
    this.forgetShareIfDone(shared);
  }

  private tellCoordinator(shared: SharedParse, msg: ToCoordinator): void {
    shared.coordinator.postMessage(msg as unknown as ToWorker);
  }

  /**
   * Stop sharing a parse: helpers and coordinator terminated, and (unless
   * the worker is gone) the main worker told there is nothing more, so it
   * posts `parsed` with what it has and its queue moves on.
   */
  private endShare(shared: SharedParse, tellWorker = true): void {
    if (shared.cancelled) return;
    shared.cancelled = true;
    for (const key of [...shared.helpers.keys()]) {
      shared.streamed.add(key);
      this.terminateHelper(shared, key);
    }
    for (let key = 1; key <= shared.helperCount; key++) shared.streamed.add(key);
    shared.coordinator.terminate();
    if (tellWorker) this.worker.postMessage({ type: 'stopShare', token: shared.token });
    this.forgetShareIfDone(shared);
    this.maybeFinish(shared);
  }

  /** A shared parse resolves once the main worker and every helper have delivered. */
  private maybeFinish(shared: SharedParse): void {
    if (!shared.mainDone || shared.streamed.size < shared.helperCount) return;
    const p = this.pending.get(shared.token);
    if (!p || p.shared !== shared) return;
    this.pending.delete(shared.token);
    shared.coordinator.terminate();
    const timings = shared.timings.length ? shared.timings.reduce(mergeWorkerTimings) : undefined;
    if (timings) timings.spans['helpers'] = shared.helperCount;
    p.resolve({ id: shared.id, meshCount: p.meshCount, timings });
    this.forgetShareIfDone(shared);
  }

  private forgetShareIfDone(shared: SharedParse): void {
    if (shared.helpers.size > 0 || this.pending.has(shared.token)) return;
    if (this.shares.get(shared.token) !== shared) return;
    this.shares.delete(shared.token);
    this.helperBytesInUse -= shared.helperBytes;
  }

  private addCacheReport(token: number, report: CacheWriteReport): void {
    const c = this.cacheReports.get(token);
    if (!c) return;
    c.reports.push(report);
    if (c.reports.length >= c.expected) {
      const merged: CacheWriteReport = {
        ok: c.reports.every((r) => r.ok),
        parts: c.reports.reduce((n, r) => n + r.parts, 0),
        bytes: c.reports.reduce((n, r) => n + r.bytes, 0),
        files: c.reports.flatMap((r) => r.files ?? []),
      };
      const error = c.reports.find((r) => r.error)?.error ?? (merged.ok ? undefined : 'a worker stopped before storing its parts');
      if (error) merged.error = error;
      this.settleCache(token, merged);
    }
  }

  /** Resolve a load's cache promise (a failure overrides whatever came in). */
  private settleCache(token: number, report: CacheWriteReport, failed = false): void {
    const c = this.cacheReports.get(token);
    if (!c) return;
    this.cacheReports.delete(token);
    c.resolve(failed ? { ...FAILED_WRITE, parts: c.reports.reduce((n, r) => n + r.parts, 0), error: 'the load ended first' } : report);
  }
}
