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
 *  - **Lazy and cached.** Nothing runs until asked. The result is kept per
 *    model and dropped with the model, together with its property cache.
 *    Asking again while a job runs joins that job.
 */

import { ParameterFold } from '../inspector/parameterFold';
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
  post(msg: FromWorker): void;
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
export function scopeFingerprint(ids: readonly number[]): string {
  let h = 0x811c9dc5;
  for (const id of ids) {
    h ^= id;
    h = Math.imul(h, 0x01000193);
  }
  return `${ids.length}:${(h >>> 0).toString(16)}`;
}

interface Job {
  modelId: string;
  ids: readonly number[];
  scope: string;
  /** Bound by the first step. */
  webIfcId: number | undefined;
  fold: ParameterFold;
  pos: number;
  unreadable: number;
  /** Request ids waiting for this job's result. */
  waiters: number[];
  stopped: boolean;
  lastProgressAt: number;
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
  request(reqId: number, modelId: string, expressIds: readonly number[]): void {
    const scope = scopeFingerprint(expressIds);
    const running = this.jobs.get(modelId);
    if (running && running.scope === scope) {
      running.waiters.push(reqId);
      return;
    }
    // A different scope for the same model: the newer request wins.
    if (running) this.fail(running, 'Superseded by a newer request');

    const job: Job = {
      modelId,
      ids: expressIds,
      scope,
      webIfcId: undefined,
      fold: new ParameterFold(),
      pos: 0,
      unreadable: 0,
      waiters: [reqId],
      stopped: false,
      lastProgressAt: -Infinity,
    };
    this.jobs.set(modelId, job);
    this.host.queue.enqueueBackground(
      () => this.step(job),
      (err) => this.fail(job, err instanceof Error ? err.message : 'Parameter discovery failed'),
    );
  }

  /** The model was closed: stop its job and forget its result. */
  drop(modelId: string): void {
    this.kept.delete(modelId);
    const job = this.jobs.get(modelId);
    if (job) this.fail(job, 'The model was closed');
  }

  /** web-ifc was torn down: stop everything and forget everything. */
  clear(): void {
    for (const job of [...this.jobs.values()]) this.fail(job, 'The model was closed');
    this.kept.clear();
  }

  /** Whether a job is running for `modelId` (tests). */
  isRunning(modelId: string): boolean {
    return this.jobs.has(modelId);
  }

  /** One step: bind or re-check the model, read a chunk, report. True while there is more. */
  private async step(job: Job): Promise<boolean> {
    if (job.stopped) return false;
    const open = this.host.openId(job.modelId);

    if (job.webIfcId === undefined) {
      if (open === undefined) {
        this.fail(job, `Model "${job.modelId}" is not open`);
        return false;
      }
      job.webIfcId = open;
      const kept = this.kept.get(job.modelId);
      if (kept && kept.webIfcId === open && kept.scope === job.scope) {
        this.finish(job, kept.result);
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
      const expressId = job.ids[job.pos++];
      let props: ElementProperties;
      try {
        props = await this.host.read(job.modelId, job.webIfcId, expressId);
      } catch {
        // One unreadable element does not sink the model's description; it
        // is counted and reported instead.
        job.unreadable++;
        continue;
      }
      job.fold.add(props);
    }

    const now = (this.host.now ?? Date.now)();
    if (job.pos === total || now - job.lastProgressAt >= PROGRESS_MIN_INTERVAL_MS) {
      job.lastProgressAt = now;
      for (const reqId of job.waiters) this.host.post({ type: 'progress', reqId, done: job.pos, total });
    }
    if (job.pos < total) return true;

    const result = job.fold.result(job.modelId, total);
    if (job.unreadable > 0) result.unreadable = job.unreadable;
    this.kept.set(job.modelId, { webIfcId: job.webIfcId, scope: job.scope, result });
    this.finish(job, result);
    return false;
  }

  private finish(job: Job, result: ModelParameters): void {
    job.stopped = true;
    if (this.jobs.get(job.modelId) === job) this.jobs.delete(job.modelId);
    for (const reqId of job.waiters) this.host.post({ type: 'parameters', reqId, result });
  }

  private fail(job: Job, message: string): void {
    if (job.stopped) return;
    job.stopped = true;
    if (this.jobs.get(job.modelId) === job) this.jobs.delete(job.modelId);
    for (const reqId of job.waiters) this.host.post({ type: 'error', reqId, message });
  }
}
