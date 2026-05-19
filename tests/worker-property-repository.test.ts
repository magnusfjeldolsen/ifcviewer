/**
 * Unit tests for `WorkerPropertyRepository` — the main-thread proxy for
 * the IFC worker's property path.
 *
 * The repository drives the worker through a `WorkerIfcParser`; here we
 * inject a `WorkerLike` stub into a real `WorkerIfcParser` so the
 * `setExtraMessageSink` wiring is exercised end to end. We verify:
 *  - a `get` posts a `getProps` correlated by reqId;
 *  - replies route by reqId, including out of order;
 *  - the memo serves repeat gets without a second round-trip;
 *  - an `error` reply rejects the matching get and is NOT memoized;
 *  - `disposeModel` clears the memo and tells the worker.
 */

import { describe, it, expect } from 'vitest';
import { WorkerIfcParser, type WorkerLike } from '../src/parser/WorkerIfcParser';
import { WorkerPropertyRepository } from '../src/inspector/repository/WorkerPropertyRepository';
import type { ToWorker, FromWorker } from '../src/parser/ifcMessages';
import type { ElementProperties } from '../src/inspector/types';

class MockWorker implements WorkerLike {
  posted: ToWorker[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  postMessage(message: ToWorker): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(msg: FromWorker): void {
    this.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
  }
  crash(): void {
    this.onerror?.({});
  }
}

function fakeProps(modelId: string, expressId: number): ElementProperties {
  return {
    identity: { modelId, expressId, ifcClass: 'IfcWall', ifcTypeCode: 0 },
    direct: [],
    psets: [],
    qtos: [],
    materials: [],
    flat: [],
    fetchedAt: 123,
  };
}

/** A repo wired to a fresh mock worker; returns both for assertions. */
function setup(): { repo: WorkerPropertyRepository; worker: MockWorker } {
  const worker = new MockWorker();
  const parser = new WorkerIfcParser(worker);
  const repo = new WorkerPropertyRepository(parser);
  return { repo, worker };
}

/** Last getProps message posted to the worker. */
function lastGetProps(worker: MockWorker): Extract<ToWorker, { type: 'getProps' }> {
  const msg = [...worker.posted].reverse().find((m) => m.type === 'getProps');
  if (!msg) throw new Error('no getProps posted');
  return msg;
}

describe('WorkerPropertyRepository — request/reply', () => {
  it('posts a getProps message with a reqId and resolves on the matching props reply', async () => {
    const { repo, worker } = setup();
    const promise = repo.get('m', 42);

    const sent = lastGetProps(worker);
    expect(sent).toMatchObject({ type: 'getProps', id: 'm', expressId: 42 });

    worker.reply({ type: 'props', reqId: sent.reqId, props: fakeProps('m', 42) });
    await expect(promise).resolves.toMatchObject({ identity: { expressId: 42 } });
  });

  it('correlates replies by reqId even when they arrive out of order', async () => {
    const { repo, worker } = setup();
    const pA = repo.get('m', 1);
    const pB = repo.get('m', 2);

    const reqA = (worker.posted[0] as Extract<ToWorker, { type: 'getProps' }>).reqId;
    const reqB = (worker.posted[1] as Extract<ToWorker, { type: 'getProps' }>).reqId;
    expect(reqA).not.toBe(reqB);

    // Reply to B first, then A.
    worker.reply({ type: 'props', reqId: reqB, props: fakeProps('m', 2) });
    worker.reply({ type: 'props', reqId: reqA, props: fakeProps('m', 1) });

    expect((await pA).identity.expressId).toBe(1);
    expect((await pB).identity.expressId).toBe(2);
  });

  it('rejects the matching get on an error reply', async () => {
    const { repo, worker } = setup();
    const promise = repo.get('m', 7);
    const sent = lastGetProps(worker);

    worker.reply({ type: 'error', reqId: sent.reqId, message: 'unknown modelId' });
    await expect(promise).rejects.toThrow('unknown modelId');
  });
});

describe('WorkerPropertyRepository — memoization', () => {
  it('serves a repeat get from the memo without a second round-trip', async () => {
    const { repo, worker } = setup();
    const p1 = repo.get('m', 5);
    const sent = lastGetProps(worker);
    worker.reply({ type: 'props', reqId: sent.reqId, props: fakeProps('m', 5) });
    await p1;

    const getPropsCountBefore = worker.posted.filter((m) => m.type === 'getProps').length;
    const p2 = repo.get('m', 5);
    expect(worker.posted.filter((m) => m.type === 'getProps').length).toBe(getPropsCountBefore);
    expect(await p2).toBe(await p1);
  });

  it('concurrent gets for the same key share one in-flight request', async () => {
    const { repo, worker } = setup();
    const pa = repo.get('m', 9);
    const pb = repo.get('m', 9);
    expect(worker.posted.filter((m) => m.type === 'getProps')).toHaveLength(1);

    const sent = lastGetProps(worker);
    worker.reply({ type: 'props', reqId: sent.reqId, props: fakeProps('m', 9) });
    expect(await pa).toBe(await pb);
  });

  it('does not memoize a failed fetch — a later get retries', async () => {
    const { repo, worker } = setup();
    const p1 = repo.get('m', 3);
    const sent1 = lastGetProps(worker);
    worker.reply({ type: 'error', reqId: sent1.reqId, message: 'transient' });
    await expect(p1).rejects.toThrow('transient');

    // A second get should issue a fresh request, not replay the failure.
    const p2 = repo.get('m', 3);
    const sent2 = lastGetProps(worker);
    expect(sent2.reqId).not.toBe(sent1.reqId);
    worker.reply({ type: 'props', reqId: sent2.reqId, props: fakeProps('m', 3) });
    await expect(p2).resolves.toMatchObject({ identity: { expressId: 3 } });
  });
});

describe('WorkerPropertyRepository — lifecycle', () => {
  it('disposeModel clears the memo and posts disposeModel to the worker', async () => {
    const { repo, worker } = setup();
    const p = repo.get('m', 1);
    worker.reply({ type: 'props', reqId: lastGetProps(worker).reqId, props: fakeProps('m', 1) });
    await p;

    repo.disposeModel('m');
    expect(worker.posted).toContainEqual({ type: 'disposeModel', id: 'm' });

    // A get after dispose issues a fresh round-trip (memo was cleared).
    const getPropsBefore = worker.posted.filter((m) => m.type === 'getProps').length;
    void repo.get('m', 1);
    expect(worker.posted.filter((m) => m.type === 'getProps').length).toBe(getPropsBefore + 1);
  });

  it('a worker crash rejects every in-flight get', async () => {
    const { repo, worker } = setup();
    const pa = repo.get('m', 1);
    const pb = repo.get('m', 2);
    worker.crash();
    await expect(pa).rejects.toThrow(/crashed/);
    await expect(pb).rejects.toThrow(/crashed/);
  });

  it('enumerateExpressIds and describeSchema still throw not-implemented', async () => {
    const { repo } = setup();
    await expect(repo.describeSchema('m')).rejects.toThrow(/not implemented/);
    const iterate = async (): Promise<void> => {
      for await (const _ of repo.enumerateExpressIds('m')) void _;
    };
    await expect(iterate()).rejects.toThrow(/not implemented/);
  });

  it('cancel is a no-op', () => {
    const { repo } = setup();
    expect(() => repo.cancel('m', 1)).not.toThrow();
  });
});

describe('WorkerPropertyRepository — message isolation', () => {
  it('ignores a props reply for an unknown reqId', () => {
    const { repo, worker } = setup();
    void repo;
    expect(() =>
      worker.reply({ type: 'props', reqId: 99999, props: fakeProps('m', 1) }),
    ).not.toThrow();
  });

  it('a model-scoped (id) error does not reject a property get', async () => {
    const { repo, worker } = setup();
    const p = repo.get('m', 1);
    const sent = lastGetProps(worker);
    // An error correlated by `id` (geometry path) — must not touch this get.
    worker.reply({ type: 'error', id: 'm', message: 'parse failed' });
    worker.reply({ type: 'props', reqId: sent.reqId, props: fakeProps('m', 1) });
    await expect(p).resolves.toMatchObject({ identity: { expressId: 1 } });
  });
});
