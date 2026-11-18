/**
 * Parameter discovery in the IFC worker: which parameters exist across a
 * model's elements (#67).
 *
 * Not a second walker over the model. Every element is read through the
 * same cached per-element path the inspector uses (`host.read`), and its
 * flat rows are folded by `ParameterFold`. What makes it safe to run while
 * someone is using the viewer is the scheduling:
 *
 *  - **Background steps.** A job reads `chunkSize` elements per step, and
 *    each next step joins the end of the worker's queue
 *    (`SerialQueue.enqueueBackground`). A property click, a select-similar or
 *    a new parse that arrives meanwhile runs before the next step.
 *  - **Bound to one open model.** The first step binds the job to the
 *    model's web-ifc id. Before every step the model must still be open with
 *    that id; if it was closed or replaced, the job stops and its callers get
 *    an error. `drop` stops it straight away.
 *  - **Lazy and cached.** Nothing runs until asked. The description is kept
 *    per model and dropped with the model, together with its property cache.
 *    Asking again while a job runs joins that job.
 *
 * The same steps build a value column (`requestColumn`): one parameter's
 * value for every element of the scope, sent back in typed arrays that are
 * transferred, not copied. Columns are kept on the main thread, not here.
 */

import { ParameterFold } from '../inspector/parameterFold';
import { ColumnBuilder, columnTransferables, type ColumnData } from '../inspector/parameterColumn';
import type { ElementProperties, ModelParameters } from '../inspector/types';
import type { FromWorker } from './ifcMessages';
import type { SerialQueue } from './serialQueue';

/** Elements read per step: about 12 ms on a real model once the property cache exists. */
export const DISCOVERY_CHUNK = 200;

/** Minimum time between progress messages to one caller. */
const PROGRESS_MIN_INTERVAL_MS = 100;

export interface DiscoveryHost {
  queue: SerialQueue;
  /** The model's open web-ifc id, or undefined when it is not open. */
  openId(modelId: string): number | undefined;
  /** One element's properties through the cached per-element path. Called inside a queued step. */
  read(modelId: string, webIfcId: number, expressId: number): Promise<ElementProperties>;
  /** Post a reply; `transfer` lists buffers to hand over rather than copy. */
  post(msg: FromWorker, transfer?: Transferable[]): void;
  /**
   * One-off work before the first element is read (building the model's
   * relationship index). Given a step of its own, so a request that arrives
   * meanwhile waits behind it or behind a chunk, never both.
   */
  prepare?(modelId: string, webIfcId: number): Promise<void>;
  /** Clock for progress throttling (tests). */
  now?: () => number;
}

/**
 * Identifies a scope cheaply: its length and an FNV-1a hash of its ids, in
 * order. Two requests with the same fingerprint describe the same elements.
 */
export function scopeFingerprint(ids: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < ids.length; i++) {
    h ^= ids[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${ids.length}:${(h >>> 0).toString(16)}`;
}

/** What a job does with each element read, and how it answers when done. */
interface JobFold {
  /** Element `props` is the scope's element at `index`. */
  add(props: ElementProperties, index: number): void;
  /** Post the answer to `reqId`. */
  reply(reqId: number, job: Job): void;
}

interface Job {
  /** Jobs with the same key are the same question: a second ask joins. */
  key: string;
  modelId: string;
  ids: ArrayLike<number>;
  scope: string;
  /** Bound by the first step. */
  webIfcId: number | undefined;
  fold: JobFold;
  pos: number;
  unreadable: number;
  /** Request ids waiting for this job's result. */
  waiters: number[];
  stopped: boolean;
  lastProgressAt: number;
  /**
   * Someone is waiting on this job right now (a value was picked). While any
   * job is urgent, every other job's steps stand aside, so a pick never
   * waits behind a column built in case it was needed.
   */
  urgent: boolean;
  /** A kept answer for this question, if there is one: replies without reading. */
  kept?: () => ((reqId: number) => void) | null;
}

interface Kept {
  webIfcId: number;
  scope: string;
  result: ModelParameters;
}

export class ParameterDiscoveries {
  private jobs = new Map<string, Job>();
  private kept = new Map<string, Kept>();

  constructor(
    private readonly host: DiscoveryHost,
    private readonly chunkSize: number = DISCOVERY_CHUNK,
  ) {}

  /**
   * Describe the parameters of `expressIds` in `modelId`; the reply is a
   * `parameters` message for `reqId` (or an `error`). Called straight from
   * the worker's message handler: it queues its own steps.
   */
  request(reqId: number, modelId: string, expressIds: ArrayLike<number>): void {
    const fold = new ParameterFold();
    let result: ModelParameters | null = null;
    this.start(reqId, modelId, expressIds, modelId, {
      add: (props) => fold.add(props),
      reply: (r, job) => {
        if (!result) {
          result = fold.result(modelId, job.ids.length);
          if (job.unreadable > 0) result.unreadable = job.unreadable;
          this.kept.set(modelId, { webIfcId: job.webIfcId!, scope: job.scope, result });
        }
        this.host.post({ type: 'parameters', reqId: r, result });
      },
    }, (job) => {
      const kept = this.kept.get(modelId);
      if (!kept || kept.webIfcId !== job.webIfcId || kept.scope !== job.scope) return null;
      return (r) => this.host.post({ type: 'parameters', reqId: r, result: kept.result });
    });
  }

  /**
   * The value column of one parameter (`path`) over `expressIds`: row i is
   * `expressIds[i]`. Same background steps as `request`; replies with one
   * `column` message whose arrays are transferred. Not kept here: the main
   * thread keeps it, so asking twice (after the first answer) reads twice.
   */
  requestColumn(
    reqId: number,
    modelId: string,
    expressIds: ArrayLike<number>,
    path: string,
    urgent = false,
  ): void {
    const builder = new ColumnBuilder(path, expressIds.length);
    let column: ColumnData | null = null;
    this.start(reqId, modelId, expressIds, `${modelId}|column|${path}`, {
      add: (props, index) => builder.add(index, props),
      reply: (r, job) => {
        column ??= builder.finish();
        // The last waiter is handed the arrays; any before it (rare: the main
        // thread asks once per column) get a copy, sent while they still exist.
        const last = job.waiters[job.waiters.length - 1] === r;
        this.host.post({ type: 'column', reqId: r, column }, last ? columnTransferables(column) : []);
      },
    }, undefined, urgent);
  }

  /**
   * The caller of `reqId` no longer wants the answer: it goes unanswered.
   * A job nobody waits for any more stops before its next step, so a column
   * built for a parameter that was opened and closed again does not keep
   * the worker busy. Called straight from the message handler, not queued.
   */
  cancel(reqId: number): void {
    for (const job of this.jobs.values()) {
      const i = job.waiters.indexOf(reqId);
      if (i < 0) continue;
      job.waiters.splice(i, 1);
      if (job.waiters.length === 0) this.end(job);
      return;
    }
  }

  /**
   * The caller of `reqId` is now waiting on it (a value was picked): its job
   * goes first. Called straight from the message handler, not queued.
   */
  hurry(reqId: number): void {
    for (const job of this.jobs.values()) {
      if (job.waiters.includes(reqId)) job.urgent = true;
    }
  }

  /** The model was closed: stop its jobs and forget its result. */
  drop(modelId: string): void {
    this.kept.delete(modelId);
    for (const job of [...this.jobs.values()]) {
      if (job.modelId === modelId) this.fail(job, 'The model was closed');
    }
  }

  /** web-ifc was torn down: stop everything and forget everything. */
  clear(): void {
    for (const job of [...this.jobs.values()]) this.fail(job, 'The model was closed');
    this.kept.clear();
  }

  /** Whether any job is running for `modelId` (tests). */
  isRunning(modelId: string): boolean {
    return [...this.jobs.values()].some((j) => j.modelId === modelId);
  }

  private start(
    reqId: number,
    modelId: string,
    expressIds: ArrayLike<number>,
    key: string,
    fold: JobFold,
    kept?: (job: Job) => ((reqId: number) => void) | null,
    urgent = false,
  ): void {
    const scope = scopeFingerprint(expressIds);
    const running = this.jobs.get(key);
    if (running && running.scope === scope) {
      running.waiters.push(reqId);
      if (urgent) running.urgent = true;
      return;
    }
    // A different scope for the same question: the newer request wins.
    if (running) this.fail(running, 'Superseded by a newer request');

    const job: Job = {
      key,
      modelId,
      ids: expressIds,
      scope,
      webIfcId: undefined,
      fold,
      pos: 0,
      unreadable: 0,
      waiters: [reqId],
      stopped: false,
      lastProgressAt: -Infinity,
      urgent,
    };
    if (kept) job.kept = () => kept(job);
    this.jobs.set(key, job);
    this.host.queue.enqueueBackground(
      () => this.step(job),
      (err) => this.fail(job, err instanceof Error ? err.message : 'Parameter discovery failed'),
    );
  }

  /** One step: bind or re-check the model, read a chunk, report. True while there is more. */
  private async step(job: Job): Promise<boolean> {
    if (job.stopped) return false;
    // Stand aside for a job someone is waiting on: this step is queued again
    // behind it without reading anything.
    if (!job.urgent && this.anyUrgent()) return true;
    const open = this.host.openId(job.modelId);

    if (job.webIfcId === undefined) {
      if (open === undefined) {
        this.fail(job, `Model "${job.modelId}" is not open`);
        return false;
      }
      job.webIfcId = open;
      const answer = job.kept?.();
      if (answer) {
        this.end(job);
        for (const reqId of job.waiters) answer(reqId);
        return false;
      }
      if (this.host.prepare && job.ids.length > 0) {
        await this.host.prepare(job.modelId, open);
        return true;
      }
    } else if (open !== job.webIfcId) {
      this.fail(job, 'The model was closed');
      return false;
    }

    const total = job.ids.length;
    const end = Math.min(job.pos + this.chunkSize, total);
    while (job.pos < end) {
      const index = job.pos++;
      const expressId = job.ids[index];
      let props: ElementProperties;
      try {
        props = await this.host.read(job.modelId, job.webIfcId, expressId);
      } catch {
        // One unreadable element does not sink the answer; it is counted and
        // reported instead.
        job.unreadable++;
        continue;
      }
      job.fold.add(props, index);
    }

    const now = (this.host.now ?? Date.now)();
    if (job.pos === total || now - job.lastProgressAt >= PROGRESS_MIN_INTERVAL_MS) {
      job.lastProgressAt = now;
      for (const reqId of job.waiters) this.host.post({ type: 'progress', reqId, done: job.pos, total });
    }
    if (job.pos < total) return true;

    this.end(job);
    for (const reqId of job.waiters) job.fold.reply(reqId, job);
    return false;
  }

  private anyUrgent(): boolean {
    for (const j of this.jobs.values()) if (j.urgent && !j.stopped) return true;
    return false;
  }

  private end(job: Job): void {
    job.stopped = true;
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
  }

  private fail(job: Job, message: string): void {
    if (job.stopped) return;
    this.end(job);
    for (const reqId of job.waiters) this.host.post({ type: 'error', reqId, message });
  }
}
