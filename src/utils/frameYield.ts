/**
 * Cooperative time-slicer for long synchronous loops on the main thread.
 *
 * Call `await yielder.yieldIfNeeded()` between chunks of work. It returns
 * immediately while still inside the frame budget, and only yields to the
 * event loop once the budget is exceeded — so the browser can paint and
 * stay responsive without paying a yield (and a re-render) on every
 * iteration. A loop that yields every iteration spends most of its time
 * in scheduler overhead; one that yields ~once per frame does not.
 *
 * Yields via `MessageChannel`, deliberately not via:
 *   - `setTimeout(0)` — browsers clamp nested timeouts to ≥4 ms, so a
 *     yield-per-batch loop bleeds milliseconds on every batch.
 *   - `requestAnimationFrame` — rAF pauses in a backgrounded tab, which
 *     would stall a parse the moment the user switches away.
 */
export class FrameYielder {
  private lastYield = performance.now();

  /**
   * @param budgetMs How long synchronous work may run before the next
   *   `yieldIfNeeded()` actually yields. ~32 ms ≈ 30 fps — smooth enough
   *   for a progressive load while keeping scheduler overhead low.
   */
  constructor(private readonly budgetMs = 32) {}

  /**
   * Yield to the event loop if the frame budget has been exceeded since
   * the last yield. Resolves to `true` if it yielded, `false` if it
   * returned without yielding (still inside the budget).
   */
  async yieldIfNeeded(): Promise<boolean> {
    if (performance.now() - this.lastYield < this.budgetMs) return false;
    await yieldToEventLoop();
    this.lastYield = performance.now();
    return true;
  }
}

/**
 * Resolve on the next event-loop task via MessageChannel — a yield with
 * no minimum-delay clamp, so it costs only the event-loop turn itself.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}
