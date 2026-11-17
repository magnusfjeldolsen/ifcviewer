/**
 * Decides when the worker sends what it has streamed so far.
 *
 * web-ifc's `StreamAllMeshes` cannot be paused, so the worker gathers pieces
 * inside the callback and posts them in batches. A batch goes out when it
 * holds `maxProducts` products **or** when `maxIntervalMs` has passed since
 * the last one, whichever comes first. The count keeps the message rate sane
 * on a model of small elements; the clock gets the first geometry on screen
 * after a fraction of a second instead of after the first 200 products, which
 * on a model of heavy elements took seconds.
 *
 * The check runs at product boundaries only: a single product that takes a
 * long time still goes out whole.
 */
export interface StreamBatcherOptions {
  maxProducts: number;
  maxIntervalMs: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export class StreamBatcher<T> {
  private pending: T[] = [];
  private productsInBatch = 0;
  private loaded = 0;
  private lastFlushAt: number;
  private readonly now: () => number;

  constructor(
    private readonly send: (items: T[], loaded: number) => void,
    private readonly options: StreamBatcherOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
    this.lastFlushAt = this.now();
  }

  /** Where one product's pieces go; call `endProduct` once they are in. */
  get sink(): T[] {
    return this.pending;
  }

  /** One more product is complete. Sends the batch if it is due. */
  endProduct(): void {
    this.loaded++;
    this.productsInBatch++;
    if (
      this.productsInBatch >= this.options.maxProducts ||
      this.now() - this.lastFlushAt >= this.options.maxIntervalMs
    ) {
      this.flush();
    }
  }

  /** Send whatever is left. Call once, after the stream ends. */
  flush(): void {
    this.lastFlushAt = this.now();
    this.productsInBatch = 0;
    if (this.pending.length === 0) return;
    const items = this.pending;
    this.pending = [];
    this.send(items, this.loaded);
  }

  /** Products seen so far. */
  get productCount(): number {
    return this.loaded;
  }
}
