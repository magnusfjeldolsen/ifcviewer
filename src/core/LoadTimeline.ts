/**
 * Where the time of one model load goes, phase by phase, on both threads.
 *
 * A load crosses two threads: the main thread reads the file, hands it to the
 * IFC worker, and builds the scene from the batches the worker sends back. To
 * say which phase is slow, both sides stamp the same timeline. The worker's
 * `performance.now()` counts from a different origin than the page's, so the
 * worker reports wall-clock times (`timeOrigin + now()`) and `absorbWorker`
 * moves them onto this timeline.
 *
 * Two kinds of entry:
 *  - a **mark** is a moment, kept as ms since the timeline started. The first
 *    write of a name wins, so "first batch" stays the first one.
 *  - a **span** is time spent, summed over every call: the main thread
 *    appends ~40 batches, and the total is what matters.
 *
 * It costs a `performance.now()` per entry, so it runs on every load, not only
 * under `?stats`; the `?stats` surface is just where it is read.
 */

/** A finished timeline, as published on `window.__ifcPerf.loads[i].phases`. */
export interface LoadPhases {
  /** `performance.now()` on the page when the timeline started. */
  startedAt: number;
  /** ms from `startedAt` to each mark, in the order they were first set. */
  marks: Record<string, number>;
  /** Total ms spent in each named activity. */
  spans: Record<string, number>;
}

/**
 * The worker's side of a parse, sent with its `parsed` reply. Marks are
 * wall-clock ms (`performance.timeOrigin + performance.now()` in the worker),
 * so they can be placed on the page's clock.
 */
export interface WorkerTimings {
  marks: Record<string, number>;
  spans: Record<string, number>;
}

/**
 * Two workers' reports as one: the earlier of each mark (the first helper to
 * open is when helping started), and spans added up (CPU time across them).
 */
export function mergeWorkerTimings(a: WorkerTimings, b: WorkerTimings): WorkerTimings {
  const marks = { ...a.marks };
  for (const [name, at] of Object.entries(b.marks)) marks[name] = Math.min(marks[name] ?? Infinity, at);
  const spans = { ...a.spans };
  for (const [name, ms] of Object.entries(b.spans)) spans[name] = (spans[name] ?? 0) + ms;
  return { marks, spans };
}

/** Wall-clock now, comparable across threads. */
export function wallNow(): number {
  return performance.timeOrigin + performance.now();
}

export class LoadTimeline {
  private marks: Record<string, number> = {};
  private spans: Record<string, number> = {};

  constructor(readonly startedAt: number = performance.now()) {}

  /** Record a moment (page `performance.now()`); the first write of a name wins. */
  mark(name: string, at: number = performance.now()): void {
    if (!(name in this.marks)) this.marks[name] = at - this.startedAt;
  }

  /** Add `ms` to the span called `name`. */
  add(name: string, ms: number): void {
    this.spans[name] = (this.spans[name] ?? 0) + ms;
  }

  /** Run `fn`, adding how long it took to the span called `name`. */
  time<T>(name: string, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.add(name, performance.now() - t0);
    }
  }

  /** Place the worker's marks on this timeline and take its spans as they are. */
  absorbWorker(worker: WorkerTimings | undefined): void {
    if (!worker) return;
    for (const [name, wall] of Object.entries(worker.marks)) {
      this.mark(name, wall - performance.timeOrigin);
    }
    for (const [name, ms] of Object.entries(worker.spans)) this.add(name, ms);
  }

  toJSON(): LoadPhases {
    return { startedAt: this.startedAt, marks: { ...this.marks }, spans: { ...this.spans } };
  }
}

/**
 * The worker's half: the same mark/span vocabulary, stamped in wall-clock
 * time so the page can line it up with its own.
 */
export class WorkerTimeline {
  private marks: Record<string, number> = {};
  private spans: Record<string, number> = {};

  mark(name: string): void {
    if (!(name in this.marks)) this.marks[name] = wallNow();
  }

  add(name: string, ms: number): void {
    this.spans[name] = (this.spans[name] ?? 0) + ms;
  }

  toJSON(): WorkerTimings {
    return { marks: { ...this.marks }, spans: { ...this.spans } };
  }
}
