/**
 * The IFC worker's one-job-at-a-time queue.
 *
 * web-ifc is single-threaded and not re-entrant, and an `await` inside a
 * handler would let the next message interleave, so every request runs
 * through `enqueue`: one completes fully before the next starts.
 *
 * `enqueueBackground` is for work nobody is waiting on (parameter
 * discovery). It runs as a series of short steps, and each next step joins
 * the END of the queue, after a macrotask yield. A message that arrived
 * while a step ran — a property click, a select-similar, a new parse — has
 * been enqueued by then, so it runs before the next step. A background job
 * therefore delays a user's request by at most one step, never by the whole
 * job, which is the difference from the bulk reads (`readProps`) that hold
 * the queue until they finish.
 */

export type Work = () => Promise<void>;

/** Schedule `fn` as a new macrotask. A test can pass its own. */
export type YieldTask = (fn: () => void) => void;

const yieldWithTimeout: YieldTask = (fn) => {
  setTimeout(fn, 0);
};

export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly yieldTask: YieldTask = yieldWithTimeout) {}

  /** Run `work` after everything already queued. A rejection does not stop the queue. */
  enqueue(work: Work): void {
    this.tail = this.tail.then(work, work);
  }

  /**
   * Run a background job as steps. `step` returns true while there is more
   * to do; the next step is queued behind whatever arrived meanwhile. A
   * step that throws ends the job and is reported to `onError`.
   */
  enqueueBackground(step: () => Promise<boolean>, onError: (err: unknown) => void): void {
    const run = async (): Promise<void> => {
      let more: boolean;
      try {
        more = await step();
      } catch (err) {
        onError(err);
        return;
      }
      if (more) this.yieldTask(() => this.enqueue(run));
    };
    this.enqueue(run);
  }

  /** Settles once everything queued so far has run (tests). */
  idle(): Promise<void> {
    return this.tail;
  }
}
