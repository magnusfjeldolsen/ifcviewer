/**
 * Repository abstraction for element properties.
 *
 * Decouples the inspector UI from the underlying IFC engine. v1's
 * concrete impl is `WebIfcPropertyRepository`; future variants could
 * proxy a worker, cache to IndexedDB, or back onto a different engine.
 */

import type { PropertySelector } from '../matchValue';
import type { ElementIdentity, ElementProperties, ModelSchema, PropertyValue } from '../types';

/**
 * Rejection reason for a bulk request the caller abandoned via
 * `cancelBulk()`. A distinct type so callers can tell "you asked me to stop"
 * apart from a genuine failure and skip the error UI — the user changing
 * their selection is not an error.
 */
export class BulkRequestCancelled extends Error {
  constructor() {
    super('Bulk request cancelled');
    this.name = 'BulkRequestCancelled';
  }
}

export interface ElementPropertyRepository {
  /**
   * Fetch properties for a single element. Results are memoized per
   * `(modelId, expressId)` so repeated calls are cheap. Concurrent
   * calls for the same key share a single in-flight promise.
   */
  get(modelId: string, expressId: number): Promise<ElementProperties>;

  /**
   * Compute the intersection of properties across N elements and return
   * a single synthetic `ElementProperties`. The reduction runs in the
   * worker (O(1) memory in N) and only the small result crosses the
   * thread boundary. `onProgress` is called with monotonic `done` / `total`
   * counters for the live overlay; intermediate values are throttled.
   *
   * Does NOT populate the single-`get()` memo — drill-down clicks after a
   * bulk intersection pay one round-trip per click (milliseconds). Phase 1
   * of dev/plans/handoff-bulk-property-access.md.
   */
  intersectProperties(
    identities: readonly ElementIdentity[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<ElementProperties>;

  /**
   * Abort or simply ignore the result of a queued fetch. Implementations
   * may treat this as a no-op (in which case the fetch still runs and
   * its result is cached for next time).
   */
  cancel(modelId: string, expressId: number): void;

  /**
   * Abandon every in-flight bulk request (`intersectProperties` /
   * `findMatching`). Their promises reject with `BulkRequestCancelled` and
   * the worker stops reading at its next chunk boundary.
   *
   * Unlike `cancel`, this is not advisory: a superseded bulk job would
   * otherwise keep the worker's serial queue busy and block the property
   * reads the user is now waiting on. Callers starting a new bulk request
   * should cancel the previous one first.
   */
  cancelBulk(): void;

  /** Free memoized results and any per-model state (e.g. unit table). */
  disposeModel(modelId: string): void;

  /**
   * List the expressIds of one IFC type, or of every product when `ifcType`
   * is omitted. Backed by one `GetLineIDsWithType` call in the worker — no
   * property reads, so it stays cheap on large models.
   *
   * `ifcType` is the numeric `ElementIdentity.ifcTypeCode`. Names are
   * deliberately not accepted: web-ifc's `GetTypeCodeFromName` hashes rather
   * than looks up, so a name API would answer confidently with the wrong
   * type.
   */
  enumerateExpressIds(modelId: string, ifcType?: number): Promise<number[]>;

  /**
   * Find the elements of `ifcType` (or across every product when null)
   * whose property at `selector.path` equals `value`, and return their
   * expressIds.
   *
   * The predicate runs in the worker, so only the matching ids cross the
   * thread boundary — a 50 000-element class never ships its properties to
   * the main thread. Matching is present-and-equal: an element without a
   * row at that path is not a match. `onProgress` reports throttled
   * `done` / `total` counters over the candidate set.
   */
  findMatching(
    modelId: string,
    ifcType: number | null,
    selector: PropertySelector,
    value: PropertyValue,
    onProgress?: (done: number, total: number) => void,
  ): Promise<number[]>;

  // -------------------------------------------------------------------------
  // Future hooks. Stubbed — concrete impls may throw `not yet implemented`
  // until the downstream consumers (filter UI, aggregation) land.
  // -------------------------------------------------------------------------

  /** Summarize the schema of a loaded model (class counts, etc.). */
  describeSchema(modelId: string): Promise<ModelSchema>;
}
