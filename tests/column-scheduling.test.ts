/**
 * Column builds started in case a value is picked must not pile up (#67
 * review): a build whose parameter is closed again is given up, in the
 * worker too, and a build someone picked from goes ahead of everything
 * else in the background.
 *
 * The worker side (`ParameterDiscoveries` on a real `SerialQueue`) and the
 * main-thread side (`WorkerPropertyRepository`) are tested apart, then
 * together: the repository talks to the real discovery jobs through an
 * in-process stand-in for the worker.
 */

import { describe, it, expect } from 'vitest';
import { SerialQueue } from '../src/parser/serialQueue';
import { ParameterDiscoveries } from '../src/parser/parameterDiscovery';
import { WorkerIfcParser, type WorkerLike } from '../src/parser/WorkerIfcParser';
import { WorkerPropertyRepository } from '../src/inspector/repository/WorkerPropertyRepository';
import { ColumnBuildCancelled } from '../src/inspector/repository/ElementPropertyRepository';
import type { FromWorker, ToWorker } from '../src/parser/ifcMessages';
import type { ElementProperties, PropertyFlatRow } from '../src/inspector/types';

/** Node's setImmediate (this project has no Node types). */
const setImmediate = (globalThis as unknown as { setImmediate: (fn: () => void) => void }).setImmediate;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const SCOPE = Array.from({ length: 40 }, (_, i) => i + 1);

/** Element `id` has P.A, P.B, P.C, P.D … all with the value `id`. */
function props(id: number): ElementProperties {
  const flat: PropertyFlatRow[] = ['A', 'B', 'C', 'D', 'E', 'F'].map((k) => ({
    path: `P.${k}`,
    name: k,
    rawValue: { kind: 'single', value: id, raw: { typeCode: 0, value: id } },
    displayValue: String(id),
    source: 'pset',
  }));
  return { identity: { modelId: 'm', expressId: id, ifcClass: 'IfcWall', ifcTypeCode: 0 }, direct: [], psets: [], qtos: [], materials: [], flat, fetchedAt: 0 };
}

/** Discovery jobs over a real queue, 4 elements per step, counting reads per job. */
function worker() {
  // setImmediate, not setTimeout: on Windows a timer tick is ~15 ms.
  const queue = new SerialQueue((fn) => setImmediate(fn));
  const posted: FromWorker[] = [];
  let reads = 0;
  const d = new ParameterDiscoveries(
    {
      queue,
      openId: () => 7,
      read: async (_m, _w, id) => {
        reads++;
        return props(id);
      },
      post: (msg) => posted.push(msg),
    },
    4,
  );
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 400; i++) await tick();
  };
  return { d, posted, reads: () => reads, settled };
}

describe('column jobs in the worker', () => {
  it('a cancelled job stops before its next step and is never answered', async () => {
    const w = worker();
    w.d.requestColumn(1, 'm', Int32Array.from(SCOPE), 'P.A');
    await tick();
    w.d.cancel(1);
    await w.settled();
    expect(w.posted.filter((m) => m.type === 'column')).toHaveLength(0);
    expect(w.posted.filter((m) => m.type === 'error')).toHaveLength(0);
    // At most the step that was running when it was cancelled.
    expect(w.reads()).toBeLessThanOrEqual(4);
    expect(w.d.isRunning('m')).toBe(false);
  });

  it('cancelling one of two callers of the same job leaves the other answered', async () => {
    const w = worker();
    w.d.requestColumn(1, 'm', Int32Array.from(SCOPE), 'P.A');
    w.d.requestColumn(2, 'm', Int32Array.from(SCOPE), 'P.A');
    w.d.cancel(1);
    await w.settled();
    const replies = w.posted.filter((m) => m.type === 'column');
    expect(replies.map((m) => (m as { reqId: number }).reqId)).toEqual([2]);
    expect(w.reads()).toBe(SCOPE.length);
  });

  it('an urgent job goes ahead: other background jobs stand aside until it is done', async () => {
    const w = worker();
    w.d.requestColumn(1, 'm', Int32Array.from(SCOPE), 'P.A');
    w.d.request(2, 'm', SCOPE);
    w.d.requestColumn(3, 'm', Int32Array.from(SCOPE), 'P.C', true);
    await w.settled();
    const order = w.posted
      .filter((m) => m.type === 'column' || m.type === 'parameters')
      .map((m) => (m as { reqId: number }).reqId);
    expect(order[0]).toBe(3);
    expect(order).toHaveLength(3);
  });

  it('columns asked for together are built in one read of the elements', async () => {
    const w = worker();
    w.d.requestColumn(1, 'm', Int32Array.from(SCOPE), 'P.A');
    w.d.requestColumn(2, 'm', Int32Array.from(SCOPE), 'P.B');
    w.d.requestColumn(3, 'm', Int32Array.from(SCOPE), 'P.C');
    await w.settled();
    const replies = w.posted.filter((m) => m.type === 'column');
    expect(replies.map((m) => (m as { column: { key: string } }).column.key).sort()).toEqual(['P.A', 'P.B', 'P.C']);
    for (const m of replies) {
      const values = [...(m as { column: { values: Float64Array } }).column.values];
      expect(values).toEqual(SCOPE);
    }
    expect(w.reads()).toBe(SCOPE.length);
  });

  it('a column that joins part-way reads round to what it missed, and no more', async () => {
    const w = worker();
    w.d.requestColumn(1, 'm', Int32Array.from(SCOPE), 'P.A');
    // Three steps of four elements.
    for (let i = 0; i < 3; i++) await tick();
    const before = w.reads();
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(SCOPE.length);
    w.d.requestColumn(2, 'm', Int32Array.from(SCOPE), 'P.B');
    await w.settled();
    const b = w.posted.find((m) => m.type === 'column' && m.reqId === 2) as { column: { values: Float64Array } };
    expect([...b.column.values]).toEqual(SCOPE);
    // A once over the scope, and B round again to where it joined.
    expect(w.reads()).toBe(SCOPE.length + before);
  });

  it('cancelling one column of a shared read leaves the others answered', async () => {
    const w = worker();
    w.d.requestColumn(1, 'm', Int32Array.from(SCOPE), 'P.A');
    w.d.requestColumn(2, 'm', Int32Array.from(SCOPE), 'P.B');
    await tick();
    w.d.cancel(1);
    await w.settled();
    expect(w.posted.filter((m) => m.type === 'column').map((m) => (m as { reqId: number }).reqId)).toEqual([2]);
    expect(w.reads()).toBe(SCOPE.length);
  });

  it('hurrying a running job puts it first from its next step', async () => {
    const w = worker();
    w.d.requestColumn(1, 'm', Int32Array.from(SCOPE), 'P.A');
    w.d.requestColumn(2, 'm', Int32Array.from(SCOPE), 'P.B');
    await tick();
    w.d.hurry(2);
    await w.settled();
    const order = w.posted.filter((m) => m.type === 'column').map((m) => (m as { reqId: number }).reqId);
    expect(order).toEqual([2, 1]);
  });
});

/** A repository whose worker is the real discovery jobs, in process. */
function connected() {
  const w = worker();
  const posted: ToWorker[] = [];
  const stub: WorkerLike & { onmessage: ((e: MessageEvent<FromWorker>) => void) | null } = {
    onmessage: null,
    onerror: null,
    postMessage(msg: ToWorker) {
      posted.push(msg);
      switch (msg.type) {
        case 'describeParameters':
          w.d.request(msg.reqId, msg.id, msg.expressIds);
          break;
        case 'parameterColumn':
          // Structured clone: the worker gets its own copy of the scope.
          w.d.requestColumn(msg.reqId, msg.id, Int32Array.from(msg.expressIds), msg.path, msg.urgent === true);
          break;
        case 'cancelColumn':
          w.d.cancel(msg.reqId);
          break;
        case 'hurryColumn':
          w.d.hurry(msg.reqId);
          break;
      }
    },
    terminate() {},
  } as unknown as WorkerLike & { onmessage: ((e: MessageEvent<FromWorker>) => void) | null };
  const repo = new WorkerPropertyRepository(new WorkerIfcParser(stub));
  // Replies reach the main thread as messages do: later, in order.
  const deliver = (): void => {
    for (const msg of w.posted.splice(0)) stub.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
  };
  /** Let the worker run and its replies arrive until `until` settles (and a little after). */
  const pump = async (until: Promise<unknown>): Promise<void> => {
    let done = false;
    void until.then(() => (done = true), () => (done = true));
    for (let i = 0; i < 5000 && !done; i++) {
      deliver();
      await tick();
    }
    for (let i = 0; i < 50; i++) {
      deliver();
      await tick();
    }
  };
  return { repo, w, posted, pump, deliver, stub };
}

describe('browsing parameters, then picking a value', () => {
  it('only the build the pick needs runs to completion', async () => {
    const c = connected();
    void c.repo.describeParameters('m', SCOPE);
    // Open and close five parameters, as someone browsing the list does.
    const given: Promise<unknown>[] = [];
    for (const k of ['A', 'B', 'C', 'D', 'E']) {
      const p = c.repo.getColumn('m', `P.${k}`);
      given.push(p.then(() => 'built', (e) => (e instanceof ColumnBuildCancelled ? 'given up' : 'failed')));
      await tick();
      c.repo.releaseColumn('m', `P.${k}`);
    }
    // Open F, and pick a value in it.
    void c.repo.getColumn('m', 'P.F');
    const picked = c.repo.getColumn('m', 'P.F', undefined, { urgent: true });
    await c.pump(picked);
    const column = await picked;
    expect(column.key).toBe('P.F');
    expect(await Promise.all(given)).toEqual(['given up', 'given up', 'given up', 'given up', 'given up']);
    // Only F answered; the five abandoned builds each read at most one step.
    const answered = c.w.posted.length; // delivered and cleared by pump
    expect(answered).toBe(0);
    const reads = c.w.reads() - SCOPE.length; // minus the description
    expect(reads).toBeLessThanOrEqual(SCOPE.length + 5 * 4);
    expect(c.posted.filter((m) => m.type === 'cancelColumn')).toHaveLength(5);
    expect(c.posted.filter((m) => m.type === 'hurryColumn')).toHaveLength(1);
  });

  it('a pick waiting on a build keeps it when its parameter closes', async () => {
    const c = connected();
    void c.repo.describeParameters('m', SCOPE);
    void c.repo.getColumn('m', 'P.A');
    const picked = c.repo.getColumn('m', 'P.A', undefined, { urgent: true });
    c.repo.releaseColumn('m', 'P.A');
    await c.pump(picked);
    expect((await picked).key).toBe('P.A');
    expect(c.posted.some((m) => m.type === 'cancelColumn')).toBe(false);
  });

  it('a given-up column is built again when asked for again', async () => {
    const c = connected();
    void c.repo.describeParameters('m', SCOPE);
    const first = c.repo.getColumn('m', 'P.A');
    c.repo.releaseColumn('m', 'P.A');
    await expect(first).rejects.toBeInstanceOf(ColumnBuildCancelled);
    const again = c.repo.getColumn('m', 'P.A');
    await c.pump(again);
    expect((await again).count).toBe(SCOPE.length);
  });

  it('a finished column is kept when its parameter closes', async () => {
    const c = connected();
    void c.repo.describeParameters('m', SCOPE);
    const built = c.repo.getColumn('m', 'P.A');
    await c.pump(built);
    const column = await built;
    c.repo.releaseColumn('m', 'P.A');
    expect(await c.repo.getColumn('m', 'P.A')).toBe(column);
    expect(c.posted.some((m) => m.type === 'cancelColumn')).toBe(false);
  });

  it('describing a model again over other elements drops the columns built for the old ones', async () => {
    const c = connected();
    /** Describe the model, and have that description fail (say the model was busy reloading). */
    const describeAndFail = async (ids: number[]): Promise<void> => {
      const p = c.repo.describeParameters('m', ids);
      const req = [...c.posted].reverse().find((m) => m.type === 'describeParameters') as { reqId: number } | undefined;
      if (req) c.stub.onmessage?.({ data: { type: 'error', reqId: req.reqId, message: 'boom' } } as MessageEvent<FromWorker>);
      await p.catch(() => {});
    };
    await describeAndFail(SCOPE);
    const built = c.repo.getColumn('m', 'P.A');
    await c.pump(built);
    const old = await built;
    expect(old.ids.length).toBe(SCOPE.length);

    // Retried over fewer elements: the old column no longer lines up, so it goes.
    await describeAndFail(SCOPE.slice(0, 10));
    const fresh = c.repo.getColumn('m', 'P.A');
    await c.pump(fresh);
    expect((await fresh).ids.length).toBe(10);

    // Retried over the same elements: the column is kept.
    await describeAndFail(SCOPE.slice(0, 10));
    expect(await c.repo.getColumn('m', 'P.A')).toBe(await fresh);
  });
});
