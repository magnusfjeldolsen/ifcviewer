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
import type { ElementIdentity, ElementProperties } from '../src/inspector/types';

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

// ─────────────────────────────────────────────────────────────────────
// intersectProperties — Phase 1 of dev/plans/handoff-bulk-property-access.md.
// The proxy posts `intersect` per model and combines per-model synthetic
// results on main. `progress` messages flow through to the caller's
// onProgress sink. The single-`get()` memo MUST NOT be populated by the
// intersect path (drill-down trade-off: option (a)).
// ─────────────────────────────────────────────────────────────────────

function ident(modelId: string, expressId: number): ElementIdentity {
  return { modelId, expressId, ifcClass: 'IfcWall', ifcTypeCode: 0 };
}

/** Last `intersect` message posted to the worker. */
function lastIntersect(worker: MockWorker): Extract<ToWorker, { type: 'intersect' }> {
  const msg = [...worker.posted].reverse().find((m) => m.type === 'intersect');
  if (!msg) throw new Error('no intersect posted');
  return msg;
}

/** All `intersect` messages posted to the worker (multi-model path). */
function allIntersects(worker: MockWorker): Extract<ToWorker, { type: 'intersect' }>[] {
  return worker.posted.filter((m): m is Extract<ToWorker, { type: 'intersect' }> => m.type === 'intersect');
}

describe('WorkerPropertyRepository.intersectProperties — single model', () => {
  it('posts one intersect with all expressIds and resolves on the intersection reply', async () => {
    const { repo, worker } = setup();
    const promise = repo.intersectProperties([ident('m', 1), ident('m', 2), ident('m', 3)]);

    const sent = lastIntersect(worker);
    expect(sent).toMatchObject({
      type: 'intersect',
      id: 'm',
      expressIds: [1, 2, 3],
    });
    expect(typeof sent.reqId).toBe('number');

    const synthetic = fakeProps('m', 0);
    worker.reply({ type: 'intersection', reqId: sent.reqId, props: synthetic });
    await expect(promise).resolves.toBe(synthetic);
  });

  it('routes intersection replies by reqId — unrelated reply does not resolve', async () => {
    const { repo, worker } = setup();
    const promise = repo.intersectProperties([ident('m', 1)]);
    const sent = lastIntersect(worker);

    // A stale intersection reply for a different reqId must not resolve us.
    worker.reply({
      type: 'intersection',
      reqId: sent.reqId + 999,
      props: fakeProps('m', 7),
    });
    // The matching reply is what resolves.
    worker.reply({ type: 'intersection', reqId: sent.reqId, props: fakeProps('m', 1) });
    await expect(promise).resolves.toMatchObject({ identity: { expressId: 1 } });
  });

  it('rejects on an error reply correlated by reqId', async () => {
    const { repo, worker } = setup();
    const promise = repo.intersectProperties([ident('m', 1)]);
    const sent = lastIntersect(worker);
    worker.reply({ type: 'error', reqId: sent.reqId, message: 'boom' });
    await expect(promise).rejects.toThrow('boom');
  });

  it('returns the empty synthetic when called with no identities', async () => {
    const { repo, worker } = setup();
    const result = await repo.intersectProperties([]);
    // No intersect posted — the proxy short-circuits the empty path.
    expect(worker.posted.filter((m) => m.type === 'intersect')).toHaveLength(0);
    expect(result.flat).toEqual([]);
  });
});

describe('WorkerPropertyRepository.intersectProperties — cross-model split + combine', () => {
  it('posts one intersect per model with each model\'s expressIds', async () => {
    const { repo, worker } = setup();
    const promise = repo.intersectProperties([
      ident('m1', 1),
      ident('m2', 10),
      ident('m1', 2),
      ident('m2', 11),
    ]);
    void promise; // unawaited; we only inspect outbound messages here.

    const intersects = allIntersects(worker);
    expect(intersects).toHaveLength(2);
    // Order preserved within each model.
    const m1 = intersects.find((m) => m.id === 'm1');
    const m2 = intersects.find((m) => m.id === 'm2');
    expect(m1?.expressIds).toEqual([1, 2]);
    expect(m2?.expressIds).toEqual([10, 11]);
  });

  it('combines per-model synthetic results — modelId collapses to (mixed)', async () => {
    const { repo, worker } = setup();
    const promise = repo.intersectProperties([ident('m1', 1), ident('m2', 2)]);

    const intersects = allIntersects(worker);
    expect(intersects).toHaveLength(2);
    // Reply each model with a synthetic of its own modelId. The proxy
    // combines them; cross-model identity collapses to '(mixed)'.
    for (const sent of intersects) {
      worker.reply({
        type: 'intersection',
        reqId: sent.reqId,
        props: fakeProps(sent.id, 0),
      });
    }
    const result = await promise;
    expect(result.identity.modelId).toBe('(mixed)');
  });

  it('one model erroring rejects the whole call', async () => {
    const { repo, worker } = setup();
    const promise = repo.intersectProperties([ident('m1', 1), ident('m2', 2)]);

    const intersects = allIntersects(worker);
    // Reply m1 with success, m2 with error.
    worker.reply({
      type: 'intersection',
      reqId: intersects[0].reqId,
      props: fakeProps(intersects[0].id, 0),
    });
    worker.reply({
      type: 'error',
      reqId: intersects[1].reqId,
      message: 'm2 blew up',
    });
    await expect(promise).rejects.toThrow('m2 blew up');
  });
});

describe('WorkerPropertyRepository.intersectProperties — progress', () => {
  it('forwards progress messages to the per-call onProgress callback', async () => {
    const { repo, worker } = setup();
    const calls: Array<[number, number]> = [];
    const promise = repo.intersectProperties([ident('m', 1), ident('m', 2)], (d, t) => {
      calls.push([d, t]);
    });
    const sent = lastIntersect(worker);

    worker.reply({ type: 'progress', reqId: sent.reqId, done: 1, total: 2 });
    worker.reply({ type: 'progress', reqId: sent.reqId, done: 2, total: 2 });
    worker.reply({ type: 'intersection', reqId: sent.reqId, props: fakeProps('m', 0) });

    await promise;
    expect(calls).toEqual([[1, 2], [2, 2]]);
  });

  it('cross-model progress sums across models', async () => {
    const { repo, worker } = setup();
    const calls: Array<[number, number]> = [];
    const promise = repo.intersectProperties(
      [ident('m1', 1), ident('m1', 2), ident('m2', 3)],
      (d, t) => {
        calls.push([d, t]);
      },
    );

    const intersects = allIntersects(worker);
    const m1 = intersects.find((m) => m.id === 'm1');
    const m2 = intersects.find((m) => m.id === 'm2');
    if (!m1 || !m2) throw new Error('missing intersect');

    // m1: progress 1/2 then 2/2.  m2: progress 1/1.
    // Summed (m1+m2): 1/3, 2/3, 3/3 — the inspector sees a single counter.
    worker.reply({ type: 'progress', reqId: m1.reqId, done: 1, total: 2 });
    worker.reply({ type: 'progress', reqId: m1.reqId, done: 2, total: 2 });
    worker.reply({ type: 'progress', reqId: m2.reqId, done: 1, total: 1 });

    // Resolve both so the promise can settle.
    worker.reply({ type: 'intersection', reqId: m1.reqId, props: fakeProps('m1', 0) });
    worker.reply({ type: 'intersection', reqId: m2.reqId, props: fakeProps('m2', 0) });
    await promise;

    // Final aggregate must reach the full totals.
    const last = calls[calls.length - 1];
    expect(last[0]).toBe(3);
    expect(last[1]).toBe(3);
    // Monotonic done counter — never goes backwards.
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i][0]).toBeGreaterThanOrEqual(calls[i - 1][0]);
    }
  });

  it('omitted onProgress is harmless — progress messages just no-op', async () => {
    const { repo, worker } = setup();
    const promise = repo.intersectProperties([ident('m', 1)]);
    const sent = lastIntersect(worker);
    expect(() =>
      worker.reply({ type: 'progress', reqId: sent.reqId, done: 1, total: 1 }),
    ).not.toThrow();
    worker.reply({ type: 'intersection', reqId: sent.reqId, props: fakeProps('m', 0) });
    await promise;
  });

  it('progress for an unknown reqId is silently ignored', async () => {
    const { repo, worker } = setup();
    void repo;
    expect(() =>
      worker.reply({ type: 'progress', reqId: 99999, done: 1, total: 2 }),
    ).not.toThrow();
  });
});

describe('WorkerPropertyRepository.intersectProperties — memo isolation', () => {
  it('does NOT populate the single-get memo for elements covered by intersect', async () => {
    const { repo, worker } = setup();
    const promise = repo.intersectProperties([ident('m', 42), ident('m', 43)]);
    const sent = lastIntersect(worker);
    worker.reply({ type: 'intersection', reqId: sent.reqId, props: fakeProps('m', 0) });
    await promise;

    // A subsequent get() for 42 should issue a NEW getProps — the memo
    // was deliberately not populated by intersect. This is the drill-down
    // trade-off: option (a) of the source-of-truth doc.
    const getPropsCountBefore = worker.posted.filter((m) => m.type === 'getProps').length;
    void repo.get('m', 42);
    const getPropsCountAfter = worker.posted.filter((m) => m.type === 'getProps').length;
    expect(getPropsCountAfter).toBe(getPropsCountBefore + 1);
  });

  it('intersect does not interfere with a previously-memoized single get', async () => {
    const { repo, worker } = setup();
    // Prime the memo for expressId 1.
    const p1 = repo.get('m', 1);
    worker.reply({
      type: 'props',
      reqId: lastGetProps(worker).reqId,
      props: fakeProps('m', 1),
    });
    await p1;
    const getPropsAfterFirst = worker.posted.filter((m) => m.type === 'getProps').length;

    // Run an intersection that includes that same expressId.
    const promise = repo.intersectProperties([ident('m', 1), ident('m', 2)]);
    worker.reply({
      type: 'intersection',
      reqId: lastIntersect(worker).reqId,
      props: fakeProps('m', 0),
    });
    await promise;

    // Get for expressId 1 still serves from the memo — no new getProps.
    const p2 = repo.get('m', 1);
    expect(worker.posted.filter((m) => m.type === 'getProps').length).toBe(getPropsAfterFirst);
    await expect(p2).resolves.toMatchObject({ identity: { expressId: 1 } });
  });
});

describe('WorkerPropertyRepository — crash rejects intersect requests too', () => {
  it('an inflight intersect rejects on worker crash', async () => {
    const { repo, worker } = setup();
    const promise = repo.intersectProperties([ident('m', 1)]);
    worker.crash();
    await expect(promise).rejects.toThrow(/crashed/);
  });
});
