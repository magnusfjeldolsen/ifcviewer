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
import type { ParsedMesh, StreamProgress } from './types';

// ---------------------------------------------------------------------------
// main → worker
// ---------------------------------------------------------------------------

export type ToWorker =
  /** Parse a model and stream geometry back as `batch` messages. `buffer` transferred. */
  | { type: 'parse'; id: string; buffer: ArrayBuffer }
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
   * List the expressIds of one class, or of every product when `ifcClass`
   * is omitted. Cheap — one `GetLineIDsWithType` call, no property reads.
   * Replies with `ids`.
   */
  | { type: 'enumerateIds'; reqId: number; id: string; ifcClass?: string }
  /**
   * Run a value-match predicate over a candidate set in the worker and
   * reply with the matching expressIds only. `ifcClass` null means "all
   * products". The predicate is present-and-equal: a candidate lacking
   * the selector's path is not a match.
   */
  | {
      type: 'findMatching';
      reqId: number;
      id: string;
      ifcClass: string | null;
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
  /** Close a model in web-ifc and free its per-model caches. */
  | { type: 'disposeModel'; id: string }
  /** Dispose the whole web-ifc instance. Precedes `worker.terminate()`. */
  | { type: 'dispose' };

// ---------------------------------------------------------------------------
// worker → main
// ---------------------------------------------------------------------------

export type FromWorker =
  /** A batch of streamed geometry. Mesh buffers transferred. */
  | { type: 'batch'; id: string; meshes: ParsedMesh[]; progress: StreamProgress }
  /** A `parse` / `openForProps` completed successfully. */
  | { type: 'parsed'; id: string }
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
  /**
   * A request failed. Exactly one correlation key is set: `id` for a
   * model-scoped op, `reqId` for a property query.
   */
  | { type: 'error'; id?: string; reqId?: number; message: string };
