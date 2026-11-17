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
 * ## Helpers
 *
 * A large model's geometry is streamed by more than one worker. The main
 * worker opens the model, lists its elements and starts streaming; helper
 * workers open their own copy of the file meanwhile and join in. This class
 * hands the element ids out in chunks (`ChunkPlan`) to whichever worker asks,
 * and closes the helpers when the list is done. Only the main worker keeps
 * the model: property queries never see a helper. How many helpers a model
 * gets is `planHelpers`' call.
 */

import type { FromWorker, ToCoordinator, ToWorker } from './ifcMessages';
import type { ParsedMesh, StreamedModel, StreamProgress } from './types';
import { mergeWorkerTimings, type LoadTimeline, type WorkerTimings } from '../core/LoadTimeline';
import { planHelpers } from './parsePlan';

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
  buffer: ArrayBuffer;
  helperCount: number;
  /** Runs the `ChunkCoordinator`; set once the main worker has listed. */
  coordinator: WorkerLike | null;
  /** Live helpers by key (1, 2, …; the main worker is 0). */
  helpers: Map<number, WorkerLike>;
  /** Helpers that have finished, failed, or never started. */
  ended: Set<number>;
  /** Sharing was called off (model removed, worker failed). */
  cancelled: boolean;
  /** The main worker's `parsed` has arrived. */
  mainDone: boolean;
  timings: WorkerTimings[];
}
/** Per-model in-flight parse / openForProps state. */
interface PendingModel {
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

export interface WorkerIfcParserOptions {
  /** Creates a helper worker (tests inject stubs). */
  createHelper?: () => WorkerLike;
  /** Creates the chunk coordinator's worker (tests inject stubs). */
  createCoordinator?: () => WorkerLike;
  /** How many helpers a file of `bytes` gets. Defaults to `planHelpers`. */
  helpersFor?: (bytes: number) => number;
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

function defaultHelpersFor(bytes: number): number {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  return planHelpers({
    fileBytes: bytes,
    cores: nav?.hardwareConcurrency,
    deviceMemoryGB: nav?.deviceMemory,
  });
}

export class WorkerIfcParser {
  private worker: WorkerLike;
  /** In-flight parses / opens, keyed by app-UUID model id. */
  private pending = new Map<string, PendingModel>();
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
  private helpersFor: (bytes: number) => number;

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
    this.worker.onerror = (): void => {
      // A worker-level error (not a posted `error` message) would leave
      // every in-flight request hanging. Reject them all and notify
      // listeners (WorkerPropertyRepository) so they can do the same.
      const err = new Error('IFC worker crashed');
      for (const [id, p] of this.pending) {
        this.endShare(id, p);
        p.reject(err);
      }
      this.pending.clear();
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
   * meshes themselves. A caller that needs them all (the geometry cache)
   * gathers them in `onBatch`. With helpers, batches arrive in no fixed
   * element order.
   *
   * The `.ifc` buffer is copied, not transferred, to the worker (see below).
   */
  parseStreaming(
    buffer: ArrayBuffer,
    id: string,
    onBatch: (meshes: ParsedMesh[], progress: StreamProgress) => void,
    timeline?: LoadTimeline,
  ): Promise<StreamedModel> {
    return new Promise<StreamedModel>((resolve, reject) => {
      const t0 = performance.now();
      const helperCount = Math.max(0, Math.floor(this.helpersFor(buffer.byteLength)));
      const p: PendingModel = { resolve, reject, meshCount: 0, loaded: 0, total: 0, onBatch, timeline };
      if (helperCount > 0) {
        p.shared = {
          buffer,
          helperCount,
          coordinator: null,
          helpers: new Map(),
          ended: new Set(),
          cancelled: false,
          mainDone: false,
          timings: [],
        };
      }
      this.pending.set(id, p);
      // We intentionally do NOT transfer the buffer. The main thread still
      // needs the original alive after this call — for `sessionStore.saveModel`
      // (IDB persistence) and `App.bufferCache` (used by `resetView`).
      // Transferring detaches the main-thread ArrayBuffer, which made the IDB
      // save silently fail and turned a reload into "File missing — re-upload"
      // for every model. The worker gets a structured-clone copy; the cost is
      // one copy of the .ifc bytes, which is fine.
      this.worker.postMessage(
        helperCount > 0 ? { type: 'parse', id, buffer, shared: true } : { type: 'parse', id, buffer },
      );
      // postMessage clones the buffer before it returns.
      timeline?.add('main.postParse', performance.now() - t0);
      timeline?.mark('main.posted');
    });
  }

  /**
   * Open a model in the worker for property queries only — no geometry
   * streamed. Used by the geometry-cache fast-restore path. Resolves once
   * the worker posts `parsed`. The `.ifc` buffer is structured-cloned (not
   * transferred — see the rationale on `parseStreaming`).
   */
  openForProperties(buffer: ArrayBuffer, id: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
        meshCount: 0,
        loaded: 0,
        total: 0,
      });
      this.worker.postMessage({ type: 'openForProps', id, buffer });
    });
  }

  /**
   * Close a model in the worker and free its per-model caches. A shared
   * parse still running is cut short first: the helpers go, and the main
   * worker is told there is nothing more to stream, so it reaches the close.
   */
  disposeModel(id: string): void {
    const p = this.pending.get(id);
    if (p?.shared) this.endShare(id, p);
    this.worker.postMessage({ type: 'disposeModel', id });
  }

  /** Tear down the worker: dispose web-ifc, then terminate the thread. */
  dispose(): void {
    for (const [id, p] of this.pending) this.endShare(id, p);
    this.worker.postMessage({ type: 'dispose' });
    this.worker.terminate();
  }

  // --- internals -------------------------------------------------------------

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'listed': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        p.total = msg.total;
        if (p.shared && msg.ids) this.startSharing(msg.id, p, msg.ids);
        break;
      }
      case 'batch':
        this.onBatchMessage(msg);
        break;
      case 'parsed': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (p.shared) {
          if (msg.timings) p.shared.timings.unshift(msg.timings);
          p.shared.mainDone = true;
          this.maybeFinish(msg.id, p);
          return;
        }
        this.pending.delete(msg.id);
        p.resolve({ id: msg.id, meshCount: p.meshCount, timings: msg.timings });
        break;
      }
      case 'error': {
        if (msg.id === undefined) {
          // A property-query error (correlated by reqId) — hand off.
          this.extraSink?.(msg);
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        this.endShare(msg.id, p);
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
      case 'shareDone':
        // Only helpers send it.
        break;
    }
  }

  /** A `batch` from any worker taking part in a parse. */
  private onBatchMessage(msg: Extract<FromWorker, { type: 'batch' }>): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    p.meshCount += msg.meshes.length;
    p.loaded += msg.products;
    p.onBatch?.(msg.meshes, { loaded: p.loaded, total: Math.max(p.total, p.loaded) });
  }

  /**
   * The main worker has listed the elements: start the coordinator, give
   * every worker its port to it, and start the helpers with a copy of the
   * file. Helpers start only now, after the main worker's open, because
   * opens in parallel slow each other down and the first geometry with them.
   */
  private startSharing(id: string, p: PendingModel, ids: number[]): void {
    const shared = p.shared!;
    const t0 = performance.now();
    if (shared.cancelled) {
      // Called off before the list arrived: the main worker still waits for
      // a port. Give it one that says "no more" straight away.
      const channel = new MessageChannel();
      channel.port1.postMessage({ type: 'chunk', index: -1, ids: null });
      this.worker.postMessage({ type: 'chunkPort', id, port: channel.port2 }, [channel.port2]);
      return;
    }
    const channels = Array.from({ length: shared.helperCount + 1 }, () => new MessageChannel());
    const coordinator = this.createCoordinator();
    shared.coordinator = coordinator;
    coordinator.onerror = (): void => this.failShare(id, 'chunk coordinator crashed');
    const ports = channels.map((c) => c.port1);
    (coordinator as unknown as { postMessage(m: ToCoordinator, t: Transferable[]): void }).postMessage(
      { type: 'plan', ids, ports },
      ports,
    );
    this.worker.postMessage({ type: 'chunkPort', id, port: channels[MAIN].port2 }, [channels[MAIN].port2]);
    for (let key = 1; key <= shared.helperCount; key++) {
      let helper: WorkerLike;
      try {
        helper = this.createHelper();
      } catch {
        this.tellCoordinator(shared, { type: 'fail', worker: key });
        shared.ended.add(key);
        continue;
      }
      shared.helpers.set(key, helper);
      helper.onmessage = (event): void => this.onHelperMessage(id, key, event.data);
      helper.onerror = (): void => this.helperFailed(id, key);
      // The file is copied to each helper, like to the main worker (see
      // `parseStreaming`); the port is transferred.
      const port = channels[key].port2;
      helper.postMessage({ type: 'share', id, buffer: shared.buffer, port }, [port]);
    }
    p.timeline?.add('main.postShare', performance.now() - t0);
  }

  private onHelperMessage(id: string, key: number, msg: FromWorker): void {
    const p = this.pending.get(id);
    if (!p?.shared || p.shared.ended.has(key)) return;
    switch (msg.type) {
      case 'batch':
        this.onBatchMessage(msg);
        break;
      case 'shareDone':
        if (msg.timings) p.shared.timings.push(msg.timings);
        this.dropHelper(p.shared, key);
        this.maybeFinish(id, p);
        break;
      case 'error':
        this.helperFailed(id, key);
        break;
    }
  }

  /** A helper died or reported an error: its unfinished chunks go to the others. */
  private helperFailed(id: string, key: number): void {
    const p = this.pending.get(id);
    const shared = p?.shared;
    if (!p || !shared || shared.ended.has(key)) return;
    this.tellCoordinator(shared, { type: 'fail', worker: key });
    this.dropHelper(shared, key);
    this.maybeFinish(id, p);
  }

  /** The coordinator itself failed: nothing can be handed out any more. */
  private failShare(id: string, message: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.endShare(id, p);
    p.reject(new Error(message));
  }

  private dropHelper(shared: SharedParse, key: number): void {
    shared.ended.add(key);
    const helper = shared.helpers.get(key);
    shared.helpers.delete(key);
    helper?.terminate();
  }

  private tellCoordinator(shared: SharedParse, msg: ToCoordinator): void {
    shared.coordinator?.postMessage(msg as unknown as ToWorker);
  }

  /**
   * Stop sharing a parse: helpers and coordinator terminated, and the main
   * worker told there is nothing more, so it posts `parsed` with what it has
   * and its queue moves on to whatever comes next (e.g. the model's close).
   */
  private endShare(id: string, p: PendingModel): void {
    const shared = p.shared;
    if (!shared || shared.cancelled) return;
    shared.cancelled = true;
    for (const key of [...shared.helpers.keys()]) this.dropHelper(shared, key);
    for (let key = 1; key <= shared.helperCount; key++) shared.ended.add(key);
    shared.coordinator?.terminate();
    shared.coordinator = null;
    this.worker.postMessage({ type: 'stopShare', id });
  }

  /** A shared parse resolves once the main worker and every helper are done. */
  private maybeFinish(id: string, p: PendingModel): void {
    const shared = p.shared;
    if (!shared || !shared.mainDone) return;
    if (shared.ended.size < shared.helperCount) return;
    this.pending.delete(id);
    shared.coordinator?.terminate();
    shared.coordinator = null;
    const timings = shared.timings.length ? shared.timings.reduce(mergeWorkerTimings) : undefined;
    if (timings) timings.spans['helpers'] = shared.helperCount;
    p.resolve({ id, meshCount: p.meshCount, timings });
  }
}
