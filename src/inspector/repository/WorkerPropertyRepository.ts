/**
 * `ElementPropertyRepository` implementation backed by the IFC worker.
 *
 * All web-ifc property work runs in the worker (`ifcWorker.ts`) — this
 * class is a thin main-thread proxy. It:
 *  - memoizes results per `(modelId, expressId)` so repeated inspector
 *    clicks never round-trip;
 *  - on a memo miss, posts a `getProps` message correlated by a monotonic
 *    `reqId`, and awaits the matching `props` reply;
 *  - on `disposeModel`, clears the memo AND posts `disposeModel` so the
 *    worker frees its per-model unit-table cache.
 *
 * It does NOT serialize requests or own numeric web-ifc ids — the worker
 * does both (decisions 1 & 2 of the `web-worker-parse` plan). This
 * replaces the deleted `WebIfcPropertyRepository`.
 *
 * The worker is shared with `WorkerIfcParser`; we receive `props` /
 * property-`error` messages through its `setExtraMessageSink` hook.
 */

import type { WorkerIfcParser } from '../../parser/WorkerIfcParser';
import type { FromWorker } from '../../parser/ifcMessages';
import type { ElementProperties, ModelSchema } from '../types';
import type { ElementPropertyRepository } from './ElementPropertyRepository';

/** Resolve/reject pair for one in-flight `getProps` request. */
interface PendingProps {
  resolve: (props: ElementProperties) => void;
  reject: (err: Error) => void;
}

export class WorkerPropertyRepository implements ElementPropertyRepository {
  /** Per-model memo: modelId → (expressId → in-flight-or-settled promise). */
  private memo = new Map<string, Map<number, Promise<ElementProperties>>>();
  /** In-flight worker requests, correlated by reqId. */
  private inflight = new Map<number, PendingProps>();
  /** Monotonic request id for `getProps` messages. */
  private nextReqId = 1;

  constructor(private parser: WorkerIfcParser) {
    // Receive `props` / property-scoped `error` messages over the shared
    // worker. `WorkerIfcParser` owns the single `onmessage` and forwards
    // anything that is not a geometry-path message here.
    this.parser.setExtraMessageSink((msg) => this.onMessage(msg));
    // If the worker thread crashes, reject everything still waiting —
    // otherwise a `get()` await hangs forever.
    this.parser.onCrash(() => {
      const err = new Error('IFC worker crashed');
      for (const p of this.inflight.values()) p.reject(err);
      this.inflight.clear();
      // Drop the memo too: its promises may be unsettled and the worker
      // state behind them is gone.
      this.memo.clear();
    });
  }

  async get(modelId: string, expressId: number): Promise<ElementProperties> {
    let perModel = this.memo.get(modelId);
    if (!perModel) {
      perModel = new Map();
      this.memo.set(modelId, perModel);
    }
    const cached = perModel.get(expressId);
    if (cached) return cached;

    const promise = this.request(modelId, expressId);
    perModel.set(expressId, promise);
    // A rejected fetch should not poison the memo — drop the entry so a
    // later click retries instead of replaying the failure forever.
    promise.catch(() => {
      const m = this.memo.get(modelId);
      if (m && m.get(expressId) === promise) m.delete(expressId);
    });
    return promise;
  }

  cancel(modelId: string, expressId: number): void {
    // No-op: in-flight fetches are cheap and their results are useful next
    // time. Mirrors the old WebIfcPropertyRepository.cancel.
    void modelId;
    void expressId;
  }

  disposeModel(modelId: string): void {
    this.memo.delete(modelId);
    // Tell the worker to close the model and free its unit-table cache.
    this.parser.disposeModel(modelId);
  }

  // eslint-disable-next-line require-yield
  async *enumerateExpressIds(modelId: string, ifcClass?: string): AsyncIterable<number> {
    void modelId;
    void ifcClass;
    throw new Error('enumerateExpressIds: not implemented in Phase 1');
  }

  async describeSchema(modelId: string): Promise<ModelSchema> {
    void modelId;
    throw new Error('describeSchema: not implemented in Phase 1');
  }

  // --- internals -------------------------------------------------------------

  /** Post a `getProps` message and return a promise for its `props` reply. */
  private request(modelId: string, expressId: number): Promise<ElementProperties> {
    const reqId = this.nextReqId++;
    return new Promise<ElementProperties>((resolve, reject) => {
      this.inflight.set(reqId, { resolve, reject });
      this.parser.getWorker().postMessage({
        type: 'getProps',
        reqId,
        id: modelId,
        expressId,
      });
    });
  }

  /** Handle a `props` / property-`error` message forwarded by WorkerIfcParser. */
  private onMessage(msg: FromWorker): void {
    if (msg.type === 'props') {
      const pending = this.inflight.get(msg.reqId);
      if (!pending) return;
      this.inflight.delete(msg.reqId);
      pending.resolve(msg.props);
      return;
    }
    if (msg.type === 'error' && msg.reqId !== undefined) {
      const pending = this.inflight.get(msg.reqId);
      if (!pending) return;
      this.inflight.delete(msg.reqId);
      pending.reject(new Error(msg.message));
    }
  }
}
