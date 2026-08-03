/**
 * Repository abstraction for element properties.
 *
 * Decouples the inspector UI from the underlying IFC engine. v1's
 * concrete impl is `WebIfcPropertyRepository`; future variants could
 * proxy a worker, cache to IndexedDB, or back onto a different engine.
 */

import type { ElementIdentity, ElementProperties, ModelSchema } from '../types';

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

  /** Free memoized results and any per-model state (e.g. unit table). */
  disposeModel(modelId: string): void;

  // -------------------------------------------------------------------------
  // Future hooks. Stubbed in Phase 1 — concrete impls may throw `not yet
  // implemented` until the downstream consumers (filter UI, aggregation)
  // land in later phases.
  // -------------------------------------------------------------------------

  /** Lazily iterate over all expressIds of a given class. */
  enumerateExpressIds(modelId: string, ifcClass?: string): AsyncIterable<number>;

  /** Summarize the schema of a loaded model (class counts, etc.). */
  describeSchema(modelId: string): Promise<ModelSchema>;
}
