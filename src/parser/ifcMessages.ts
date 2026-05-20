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

import type { ElementProperties } from '../inspector/types';
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
   * A request failed. Exactly one correlation key is set: `id` for a
   * model-scoped op, `reqId` for a property query.
   */
  | { type: 'error'; id?: string; reqId?: number; message: string };
