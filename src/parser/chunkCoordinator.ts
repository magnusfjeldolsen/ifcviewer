/**
 * Hands out chunks of a shared parse to the workers streaming it.
 *
 * Runs in a small worker of its own (`chunkCoordinatorWorker.ts`), talking to
 * each geometry worker over a `MessagePort`. It used to run on the main
 * thread, and the workers spent a third of their time waiting for it: the
 * main thread is busy appending the very geometry they deliver, and a chunk
 * request queued behind a 300 ms append is a worker idle for 300 ms. Here the
 * event loop does nothing else, so a request is answered at once.
 *
 * Each worker asks for `PREFETCH_CHUNKS` when it is ready, and one more each
 * time it finishes one. A chunk is **delivered** only when the main thread
 * says its geometry has arrived there (`received`) — not when the worker says
 * it is done with it, because a worker can die between the two, and the two
 * messages travel by different routes. That makes a failed worker's chunks
 * exactly the ones the main thread never got: handed out again, nothing lost,
 * nothing drawn twice. When every chunk is delivered, every worker still
 * listening is told there is no more (`ids: null`), exactly once.
 */

import { ChunkPlan } from './chunkPlan';
import type { FromChunkPort, ToChunkPort } from './ifcMessages';

/** Chunks a worker asks for when it is ready: one to stream, one waiting. */
export const PREFETCH_CHUNKS = 2;

/** The bit of `MessagePort` the coordinator uses (tests pass fakes). */
export interface ChunkPortLike {
  postMessage(msg: ToChunkPort): void;
}

export class ChunkCoordinator {
  private plan: ChunkPlan;
  /** Workers with a request the plan could not serve yet. */
  private parked = new Set<number>();
  /** Workers told there is nothing more, or gone. */
  private stopped = new Set<number>();

  constructor(ids: readonly number[], private readonly ports: readonly ChunkPortLike[]) {
    this.plan = new ChunkPlan(ids, { workers: ports.length });
    this.settle();
  }

  /** A message from worker `key`'s port: ready for chunks, or done with one and ready for the next. */
  receive(key: number, msg: FromChunkPort): void {
    this.serve(key, msg.type === 'ready' ? PREFETCH_CHUNKS : 1);
  }

  /** The main thread has the geometry of chunk `index` from worker `key`. */
  received(key: number, index: number): void {
    this.plan.done(key, index);
    this.settle();
  }

  /** Worker `key` is gone: its unfinished chunks go to the others. */
  fail(key: number): void {
    this.plan.fail(key);
    this.parked.delete(key);
    this.stopped.add(key);
    this.settle();
  }

  /** Stop handing out: every worker still listening hears there is no more. */
  end(): void {
    this.plan = new ChunkPlan([], { workers: 1 });
    this.parked.clear();
    for (let key = 0; key < this.ports.length; key++) this.stop(key);
  }

  private serve(key: number, count: number): void {
    if (this.stopped.has(key)) return;
    for (let i = 0; i < count; i++) {
      const chunk = this.plan.take(key);
      if (!chunk) {
        this.parked.add(key);
        break;
      }
      this.ports[key].postMessage({ type: 'chunk', index: chunk.index, ids: chunk.ids });
    }
    this.settle();
  }

  /** Give returned chunks to parked workers; once all is delivered, stop everyone. */
  private settle(): void {
    for (const key of [...this.parked]) {
      const chunk = this.plan.take(key);
      if (!chunk) break;
      this.parked.delete(key);
      this.ports[key].postMessage({ type: 'chunk', index: chunk.index, ids: chunk.ids });
    }
    if (!this.plan.finished) return;
    for (let key = 0; key < this.ports.length; key++) this.stop(key);
  }

  private stop(key: number): void {
    if (this.stopped.has(key)) return;
    this.stopped.add(key);
    this.parked.delete(key);
    this.ports[key].postMessage({ type: 'chunk', index: -1, ids: null });
  }
}
