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
 */

import type { FromWorker, ToWorker } from './ifcMessages';
import type { ParsedMesh, ParsedModel, StreamProgress } from './types';

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

/** Per-model in-flight parse / openForProps state. */
interface PendingModel {
  resolve: (model: ParsedModel) => void;
  reject: (err: Error) => void;
  /** Geometry accumulated from `batch` messages (for the resolved ParsedModel). */
  meshes: ParsedMesh[];
  /** Per-batch callback — undefined for `openForProperties` (no geometry). */
  onBatch?: (meshes: ParsedMesh[], progress: StreamProgress) => void;
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

  /**
   * @param worker  Optional injected worker (tests). Defaults to the real
   *                module worker created from `ifcWorker.ts`.
   */
  constructor(worker?: WorkerLike) {
    this.worker = worker ?? createDefaultWorker();
    this.worker.onmessage = (event): void => this.onMessage(event.data);
    this.worker.onerror = (): void => {
      // A worker-level error (not a posted `error` message) would leave
      // every in-flight request hanging. Reject them all and notify
      // listeners (WorkerPropertyRepository) so they can do the same.
      const err = new Error('IFC worker crashed');
      for (const p of this.pending.values()) p.reject(err);
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
   * per worker `batch` message; the returned promise resolves with the
   * full `ParsedModel` (all batches accumulated) so callers that need the
   * complete mesh list — e.g. the geometry cache — work unchanged.
   *
   * The `.ifc` buffer is transferred (not copied) to the worker; the
   * caller must not touch it after this call.
   */
  parseStreaming(
    buffer: ArrayBuffer,
    id: string,
    onBatch: (meshes: ParsedMesh[], progress: StreamProgress) => void,
  ): Promise<ParsedModel> {
    return new Promise<ParsedModel>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, meshes: [], onBatch });
      this.worker.postMessage({ type: 'parse', id, buffer }, [buffer]);
    });
  }

  /**
   * Open a model in the worker for property queries only — no geometry
   * streamed. Used by the geometry-cache fast-restore path. Resolves once
   * the worker posts `parsed`. The `.ifc` buffer is transferred.
   */
  openForProperties(buffer: ArrayBuffer, id: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
        meshes: [],
      });
      this.worker.postMessage({ type: 'openForProps', id, buffer }, [buffer]);
    });
  }

  /** Close a model in the worker and free its per-model caches. */
  disposeModel(id: string): void {
    this.worker.postMessage({ type: 'disposeModel', id });
  }

  /** Tear down the worker: dispose web-ifc, then terminate the thread. */
  dispose(): void {
    this.worker.postMessage({ type: 'dispose' });
    this.worker.terminate();
  }

  // --- internals -------------------------------------------------------------

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'batch': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        for (const m of msg.meshes) p.meshes.push(m);
        p.onBatch?.(msg.meshes, msg.progress);
        break;
      }
      case 'parsed': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        p.resolve({ id: msg.id, meshes: p.meshes });
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
        p.reject(new Error(msg.message));
        break;
      }
      case 'props':
        // Property-query reply — belongs to WorkerPropertyRepository.
        this.extraSink?.(msg);
        break;
    }
  }
}
