/**
 * Typed message protocol between the main thread and the IFC worker
 * (`ifcWorker.ts`). Imported by the worker and by the two main-thread
 * proxies (`WorkerIfcParser`, `WorkerPropertyRepository`).
 *
 * Correlation:
 *  - model-scoped ops (`parse`, `openForProps`, `disposeModel`) carry the
 *    app-UUID `id`;
 *  - property queries carry a monotonic `reqId`.
 *
 * Every worker failure path MUST post an `error` reply carrying the same
 * correlation key — otherwise a main-thread `await` hangs forever.
 *
 * Transferables: the sender transfers (not copies) the backing
 * `ArrayBuffer` of every typed array — the `.ifc` bytes in `parse` /
 * `openForProps`, and the vertices / normals / indices in `batch`. After
 * a buffer is transferred it is neutered; the sender must not touch it.
 */

import type { ElementProperties, PropertyValue } from '../inspector/types';
import type { PropertySelector } from '../inspector/matchValue';
import type { ParsedMesh } from './types';
import type { WorkerTimings } from '../core/LoadTimeline';
import type { CacheWriteReport } from '../services/geometryParts';

// ---------------------------------------------------------------------------
// main → worker
// ---------------------------------------------------------------------------

export type ToWorker =
  /**
   * Parse a model and stream geometry back as `batch` messages. The worker
   * keeps the model open for property queries. With `shared`, other workers
   * stream part of the geometry: this worker lists the elements (`listed`
   * with `ids`), waits for its `chunkPort`, and streams only the chunks the
   * coordinator hands it there.
   */
  | { type: 'parse'; id: string; buffer: ArrayBuffer; shared?: boolean; cacheKey?: string }
  /**
   * The port to the chunk coordinator for a shared parse (transferred).
   * NOT enqueued: the parse that waits for it holds the queue.
   */
  | { type: 'chunkPort'; id: string; port: MessagePort }
  /**
   * Sharing a parse was called off: stop after the chunks already handed
   * out. NOT enqueued, for the same reason as chunkPort.
   */
  | { type: 'stopShare'; id: string }
  /**
   * Help parse a model: open it, stream the chunks the coordinator hands out
   * over `port` (transferred), then close it and say `shareDone`. Geometry
   * only; no property queries. `worker` is its number in the parse (1, 2, …).
   */
  | { type: 'share'; id: string; buffer: ArrayBuffer; port: MessagePort; worker: number; cacheKey?: string }
  /**
   * Open a model for property queries only — no geometry streamed. Used
   * by the geometry-cache fast-restore path: the scene is already up from
   * cached meshes, the worker just needs the STEP graph. `buffer` transferred.
   */
  | { type: 'openForProps'; id: string; buffer: ArrayBuffer }
  /** Fetch normalized properties for one element. */
  | { type: 'getProps'; reqId: number; id: string; expressId: number }
  /**
   * Fold properties of N elements into a single synthetic intersection
   * result. The worker reads each id, runs an incremental fold (O(1)
   * memory in N), and posts ONE `intersection` reply plus throttled
   * `progress` messages along the way. Phase 1 of
   * dev/plans/handoff-bulk-property-access.md.
   */
  | { type: 'intersect'; reqId: number; id: string; expressIds: number[] }
  /**
   * List the expressIds of one IFC type, or of every product when
   * `ifcType` is omitted. Cheap — one `GetLineIDsWithType` call, no
   * property reads. Replies with `ids`.
   *
   * `ifcType` is the NUMERIC type code (`ElementIdentity.ifcTypeCode`), not
   * a class name. web-ifc's `GetTypeCodeFromName` is a hash, not a lookup —
   * it returns a plausible non-zero code for any string, including a
   * mis-cased one, so a name-based API would silently query the wrong type
   * instead of failing. The numeric code comes straight off the element.
   */
  | { type: 'enumerateIds'; reqId: number; id: string; ifcType?: number }
  /**
   * Run a value-match predicate over a candidate set in the worker and
   * reply with the matching expressIds only. `ifcType` null means "all
   * products". The predicate is present-and-equal: a candidate lacking
   * the selector's path is not a match.
   */
  | {
      type: 'findMatching';
      reqId: number;
      id: string;
      ifcType: number | null;
      selector: PropertySelector;
      value: PropertyValue;
    }
  /**
   * Abandon an in-flight bulk job. NEVER enqueued — the worker's
   * `onmessage` handles this synchronously, because the job it cancels is
   * at the head of the queue and would otherwise gate its own cancellation.
   * The running job observes the flag at its next chunk boundary and bails
   * without posting a reply.
   */
  | { type: 'cancel'; reqId: number }
  /**
   * The model's length unit symbol (`"mm"`, `"m"`, …) from its
   * `IfcUnitAssignment`. The scene is always in metres — web-ifc scales on
   * the way out — so this is only for showing numbers in the unit the model
   * was authored in.
   */
  | { type: 'getLengthUnit'; reqId: number; id: string }
  /** Close a model in web-ifc and free its per-model caches. */
  | { type: 'disposeModel'; id: string }
  /** Dispose the whole web-ifc instance. Precedes `worker.terminate()`. */
  | { type: 'dispose' };

// ---------------------------------------------------------------------------
// worker → main
// ---------------------------------------------------------------------------

export type FromWorker =
  /**
   * The elements a `parse` will stream: `total` always, the `ids` themselves
   * for a shared parse (they are what gets handed out in chunks).
   */
  | { type: 'listed'; id: string; total: number; ids?: number[] }
  /**
   * A batch of streamed geometry from `products` more elements. Mesh buffers
   * transferred. A helper sends a chunk's geometry in one batch, right before
   * telling the coordinator the chunk is done: a helper that fails mid-chunk
   * has delivered none of it, and the chunk can be streamed again.
   */
  | { type: 'batch'; id: string; meshes: ParsedMesh[]; products: number }
  /** A `share` worker has posted the geometry of everything it was handed. */
  | { type: 'shareStreamed'; id: string; timings?: WorkerTimings }
  /**
   * A `share` worker is done, its part file flushed and closed (when asked
   * to cache); it can be terminated.
   */
  | { type: 'shareDone'; id: string; cache?: CacheWriteReport }
  /**
   * The main worker's part file for a `parse` with `cacheKey` is flushed and
   * closed (or failed): where its parts are, for the cache's index.
   */
  | { type: 'cacheWritten'; id: string; report: CacheWriteReport }
  /**
   * A `parse` / `openForProps` completed successfully. A `parse` reply
   * carries where the worker's time went (see `LoadTimeline`).
   */
  | { type: 'parsed'; id: string; timings?: WorkerTimings }
  /** A `getProps` completed successfully. */
  | { type: 'props'; reqId: number; props: ElementProperties }
  /**
   * Throttled progress for a long-running property reduction (currently
   * `intersect`; reused by future `findMatching` / aggregate). Per-chunk,
   * not per-element; `done` is monotonic and ends at `total`.
   */
  | { type: 'progress'; reqId: number; done: number; total: number }
  /** A `intersect` reduction completed successfully — single synthetic result. */
  | { type: 'intersection'; reqId: number; props: ElementProperties }
  /**
   * An `enumerateIds` / `findMatching` completed successfully. Ids only —
   * the whole point of running the predicate in the worker is that a 50k
   * candidate set never ships its properties across the boundary.
   */
  | { type: 'ids'; reqId: number; ids: number[] }
  /** A `getLengthUnit` completed. `symbol` is `"m"` when the model names none. */
  | { type: 'lengthUnit'; reqId: number; symbol: string }
  /**
   * A request failed. Exactly one correlation key is set: `id` for a
   * model-scoped op, `reqId` for a property query.
   */
  | { type: 'error'; id?: string; reqId?: number; message: string };

// ---------------------------------------------------------------------------
// shared parse: chunk coordinator (chunkCoordinatorWorker.ts)
// ---------------------------------------------------------------------------

/** Coordinator → geometry worker, over the worker's chunk port. `ids: null`: no more. */
export type ToChunkPort = { type: 'chunk'; index: number; ids: number[] | null };

/** Geometry worker → coordinator: ready for chunks, or chunk `index` delivered. */
export type FromChunkPort = { type: 'ready' } | { type: 'done'; index: number };

/** Main thread → coordinator. Port `k` belongs to worker `k`; 0 is the main worker. */
export type ToCoordinator =
  | { type: 'plan'; ids: number[]; ports: MessagePort[] }
  /** Worker `worker` is gone; its unfinished chunks go to the others. */
  | { type: 'fail'; worker: number }
  /** Stop: every worker still listening hears there is no more. */
  | { type: 'end' };
