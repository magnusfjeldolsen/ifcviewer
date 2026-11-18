/**
 * Scheduling and lifetime of parameter discovery in the worker: a request
 * that arrives while discovery runs goes before its next step, and a model
 * that is closed or replaced stops it. Driven through the real
 * `SerialQueue` the worker uses, with real macrotask yields.
 */

import { describe, it, expect } from 'vitest';
import { SerialQueue } from '../src/parser/serialQueue';
import { ParameterDiscoveries } from '../src/parser/parameterDiscovery';
import type { FromWorker } from '../src/parser/ifcMessages';
import type { ElementProperties, ModelParameters } from '../src/inspector/types';

function element(expressId: number): ElementProperties {
  return {
    identity: { modelId: 'm', expressId, ifcClass: 'IfcBeam', ifcTypeCode: 0 },
    direct: [],
    psets: [],
    qtos: [],
    materials: [],
    flat: [
      {
        path: 'Identity.ExpressId',
        name: 'ExpressId',
        rawValue: { kind: 'single', value: expressId, raw: { typeCode: 0, value: expressId } },
        displayValue: String(expressId),
        source: 'direct',
      },
    ],
    fetchedAt: 0,
  };
}

interface Harness {
  queue: SerialQueue;
  discoveries: ParameterDiscoveries;
  open: Map<string, number>;
  log: string[];
  posted: FromWorker[];
  /** Run inside the next read, once. */
  duringRead: (() => void) | null;
  failOn: Set<number>;
  /** Settles with the reply (parameters or error) for `reqId`. */
  reply(reqId: number): Promise<FromWorker>;
}

function harness(chunkSize = 2): Harness {
  const queue = new SerialQueue();
  const h: Harness = {
    queue,
    discoveries: null as unknown as ParameterDiscoveries,
    open: new Map([['m', 7]]),
    log: [],
    posted: [],
    duringRead: null,
    failOn: new Set(),
    reply: (reqId) =>
      new Promise((resolve) => {
        const check = (): void => {
          const r = h.posted.find(
            (m) => (m.type === 'parameters' || m.type === 'error') && m.reqId === reqId,
          );
          if (r) resolve(r);
          else setTimeout(check, 1);
        };
        check();
      }),
  };
  h.discoveries = new ParameterDiscoveries(
    {
      queue,
      openId: (id) => h.open.get(id),
      read: async (_id, _webIfcId, expressId) => {
        h.log.push(`read ${expressId}`);
        const during = h.duringRead;
        h.duringRead = null;
        during?.();
        if (h.failOn.has(expressId)) throw new Error('bad element');
        return element(expressId);
      },
      post: (msg) => h.posted.push(msg),
    },
    chunkSize,
  );
  return h;
}

const IDS = [1, 2, 3, 4, 5, 6];

describe('parameter discovery scheduling', () => {
  it('a property click that arrives during a step runs before the next step', async () => {
    const h = harness(2);
    // The click arrives as a message (a task) while the first step runs.
    h.duringRead = () => setTimeout(() => h.queue.enqueue(async () => void h.log.push('getProps')), 0);
    h.discoveries.request(1, 'm', IDS);
    await h.reply(1);
    expect(h.log).toEqual(['read 1', 'read 2', 'getProps', 'read 3', 'read 4', 'read 5', 'read 6']);
  });

  it('prepares the model in a step of its own, ahead of the first chunk', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const posted: FromWorker[] = [];
    const d = new ParameterDiscoveries(
      {
        queue,
        openId: () => 7,
        prepare: async () => {
          log.push('prepare');
          // A click arrives while the index is being built.
          setTimeout(() => queue.enqueue(async () => void log.push('getProps')), 0);
        },
        read: async (_m, _w, id) => {
          log.push(`read ${id}`);
          return element(id);
        },
        post: (m) => posted.push(m),
      },
      2,
    );
    d.request(1, 'm', [1, 2]);
    while (!posted.some((m) => m.type === 'parameters')) await new Promise((r) => setTimeout(r, 1));
    expect(log).toEqual(['prepare', 'getProps', 'read 1', 'read 2']);
  });

  it('work queued during a step also runs before the next step', async () => {
    const h = harness(2);
    h.duringRead = () => h.queue.enqueue(async () => void h.log.push('select-similar'));
    h.discoveries.request(1, 'm', IDS);
    await h.reply(1);
    expect(h.log.indexOf('select-similar')).toBe(2);
  });

  it('reports progress and ends at the total', async () => {
    const h = harness(2);
    h.discoveries.request(1, 'm', IDS);
    await h.reply(1);
    const progress = h.posted.filter((m) => m.type === 'progress');
    expect(progress[progress.length - 1]).toEqual({ type: 'progress', reqId: 1, done: 6, total: 6 });
    const result = (h.posted.find((m) => m.type === 'parameters') as { result: ModelParameters }).result;
    expect(result.scopeSize).toBe(6);
    expect(result.parameters[0]).toMatchObject({ key: 'Identity.ExpressId', count: 6, uniquePerElement: true });
  });

  it('a second request while it runs joins the same job', async () => {
    const h = harness(2);
    h.discoveries.request(1, 'm', IDS);
    h.discoveries.request(2, 'm', IDS);
    await Promise.all([h.reply(1), h.reply(2)]);
    expect(h.log.filter((l) => l.startsWith('read'))).toHaveLength(6);
  });

  it('keeps the result per model: asking again reads nothing', async () => {
    const h = harness(2);
    h.discoveries.request(1, 'm', IDS);
    await h.reply(1);
    h.log.length = 0;
    h.discoveries.request(2, 'm', IDS);
    const again = await h.reply(2);
    expect(again.type).toBe('parameters');
    expect(h.log).toEqual([]);
  });

  it('a different scope of the same size is read, not served the kept result', async () => {
    const h = harness(2);
    h.discoveries.request(1, 'm', [1, 2]);
    await h.reply(1);
    h.log.length = 0;
    h.discoveries.request(2, 'm', [3, 4]);
    await h.reply(2);
    expect(h.log).toEqual(['read 3', 'read 4']);
  });

  it('counts an unreadable element instead of failing the model', async () => {
    const h = harness(2);
    h.failOn.add(3);
    h.discoveries.request(1, 'm', IDS);
    const r = (await h.reply(1)) as { result: ModelParameters };
    expect(r.result.unreadable).toBe(1);
    expect(r.result.parameters[0].count).toBe(5);
  });
});

describe('parameter discovery lifetime', () => {
  it('stops when the model is disposed, and tells whoever waits', async () => {
    const h = harness(2);
    h.duringRead = () => {
      // The model is closed while the first step runs (disposeModel).
      h.open.delete('m');
      h.discoveries.drop('m');
    };
    h.discoveries.request(1, 'm', IDS);
    const r = await h.reply(1);
    expect(r).toMatchObject({ type: 'error', message: expect.stringMatching(/closed/) });
    await new Promise((res) => setTimeout(res, 10));
    await h.queue.idle();
    expect(h.log).toEqual(['read 1', 'read 2']);
    expect(h.discoveries.isRunning('m')).toBe(false);
  });

  it('stops when the model is replaced under the same id', async () => {
    const h = harness(2);
    h.duringRead = () => h.open.set('m', 8);
    h.discoveries.request(1, 'm', IDS);
    const r = await h.reply(1);
    expect(r.type).toBe('error');
    expect(h.log).toEqual(['read 1', 'read 2']);
  });

  it('does not serve a kept result once the model is dropped', async () => {
    const h = harness(2);
    h.discoveries.request(1, 'm', IDS);
    await h.reply(1);
    h.discoveries.drop('m');
    h.log.length = 0;
    h.discoveries.request(2, 'm', IDS);
    await h.reply(2);
    expect(h.log.filter((l) => l.startsWith('read'))).toHaveLength(6);
  });

  it('fails a request for a model that is not open', async () => {
    const h = harness(2);
    h.discoveries.request(1, 'other', IDS);
    expect((await h.reply(1)).type).toBe('error');
  });

  it('answers an empty scope with an empty description', async () => {
    const h = harness(2);
    h.discoveries.request(1, 'm', []);
    const r = (await h.reply(1)) as { result: ModelParameters };
    expect(r.result).toEqual({ modelId: 'm', scopeSize: 0, parameters: [] });
  });
});
