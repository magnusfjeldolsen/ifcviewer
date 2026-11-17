/**
 * Hands out a model's elements to the workers streaming its geometry.
 *
 * When a model is parsed by more than one worker, every worker opens the same
 * file and streams a share of its elements. Shares are not fixed up front:
 * the first worker starts while the helpers are still opening the file, and
 * elements differ wildly in cost, so a fixed split would leave workers idle.
 * Instead each worker takes a **chunk** of element ids at a time, and comes
 * back for more.
 *
 * Chunks shrink as the list runs out (guided self-scheduling: a fraction of
 * what is left per worker), so early chunks are big enough to keep message
 * traffic low and the last ones small enough that no worker is left with a
 * long tail while the others wait.
 *
 * A worker that fails gives its unfinished chunks back, and another worker
 * streams them. Nothing is lost and nothing is streamed twice, provided a
 * worker only delivers a chunk's geometry together with its completion.
 */

export interface Chunk {
  index: number;
  ids: number[];
}

export interface ChunkPlanOptions {
  /** How many workers share the list; sizes chunks. */
  workers: number;
  /** Smallest chunk handed out while the list is long enough. */
  minChunk?: number;
  /** Largest chunk handed out. */
  maxChunk?: number;
  /** Chunks per worker the remainder is cut into (bigger: smaller chunks). */
  divisor?: number;
}

export class ChunkPlan {
  private next = 0;
  private nextIndex = 0;
  /** Chunks given back by a failed worker; handed out before new ones. */
  private returned: Chunk[] = [];
  /** Outstanding chunks per worker key. */
  private outstanding = new Map<number, Map<number, Chunk>>();
  private readonly minChunk: number;
  private readonly maxChunk: number;
  private readonly divisor: number;

  constructor(
    private readonly ids: readonly number[],
    private readonly options: ChunkPlanOptions,
  ) {
    this.minChunk = options.minChunk ?? 8;
    this.maxChunk = options.maxChunk ?? 512;
    this.divisor = options.divisor ?? 4;
  }

  /** The next chunk for `worker`, or null when there is nothing left to hand out. */
  take(worker: number): Chunk | null {
    let chunk = this.returned.shift() ?? null;
    if (!chunk) {
      const left = this.ids.length - this.next;
      if (left <= 0) return null;
      const guided = Math.ceil(left / (Math.max(1, this.options.workers) * this.divisor));
      const size = Math.min(left, Math.max(this.minChunk, Math.min(this.maxChunk, guided)));
      chunk = { index: this.nextIndex++, ids: this.ids.slice(this.next, this.next + size) };
      this.next += size;
    }
    let mine = this.outstanding.get(worker);
    if (!mine) {
      mine = new Map();
      this.outstanding.set(worker, mine);
    }
    mine.set(chunk.index, chunk);
    return chunk;
  }

  /** `worker` has delivered chunk `index`. */
  done(worker: number, index: number): void {
    this.outstanding.get(worker)?.delete(index);
  }

  /** `worker` is gone: its unfinished chunks go back to be handed out again. */
  fail(worker: number): void {
    const mine = this.outstanding.get(worker);
    if (!mine) return;
    this.returned.push(...[...mine.values()].sort((a, b) => a.index - b.index));
    this.outstanding.delete(worker);
  }

  /** Nothing left to hand out (some chunks may still be in flight). */
  get drained(): boolean {
    return this.returned.length === 0 && this.next >= this.ids.length;
  }

  /** Every chunk has been delivered. */
  get finished(): boolean {
    if (!this.drained) return false;
    for (const mine of this.outstanding.values()) if (mine.size > 0) return false;
    return true;
  }

  /** Chunks `worker` holds and has not delivered. */
  outstandingFor(worker: number): number {
    return this.outstanding.get(worker)?.size ?? 0;
  }
}
