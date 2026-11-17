/**
 * Unit tests for `WorkerIfcParser` — the main-thread proxy for the IFC
 * worker's geometry path.
 *
 * The real `ifcWorker.ts` runs web-ifc WASM and cannot be hosted in node /
 * jsdom, so these tests inject a `WorkerLike` stub that records posted
 * messages and lets the test drive replies. This pins down:
 *  - request/reply correlation by model `id`;
 *  - `batch` messages feed `onBatch` and accumulate into the resolved model;
 *  - an `error` reply rejects the matching parse promise;
 *  - `openForProperties` resolves on `parsed` without geometry;
 *  - a worker-level crash rejects every in-flight request.
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkerIfcParser, type WorkerLike } from '../src/parser/WorkerIfcParser';
import type { ToWorker, FromWorker } from '../src/parser/ifcMessages';
import type { ParsedMesh } from '../src/parser/types';


/** A controllable Worker stub. Records posts; lets the test push replies. */
class MockWorker implements WorkerLike {
  posted: ToWorker[] = [];
  transfers: (Transferable[] | undefined)[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  postMessage(message: ToWorker, transfer?: Transferable[]): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Simulate the worker posting a message back to the main thread. */
  reply(msg: FromWorker): void {
    this.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
  }

  /** Simulate a worker-thread crash. */
  crash(): void {
    this.onerror?.({});
  }
}

/** The token of the latest parse / open of model `id` posted to `w`. */
function T(w: MockWorker, id: string): number {
  const msgs = w.posted.filter((m) => (m.type === 'parse' || m.type === 'openForProps') && m.id === id);
  return (msgs[msgs.length - 1] as { token: number }).token;
}

function mesh(expressID: number): ParsedMesh {
  return {
    expressID,
    vertices: new Float32Array([0, 0, 0]),
    normals: new Float32Array([0, 0, 1]),
    indices: new Uint32Array([0]),
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    color: { r: 1, g: 1, b: 1, a: 1 },
  };
}

describe('WorkerIfcParser — parseStreaming', () => {
  it('posts a parse message without transferring the buffer', () => {
    // Regression guard. We deliberately do NOT transfer the .ifc buffer to
    // the worker — the main thread still needs the original alive after this
    // call, for `sessionStore.saveModel` (IDB persistence) and
    // `App.bufferCache` (used by `resetView`). Transferring detached the
    // main-thread ArrayBuffer and turned reloads into "File missing — re-
    // upload" for every model.
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const buffer = new ArrayBuffer(8);

    void parser.parseStreaming(buffer, 'model-1', () => {});

    expect(worker.posted[0]).toMatchObject({ type: 'parse', id: 'model-1' });
    expect(worker.transfers[0]).toBeUndefined();
    expect(buffer.byteLength).toBe(8); // not neutered
  });

  it('feeds onBatch per batch message and resolves with the count, not a second copy of the meshes', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const onBatch = vi.fn();

    const promise = parser.parseStreaming(new ArrayBuffer(8), 'm', onBatch);

    worker.reply({ type: 'listed', token: T(worker, 'm'), total: 3 });
    worker.reply({ type: 'batch', token: T(worker, 'm'), meshes: [mesh(1), mesh(2)], products: 2 });
    worker.reply({ type: 'batch', token: T(worker, 'm'), meshes: [mesh(3)], products: 1 });
    worker.reply({ type: 'parsed', token: T(worker, 'm') });

    const model = await promise;
    expect(onBatch).toHaveBeenCalledTimes(2);
    expect(onBatch.mock.calls[0][1]).toEqual({ loaded: 2, total: 3 });
    expect(model).toEqual({ id: 'm', meshCount: 3 });
    expect(onBatch.mock.calls.flatMap((c) => c[0].map((x: { expressID: number }) => x.expressID))).toEqual([1, 2, 3]);
  });

  it('correlates replies by id when multiple parses are in flight', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);

    const pa = parser.parseStreaming(new ArrayBuffer(4), 'A', () => {});
    const pb = parser.parseStreaming(new ArrayBuffer(4), 'B', () => {});

    worker.reply({ type: 'batch', token: T(worker, 'B'), meshes: [mesh(9)], products: 1 });
    worker.reply({ type: 'parsed', token: T(worker, 'B') });
    worker.reply({ type: 'parsed', token: T(worker, 'A') });

    const [a, b] = await Promise.all([pa, pb]);
    expect(a.meshCount).toBe(0);
    expect(b.meshCount).toBe(1);
  });

  it('rejects the matching promise on an error reply', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);

    const promise = parser.parseStreaming(new ArrayBuffer(8), 'bad', () => {});
    worker.reply({ type: 'error', token: T(worker, 'bad'), message: 'parse blew up' });

    await expect(promise).rejects.toThrow('parse blew up');
  });

  it('an error for one model does not reject another in-flight parse', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);

    const pa = parser.parseStreaming(new ArrayBuffer(4), 'A', () => {});
    const pb = parser.parseStreaming(new ArrayBuffer(4), 'B', () => {});

    worker.reply({ type: 'error', token: T(worker, 'A'), message: 'only A failed' });
    worker.reply({ type: 'parsed', token: T(worker, 'B') });

    await expect(pa).rejects.toThrow('only A failed');
    await expect(pb).resolves.toMatchObject({ id: 'B' });
  });
});

describe('WorkerIfcParser — openForProperties', () => {
  it('posts openForProps and resolves on parsed without geometry', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const buffer = new ArrayBuffer(8);

    const promise = parser.openForProperties(buffer, 'restore-1');
    expect(worker.posted[0]).toMatchObject({ type: 'openForProps', id: 'restore-1' });
    // Same as parseStreaming: no transferable; main keeps the buffer for IDB
    // saves and the bufferCache used by resetView.
    expect(worker.transfers[0]).toBeUndefined();
    expect(buffer.byteLength).toBe(8); // not neutered

    worker.reply({ type: 'parsed', token: T(worker, 'restore-1') });
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects openForProperties on an error reply', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);

    const promise = parser.openForProperties(new ArrayBuffer(8), 'restore-2');
    worker.reply({ type: 'error', token: T(worker, 'restore-2'), message: 'open failed' });

    await expect(promise).rejects.toThrow('open failed');
  });
});

describe('WorkerIfcParser — lifecycle', () => {
  it('disposeModel posts a disposeModel message', () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    parser.disposeModel('m');
    expect(worker.posted).toContainEqual({ type: 'disposeModel', id: 'm' });
  });

  it('dispose posts dispose then terminates the worker', () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    parser.dispose();
    expect(worker.posted).toContainEqual({ type: 'dispose' });
    expect(worker.terminated).toBe(true);
  });

  it('a worker crash rejects every in-flight parse', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);

    const pa = parser.parseStreaming(new ArrayBuffer(4), 'A', () => {});
    const pb = parser.parseStreaming(new ArrayBuffer(4), 'B', () => {});

    worker.crash();

    await expect(pa).rejects.toThrow(/crashed/);
    await expect(pb).rejects.toThrow(/crashed/);
  });

  it('a worker crash notifies onCrash listeners', () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const listener = vi.fn();
    parser.onCrash(listener);
    worker.crash();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('WorkerIfcParser — message multiplexing', () => {
  it('routes props messages to the registered extra sink, not the parse path', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const sink = vi.fn();
    parser.setExtraMessageSink(sink);

    const propsMsg: FromWorker = {
      type: 'props',
      reqId: 7,
      props: {
        identity: { modelId: 'm', expressId: 1, ifcClass: 'IfcWall', ifcTypeCode: 0 },
        direct: [],
        psets: [],
        qtos: [],
        materials: [],
        flat: [],
        fetchedAt: 0,
      },
    };
    worker.reply(propsMsg);
    expect(sink).toHaveBeenCalledWith(propsMsg);
  });

  it('routes reqId-correlated error messages to the extra sink', () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const sink = vi.fn();
    parser.setExtraMessageSink(sink);

    const errMsg: FromWorker = { type: 'error', reqId: 9, message: 'props failed' };
    worker.reply(errMsg);
    expect(sink).toHaveBeenCalledWith(errMsg);
  });
});

describe('WorkerIfcParser — progress', () => {
  it('adds up elements across batches and never reports more total than loaded', () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const onBatch = vi.fn();
    void parser.parseStreaming(new ArrayBuffer(8), 'm', onBatch);
    worker.reply({ type: 'listed', token: T(worker, 'm'), total: 2 });
    worker.reply({ type: 'batch', token: T(worker, 'm'), meshes: [mesh(1)], products: 2 });
    worker.reply({ type: 'batch', token: T(worker, 'm'), meshes: [mesh(2)], products: 1 });
    expect(onBatch.mock.calls.map((c) => c[1])).toEqual([
      { loaded: 2, total: 2 },
      { loaded: 3, total: 3 },
    ]);
  });
});

/** A parser with `n` helper stubs and a coordinator stub, and the stubs. */
function sharedSetup(n: number) {
  const main = new MockWorker();
  const helpers: MockWorker[] = [];
  const coordinators: MockWorker[] = [];
  const parser = new WorkerIfcParser(main, {
    helpersFor: () => n,
    createHelper: () => {
      const h = new MockWorker();
      helpers.push(h);
      return h;
    },
    createCoordinator: () => {
      const c = new MockWorker();
      coordinators.push(c);
      return c;
    },
  });
  return { main, helpers, coordinators, parser };
}

const posted = (w: MockWorker) => w.posted as unknown as Array<Record<string, unknown>>;

describe('WorkerIfcParser — shared parse', () => {
  const ids = Array.from({ length: 100 }, (_, i) => i + 1);

  it('starts the helpers with the main worker, and has the coordinator hand out the list once there is one', () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    const buffer = new ArrayBuffer(8);
    void parser.parseStreaming(buffer, 'm', () => {});
    expect(main.posted[0]).toMatchObject({ type: 'parse', id: 'm', shared: true });
    // The helpers open their copies while the main worker opens its own.
    expect(helpers).toHaveLength(2);
    for (const h of helpers) {
      expect(h.posted[0]).toMatchObject({ type: 'share', id: 'm', buffer });
      // The port is transferred; the file is copied (the main thread keeps it).
      expect(h.transfers[0]).toEqual([posted(h)[0].port]);
    }
    expect(buffer.byteLength).toBe(8);
    expect(posted(main).find((m) => m.type === 'chunkPort')).toMatchObject({ token: T(main, 'm') });
    expect(coordinators).toHaveLength(1);
    expect(coordinators[0].posted).toHaveLength(0); // nothing to hand out yet

    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    const plan = posted(coordinators[0])[0];
    expect(plan).toMatchObject({ type: 'plan', ids });
    expect(plan.ports).toHaveLength(3);
    expect(coordinators[0].transfers[0]).toEqual(plan.ports);
  });
  it('counts batches from every worker into one progress', () => {
    const { main, helpers, parser } = sharedSetup(1);
    const onBatch = vi.fn();
    void parser.parseStreaming(new ArrayBuffer(8), 'm', onBatch);
    main.reply({ type: 'listed', token: T(main, 'm'), total: 10, ids });
    main.reply({ type: 'batch', token: T(main, 'm'), meshes: [mesh(1)], products: 3 });
    helpers[0].reply({ type: 'batch', token: T(main, 'm'), meshes: [mesh(2), mesh(3)], products: 4 });
    expect(onBatch.mock.calls.map((c) => c[1])).toEqual([
      { loaded: 3, total: 10 },
      { loaded: 7, total: 10 },
    ]);
  });

  it('resolves once the main worker and every helper are done, and ends the helpers and the coordinator', async () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    main.reply({ type: 'batch', token: T(main, 'm'), meshes: [mesh(1), mesh(2)], products: 2 });
    let settled = false;
    void done.then(() => (settled = true));
    main.reply({ type: 'parsed', token: T(main, 'm') });
    helpers[0].reply({ type: 'shareDone', token: T(main, 'm') });
    await Promise.resolve();
    expect(settled).toBe(false); // helper 2 is still streaming
    helpers[1].reply({ type: 'batch', token: T(main, 'm'), meshes: [mesh(3)], products: 1 });
    helpers[1].reply({ type: 'shareDone', token: T(main, 'm') });
    await expect(done).resolves.toMatchObject({ id: 'm', meshCount: 3 });
    expect(helpers.every((h) => h.terminated)).toBe(true);
    expect(coordinators[0].terminated).toBe(true);
    expect(main.terminated).toBe(false); // it keeps the model for properties
  });

  it('a helper that dies hands its chunks back through the coordinator; the parse goes on', async () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    helpers[0].crash();
    helpers[1].reply({ type: 'error', token: T(main, 'm'), message: 'out of memory' });
    expect(helpers.every((h) => h.terminated)).toBe(true);
    expect(posted(coordinators[0]).filter((m) => m.type === 'fail')).toEqual([
      { type: 'fail', worker: 1 },
      { type: 'fail', worker: 2 },
    ]);
    main.reply({ type: 'parsed', token: T(main, 'm') });
    await expect(done).resolves.toMatchObject({ id: 'm' });
  });

  it('a failing main worker rejects the parse and ends the helpers and the coordinator', async () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    main.reply({ type: 'error', token: T(main, 'm'), message: 'broken file' });
    await expect(done).rejects.toThrow('broken file');
    expect(helpers.every((h) => h.terminated)).toBe(true);
    expect(coordinators[0].terminated).toBe(true);
  });

  it('a crashed coordinator fails the parse rather than leaving it waiting', async () => {
    const { main, coordinators, parser } = sharedSetup(1);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    coordinators[0].crash();
    await expect(done).rejects.toThrow(/coordinator/);
    // The main worker is told to stop, so its queue does not hang.
    expect(posted(main)).toContainEqual({ type: 'stopShare', token: T(main, 'm') });
  });

  it('removing the model mid-load ends the helpers and stops the main worker before the close', async () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    parser.disposeModel('m');
    expect(helpers.every((h) => h.terminated)).toBe(true);
    expect(coordinators[0].terminated).toBe(true);
    const types = posted(main).map((m) => m.type);
    expect(types.indexOf('stopShare')).toBeLessThan(types.indexOf('disposeModel'));
    main.reply({ type: 'parsed', token: T(main, 'm') });
    await expect(done).resolves.toMatchObject({ id: 'm' });
  });

  it('removing the model before it is listed ends the helpers and still frees the main worker', async () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    parser.disposeModel('m');
    expect(helpers.every((h) => h.terminated)).toBe(true);
    expect(coordinators[0].terminated).toBe(true);
    // The main worker hears it is to stop, even though it has not listed yet.
    expect(posted(main)).toContainEqual({ type: 'stopShare', token: T(main, 'm') });
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    expect(coordinators[0].posted).toHaveLength(0);
    main.reply({ type: 'parsed', token: T(main, 'm') });
    await expect(done).resolves.toMatchObject({ id: 'm' });
  });

  it('a helper that cannot be created is reported to the coordinator, and the others carry on', () => {
    const main = new MockWorker();
    const coordinator = new MockWorker();
    let made = 0;
    const parser = new WorkerIfcParser(main, {
      helpersFor: () => 2,
      createCoordinator: () => coordinator,
      createHelper: () => {
        if (made++ === 0) throw new Error('no more workers');
        return new MockWorker();
      },
    });
    void parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    expect(posted(coordinator).map((m) => m.type)).toEqual(['plan', 'fail']);
    expect(posted(coordinator)[1]).toEqual({ type: 'fail', worker: 1 });
  });
  it('merges the workers’ timings and says how many helpers there were', async () => {
    const { main, helpers, parser } = sharedSetup(1);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', token: T(main, 'm'), total: 0, ids: [] });
    helpers[0].reply({ type: 'shareStreamed', token: T(main, 'm'), timings: { marks: { 'helper.opened': 5 }, spans: { 'helper.open': 3 } } });
    main.reply({ type: 'parsed', token: T(main, 'm'), timings: { marks: { 'worker.opened': 2 }, spans: { 'worker.open': 4 } } });
    const model = await done;
    expect(model.timings).toEqual({
      marks: { 'worker.opened': 2, 'helper.opened': 5 },
      spans: { 'worker.open': 4, 'helper.open': 3, helpers: 1 },
    });
  });

  it('dispose terminates helpers and the coordinator as well as the main worker', () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    void parser.parseStreaming(new ArrayBuffer(8), 'm', () => {}).catch(() => {});
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    parser.dispose();
    expect(main.terminated).toBe(true);
    expect(coordinators[0].terminated).toBe(true);
    expect(helpers.every((h) => h.terminated)).toBe(true);
  });

  it('a parse without helpers needs no coordinator', () => {
    const { main, coordinators, parser } = sharedSetup(0);
    void parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    expect(main.posted[0]).toEqual({ type: 'parse', id: 'm', token: expect.any(Number), buffer: expect.any(ArrayBuffer) });
    main.reply({ type: 'listed', token: T(main, 'm'), total: 3 });
    expect(coordinators).toHaveLength(0);
  });
});
describe('WorkerIfcParser — cache writes', () => {
  const ids = Array.from({ length: 10 }, (_, i) => i + 1);

  it('asks the worker to store the geometry under the key, and says when it is stored', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {}, undefined, { cacheKey: 'k1' });
    expect(worker.posted[0]).toMatchObject({ type: 'parse', id: 'm', cacheKey: 'k1' });
    worker.reply({ type: 'parsed', token: T(worker, 'm') });
    const model = await done;
    // The load settles first; the disk catches up after.
    worker.reply({ type: 'cacheWritten', token: T(worker, 'm'), report: { ok: true, parts: 3, bytes: 300 } });
    await expect(model.cache).resolves.toMatchObject({ ok: true, parts: 3, bytes: 300 });
  });

  it('without a key there is nothing to wait for', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    expect(worker.posted[0]).not.toHaveProperty('cacheKey');
    worker.reply({ type: 'parsed', token: T(worker, 'm') });
    expect((await done).cache).toBeUndefined();
  });

  it('a shared load is cached once the main worker and every helper have stored their parts', async () => {
    const { main, helpers, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {}, undefined, { cacheKey: 'k' });
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    expect(helpers.map((h) => h.posted[0])).toEqual([
      expect.objectContaining({ type: 'share', worker: 1, cacheKey: 'k' }),
      expect.objectContaining({ type: 'share', worker: 2, cacheKey: 'k' }),
    ]);
    // Helpers report "all delivered" before their writes finish: the load settles then.
    helpers[0].reply({ type: 'shareStreamed', token: T(main, 'm') });
    helpers[1].reply({ type: 'shareStreamed', token: T(main, 'm') });
    main.reply({ type: 'parsed', token: T(main, 'm') });
    const model = await done;
    expect(helpers.some((h) => h.terminated)).toBe(false); // still writing
    let settled = false;
    void model.cache!.then(() => (settled = true));
    main.reply({ type: 'cacheWritten', token: T(main, 'm'), report: { ok: true, parts: 2, bytes: 20, files: [{ worker: 0, sizes: [10, 10] }] } });
    helpers[0].reply({ type: 'shareDone', token: T(main, 'm'), cache: { ok: true, parts: 1, bytes: 10, files: [{ worker: 1, sizes: [10] }] } });
    await Promise.resolve();
    expect(settled).toBe(false);
    helpers[1].reply({ type: 'shareDone', token: T(main, 'm'), cache: { ok: true, parts: 4, bytes: 40, files: [{ worker: 2, sizes: [10, 10, 10, 10] }] } });
    // Every worker's file, so the reader can find every part.
    await expect(model.cache).resolves.toEqual({
      ok: true, parts: 7, bytes: 70,
      files: [{ worker: 0, sizes: [10, 10] }, { worker: 1, sizes: [10] }, { worker: 2, sizes: [10, 10, 10, 10] }],
    });
    expect(helpers.every((h) => h.terminated)).toBe(true);
  });

  it('a helper that fails spoils the cache write (its parts may be missing) but not the load', async () => {
    const { main, helpers, parser } = sharedSetup(1);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {}, undefined, { cacheKey: 'k' });
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    helpers[0].crash();
    main.reply({ type: 'parsed', token: T(main, 'm') });
    const model = await done;
    main.reply({ type: 'cacheWritten', token: T(main, 'm'), report: { ok: true, parts: 2, bytes: 20 } });
    await expect(model.cache).resolves.toMatchObject({ ok: false });
  });

  it('removing the model before its parts are stored spoils the cache write', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {}, undefined, { cacheKey: 'k' });
    worker.reply({ type: 'parsed', token: T(worker, 'm') });
    const model = await done;
    parser.disposeModel('m');
    await expect(model.cache).resolves.toMatchObject({ ok: false });
  });

  it('a failed load spoils its cache write', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    let cache: Promise<unknown> | undefined;
    const done = parser
      .parseStreaming(new ArrayBuffer(8), 'm', () => {}, undefined, { cacheKey: 'k' })
      .then((m) => (cache = m.cache));
    worker.reply({ type: 'error', token: T(worker, 'm'), message: 'bad' });
    await expect(done).rejects.toThrow('bad');
    expect(cache).toBeUndefined();
  });
});

describe('WorkerIfcParser — several requests for one model', () => {
  const ids = Array.from({ length: 10 }, (_, i) => i + 1);

  it('a broken cache restore: the properties-only open’s reply does not settle, or starve, the parse that replaces it', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    // Restore: open for properties, read the cache, find it broken…
    const open = parser.openForProperties(new ArrayBuffer(8), 'm');
    const openToken = T(worker, 'm');
    parser.disposeModel('m');
    // …and parse the model instead, under the same id.
    const onBatch = vi.fn();
    const parse = parser.parseStreaming(new ArrayBuffer(8), 'm', onBatch);
    const parseToken = T(worker, 'm');
    expect(parseToken).not.toBe(openToken);

    worker.reply({ type: 'parsed', token: openToken }); // the open finishes first
    await expect(open).resolves.toBeUndefined();
    let settled = false;
    void parse.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    worker.reply({ type: 'listed', token: parseToken, total: 2 });
    worker.reply({ type: 'batch', token: parseToken, meshes: [mesh(1), mesh(2)], products: 2 });
    worker.reply({ type: 'parsed', token: parseToken });
    await expect(parse).resolves.toMatchObject({ meshCount: 2 });
    expect(onBatch).toHaveBeenCalledTimes(1);
  });

  it('Reset View twice: the first parse’s replies reach only the first parse', async () => {
    const { main, coordinators, parser } = sharedSetup(1);
    const first = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    const t1 = T(main, 'm');
    const onBatch2 = vi.fn();
    const second = parser.parseStreaming(new ArrayBuffer(8), 'm', onBatch2);
    const t2 = T(main, 'm');
    // Each has its own port to its own coordinator.
    const ports = posted(main).filter((m) => m.type === 'chunkPort');
    expect(ports.map((m) => m.token)).toEqual([t1, t2]);

    main.reply({ type: 'listed', token: t1, total: ids.length, ids });
    expect(posted(coordinators[0])[0]).toMatchObject({ type: 'plan' });
    expect(coordinators[1].posted).toHaveLength(0); // the second's plan waits for its own list
    main.reply({ type: 'batch', token: t1, meshes: [mesh(1)], products: 1 });
    expect(onBatch2).not.toHaveBeenCalled();
    main.reply({ type: 'parsed', token: t1 });
    parser.disposeModel('m'); // stops the second, which is still queued
    main.reply({ type: 'parsed', token: t2 });
    await expect(first).resolves.toMatchObject({ meshCount: 1 });
    await expect(second).resolves.toMatchObject({ meshCount: 0 });
  });
});

describe('WorkerIfcParser — failures around sharing', () => {
  const ids = Array.from({ length: 10 }, (_, i) => i + 1);

  it('a coordinator that cannot be created makes the parse unshared, rather than leave the worker waiting for chunks', async () => {
    const main = new MockWorker();
    const helpers: MockWorker[] = [];
    const parser = new WorkerIfcParser(main, {
      helpersFor: () => 2,
      createCoordinator: () => {
        throw new Error('no more workers');
      },
      createHelper: () => {
        const h = new MockWorker();
        helpers.push(h);
        return h;
      },
    });
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    expect(main.posted[0]).not.toHaveProperty('shared');
    expect(posted(main).some((m) => m.type === 'chunkPort')).toBe(false);
    expect(helpers).toHaveLength(0);
    main.reply({ type: 'parsed', token: T(main, 'm') });
    await expect(done).resolves.toMatchObject({ id: 'm' });
  });

  it('a share that fails on this side closes the model the main worker opened for it', async () => {
    const { main, coordinators, parser } = sharedSetup(1);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    coordinators[0].crash();
    await expect(done).rejects.toThrow(/coordinator/);
    const types = posted(main).map((m) => m.type);
    expect(types.indexOf('stopShare')).toBeLessThan(types.indexOf('disposeModel'));
  });

  it('tells the coordinator which chunks arrived, and from whom', () => {
    const { main, helpers, coordinators, parser } = sharedSetup(1);
    void parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    const t = T(main, 'm');
    main.reply({ type: 'listed', token: t, total: ids.length, ids });
    main.reply({ type: 'batch', token: t, meshes: [mesh(1)], products: 1 }); // mid-chunk: not a receipt
    main.reply({ type: 'batch', token: t, meshes: [], products: 0, chunk: 0 });
    helpers[0].reply({ type: 'batch', token: t, meshes: [mesh(2)], products: 1, chunk: 3 });
    expect(posted(coordinators[0]).filter((m) => m.type === 'received')).toEqual([
      { type: 'received', worker: 0, index: 0 },
      { type: 'received', worker: 1, index: 3 },
    ]);
  });

  it('a helper that fails before the plan is reported with the plan, so its chunks are never stuck with it', () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    void parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    helpers[1].crash(); // while opening the file
    expect(coordinators[0].posted).toHaveLength(0);
    main.reply({ type: 'listed', token: T(main, 'm'), total: ids.length, ids });
    expect(posted(coordinators[0]).map((m) => m.type)).toEqual(['plan', 'fail']);
    expect(posted(coordinators[0])[1]).toEqual({ type: 'fail', worker: 2 });
  });

  it('batches from a helper after it failed are ignored', () => {
    const { main, helpers, parser } = sharedSetup(1);
    const onBatch = vi.fn();
    void parser.parseStreaming(new ArrayBuffer(8), 'm', onBatch);
    const t = T(main, 'm');
    main.reply({ type: 'listed', token: t, total: ids.length, ids });
    helpers[0].crash();
    helpers[0].reply({ type: 'batch', token: t, meshes: [mesh(9)], products: 1, chunk: 1 });
    expect(onBatch).not.toHaveBeenCalled();
  });
});

describe('WorkerIfcParser — helper budget across loads', () => {
  it('a second load running at the same time sees the memory the first one’s helpers hold', () => {
    const main = new MockWorker();
    const seen: number[] = [];
    const parser = new WorkerIfcParser(main, {
      helpersFor: (bytes, inUse) => {
        seen.push(inUse);
        return 1;
      },
      createHelper: () => new MockWorker(),
      createCoordinator: () => new MockWorker(),
    });
    void parser.parseStreaming(new ArrayBuffer(1000), 'a', () => {});
    void parser.parseStreaming(new ArrayBuffer(1000), 'b', () => {});
    expect(seen).toEqual([0, 3000]);
  });
});
