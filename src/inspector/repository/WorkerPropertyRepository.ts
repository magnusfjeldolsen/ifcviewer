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
import { intersectProperties as combineIntersections } from '../intersection';
import type { PropertySelector } from '../matchValue';
import type { ElementIdentity, ElementProperties, ModelSchema, PropertyValue } from '../types';
import { BulkRequestCancelled, type ElementPropertyRepository } from './ElementPropertyRepository';

/** Resolve/reject pair for one in-flight `getProps` request. */
interface PendingProps {
  resolve: (props: ElementProperties) => void;
  reject: (err: Error) => void;
}

/** Resolve/reject pair + progress sink for an in-flight `intersect` request. */
interface PendingIntersect {
  resolve: (props: ElementProperties) => void;
  reject: (err: Error) => void;
  /** Per-request progress callback — fires on every `progress` reply. */
  onProgress?: (done: number, total: number) => void;
}

/** Resolve/reject pair + progress sink for an in-flight id-returning request. */
interface PendingIds {
  resolve: (ids: number[]) => void;
  reject: (err: Error) => void;
  onProgress?: (done: number, total: number) => void;
}

export class WorkerPropertyRepository implements ElementPropertyRepository {
  /** Per-model memo: modelId → (expressId → in-flight-or-settled promise). */
  private memo = new Map<string, Map<number, Promise<ElementProperties>>>();
  /** In-flight `getProps` requests, correlated by reqId. */
  private inflight = new Map<number, PendingProps>();
  /** In-flight `intersect` requests, correlated by reqId. */
  private intersectInflight = new Map<number, PendingIntersect>();
  /** In-flight `enumerateIds` / `findMatching` requests, correlated by reqId. */
  private idsInflight = new Map<number, PendingIds>();
  /** Monotonic request id for all property messages (getProps + intersect). */
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
      for (const p of this.intersectInflight.values()) p.reject(err);
      this.intersectInflight.clear();
      for (const p of this.idsInflight.values()) p.reject(err);
      this.idsInflight.clear();
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

  /**
   * Compute the intersection of N elements' properties via the worker.
   *
   * Groups identities by modelId, posts one `intersect` per model, awaits
   * each model's synthetic result, then combines the per-model results
   * with the (now thin) batch `intersectProperties` from `intersection.ts`.
   *
   * Phase 1 of dev/plans/handoff-bulk-property-access.md. Does NOT populate
   * the single-`get()` memo — see "Drill-down trade-off (option a)" in
   * the source-of-truth doc. A subsequent `get()` for any of these
   * elements pays one normal round-trip.
   *
   * `onProgress` aggregates across all models in the selection: the
   * accumulator sums `done` and `total` across models as their progress
   * messages arrive, so the inspector overlay sees a single monotonic
   * counter. Per-model `progress` messages still go through (one model →
   * one counter; N models → summed counter).
   */
  async intersectProperties(
    identities: readonly ElementIdentity[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ElementProperties> {
    if (identities.length === 0) {
      // Mirror the batch `intersectProperties([])` shape — synthesise empty.
      return combineIntersections([]);
    }

    // Group by modelId. Preserve identity order within each model so the
    // fold sees identities in a stable order (matters for materials sample
    // selection and seedRow choice).
    const byModel = new Map<string, number[]>();
    for (const ident of identities) {
      let bucket = byModel.get(ident.modelId);
      if (!bucket) {
        bucket = [];
        byModel.set(ident.modelId, bucket);
      }
      bucket.push(ident.expressId);
    }

    // If there's only one model, fast path: no per-model combine. The
    // worker reduces the whole list and we return its result directly.
    const models = [...byModel.entries()];
    if (models.length === 1) {
      const [modelId, expressIds] = models[0];
      return this.requestIntersect(modelId, expressIds, onProgress);
    }

    // Multi-model: per-model `progress` messages have to be summed across
    // models for the user-visible overlay. Track per-reqId latest progress
    // and re-aggregate on every update.
    const totals = new Map<number, { done: number; total: number }>();
    const perModelProgress = (reqId: number) =>
      (done: number, total: number): void => {
        totals.set(reqId, { done, total });
        if (!onProgress) return;
        let sumDone = 0;
        let sumTotal = 0;
        for (const t of totals.values()) {
          sumDone += t.done;
          sumTotal += t.total;
        }
        onProgress(sumDone, sumTotal);
      };

    // Reserve a reqId per model up front so the progress callbacks know
    // their keys before `requestIntersect` posts.
    const reqIds: number[] = [];
    for (let i = 0; i < models.length; i++) reqIds.push(this.nextReqId++);

    const promises = models.map(([modelId, expressIds], i) => {
      const reqId = reqIds[i];
      totals.set(reqId, { done: 0, total: expressIds.length });
      return this.requestIntersectWithReqId(
        modelId,
        expressIds,
        reqId,
        perModelProgress(reqId),
      );
    });

    const perModel = await Promise.all(promises);
    // Combine the per-model synthetic results. The batch combine handles
    // the cross-model identity collapse and varies logic exactly as
    // before — this is what makes per-model split + final combine
    // semantically identical to a single global reduction.
    return combineIntersections(perModel);
  }

  /**
   * Abandon every in-flight bulk request. Posts one out-of-queue `cancel`
   * per reqId so the worker stops reading at its next chunk boundary, and
   * settles the local promises immediately with `BulkRequestCancelled` —
   * we don't wait for the worker to acknowledge, because the caller has
   * already moved on and the worker deliberately posts nothing when it
   * bails.
   */
  cancelBulk(): void {
    const reqIds = [...this.intersectInflight.keys(), ...this.idsInflight.keys()];
    if (reqIds.length === 0) return;

    for (const reqId of reqIds) {
      const intersect = this.intersectInflight.get(reqId);
      if (intersect) {
        this.intersectInflight.delete(reqId);
        intersect.reject(new BulkRequestCancelled());
      }
      const ids = this.idsInflight.get(reqId);
      if (ids) {
        this.idsInflight.delete(reqId);
        ids.reject(new BulkRequestCancelled());
      }
      this.parser.getWorker().postMessage({ type: 'cancel', reqId });
    }
  }

  disposeModel(modelId: string): void {
    this.memo.delete(modelId);
    // Tell the worker to close the model and free its unit-table cache.
    this.parser.disposeModel(modelId);
  }

  async enumerateExpressIds(modelId: string, ifcType?: number): Promise<number[]> {
    const reqId = this.nextReqId++;
    const reply = this.trackIds(reqId);
    this.parser.getWorker().postMessage({ type: 'enumerateIds', reqId, id: modelId, ifcType });
    return reply;
  }

  async findMatching(
    modelId: string,
    ifcType: number | null,
    selector: PropertySelector,
    value: PropertyValue,
    onProgress?: (done: number, total: number) => void,
  ): Promise<number[]> {
    const reqId = this.nextReqId++;
    const reply = this.trackIds(reqId, onProgress);
    this.parser.getWorker().postMessage({
      type: 'findMatching',
      reqId,
      id: modelId,
      ifcType,
      selector,
      value,
    });
    return reply;
  }

  async describeSchema(modelId: string): Promise<ModelSchema> {
    void modelId;
    throw new Error('describeSchema: not implemented yet');
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

  /**
   * Post an `intersect` message and return a promise for its `intersection`
   * reply. Allocates a fresh reqId — used for the single-model fast path.
   */
  private requestIntersect(
    modelId: string,
    expressIds: number[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ElementProperties> {
    const reqId = this.nextReqId++;
    return this.requestIntersectWithReqId(modelId, expressIds, reqId, onProgress);
  }

  /**
   * Variant that uses a caller-supplied reqId — used by the multi-model path
   * which reserves reqIds up front so the progress aggregator can key by
   * reqId before the worker has even started replying.
   */
  private requestIntersectWithReqId(
    modelId: string,
    expressIds: number[],
    reqId: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<ElementProperties> {
    return new Promise<ElementProperties>((resolve, reject) => {
      this.intersectInflight.set(reqId, { resolve, reject, onProgress });
      this.parser.getWorker().postMessage({
        type: 'intersect',
        reqId,
        id: modelId,
        expressIds,
      });
    });
  }

  /**
   * Register interest in the `ids` reply for `reqId` and return the promise
   * for it. Callers post their own message literal so each one is checked
   * against `ToWorker` — spreading a union payload through a shared poster
   * would need a cast and lose exactly that check.
   *
   * Registration happens before the caller posts, so a reply can never
   * arrive before there is somewhere to deliver it.
   */
  private trackIds(
    reqId: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<number[]> {
    return new Promise<number[]>((resolve, reject) => {
      this.idsInflight.set(reqId, { resolve, reject, onProgress });
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
    if (msg.type === 'intersection') {
      const pending = this.intersectInflight.get(msg.reqId);
      if (!pending) return;
      this.intersectInflight.delete(msg.reqId);
      pending.resolve(msg.props);
      return;
    }
    if (msg.type === 'ids') {
      const pending = this.idsInflight.get(msg.reqId);
      if (!pending) return;
      this.idsInflight.delete(msg.reqId);
      pending.resolve(msg.ids);
      return;
    }
    if (msg.type === 'progress') {
      // One generic progress message serves every bulk primitive, so look
      // in both in-flight maps.
      const pending = this.intersectInflight.get(msg.reqId) ?? this.idsInflight.get(msg.reqId);
      if (!pending) return;
      pending.onProgress?.(msg.done, msg.total);
      return;
    }
    if (msg.type === 'error' && msg.reqId !== undefined) {
      const pending = this.inflight.get(msg.reqId);
      if (pending) {
        this.inflight.delete(msg.reqId);
        pending.reject(new Error(msg.message));
        return;
      }
      const pendingIntersect = this.intersectInflight.get(msg.reqId);
      if (pendingIntersect) {
        this.intersectInflight.delete(msg.reqId);
        pendingIntersect.reject(new Error(msg.message));
        return;
      }
      const pendingIds = this.idsInflight.get(msg.reqId);
      if (pendingIds) {
        this.idsInflight.delete(msg.reqId);
        pendingIds.reject(new Error(msg.message));
      }
    }
  }
}
