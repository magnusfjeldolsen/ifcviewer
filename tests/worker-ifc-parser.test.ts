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

    worker.reply({ type: 'listed', id: 'm', total: 3 });
    worker.reply({ type: 'batch', id: 'm', meshes: [mesh(1), mesh(2)], products: 2 });
    worker.reply({ type: 'batch', id: 'm', meshes: [mesh(3)], products: 1 });
    worker.reply({ type: 'parsed', id: 'm' });

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

    worker.reply({ type: 'batch', id: 'B', meshes: [mesh(9)], products: 1 });
    worker.reply({ type: 'parsed', id: 'B' });
    worker.reply({ type: 'parsed', id: 'A' });

    const [a, b] = await Promise.all([pa, pb]);
    expect(a.meshCount).toBe(0);
    expect(b.meshCount).toBe(1);
  });

  it('rejects the matching promise on an error reply', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);

    const promise = parser.parseStreaming(new ArrayBuffer(8), 'bad', () => {});
    worker.reply({ type: 'error', id: 'bad', message: 'parse blew up' });

    await expect(promise).rejects.toThrow('parse blew up');
  });

  it('an error for one model does not reject another in-flight parse', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);

    const pa = parser.parseStreaming(new ArrayBuffer(4), 'A', () => {});
    const pb = parser.parseStreaming(new ArrayBuffer(4), 'B', () => {});

    worker.reply({ type: 'error', id: 'A', message: 'only A failed' });
    worker.reply({ type: 'parsed', id: 'B' });

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

    worker.reply({ type: 'parsed', id: 'restore-1' });
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects openForProperties on an error reply', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);

    const promise = parser.openForProperties(new ArrayBuffer(8), 'restore-2');
    worker.reply({ type: 'error', id: 'restore-2', message: 'open failed' });

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
    worker.reply({ type: 'listed', id: 'm', total: 2 });
    worker.reply({ type: 'batch', id: 'm', meshes: [mesh(1)], products: 2 });
    worker.reply({ type: 'batch', id: 'm', meshes: [mesh(2)], products: 1 });
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
    expect(posted(main).find((m) => m.type === 'chunkPort')).toMatchObject({ id: 'm' });
    expect(coordinators).toHaveLength(1);
    expect(coordinators[0].posted).toHaveLength(0); // nothing to hand out yet

    main.reply({ type: 'listed', id: 'm', total: ids.length, ids });
    const plan = posted(coordinators[0])[0];
    expect(plan).toMatchObject({ type: 'plan', ids });
    expect(plan.ports).toHaveLength(3);
    expect(coordinators[0].transfers[0]).toEqual(plan.ports);
  });
  it('counts batches from every worker into one progress', () => {
    const { main, helpers, parser } = sharedSetup(1);
    const onBatch = vi.fn();
    void parser.parseStreaming(new ArrayBuffer(8), 'm', onBatch);
    main.reply({ type: 'listed', id: 'm', total: 10, ids });
    main.reply({ type: 'batch', id: 'm', meshes: [mesh(1)], products: 3 });
    helpers[0].reply({ type: 'batch', id: 'm', meshes: [mesh(2), mesh(3)], products: 4 });
    expect(onBatch.mock.calls.map((c) => c[1])).toEqual([
      { loaded: 3, total: 10 },
      { loaded: 7, total: 10 },
    ]);
  });

  it('resolves once the main worker and every helper are done, and ends the helpers and the coordinator', async () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', id: 'm', total: ids.length, ids });
    main.reply({ type: 'batch', id: 'm', meshes: [mesh(1), mesh(2)], products: 2 });
    let settled = false;
    void done.then(() => (settled = true));
    main.reply({ type: 'parsed', id: 'm' });
    helpers[0].reply({ type: 'shareDone', id: 'm' });
    await Promise.resolve();
    expect(settled).toBe(false); // helper 2 is still streaming
    helpers[1].reply({ type: 'batch', id: 'm', meshes: [mesh(3)], products: 1 });
    helpers[1].reply({ type: 'shareDone', id: 'm' });
    await expect(done).resolves.toMatchObject({ id: 'm', meshCount: 3 });
    expect(helpers.every((h) => h.terminated)).toBe(true);
    expect(coordinators[0].terminated).toBe(true);
    expect(main.terminated).toBe(false); // it keeps the model for properties
  });

  it('a helper that dies hands its chunks back through the coordinator; the parse goes on', async () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', id: 'm', total: ids.length, ids });
    helpers[0].crash();
    helpers[1].reply({ type: 'error', id: 'm', message: 'out of memory' });
    expect(helpers.every((h) => h.terminated)).toBe(true);
    expect(posted(coordinators[0]).filter((m) => m.type === 'fail')).toEqual([
      { type: 'fail', worker: 1 },
      { type: 'fail', worker: 2 },
    ]);
    main.reply({ type: 'parsed', id: 'm' });
    await expect(done).resolves.toMatchObject({ id: 'm' });
  });

  it('a failing main worker rejects the parse and ends the helpers and the coordinator', async () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', id: 'm', total: ids.length, ids });
    main.reply({ type: 'error', id: 'm', message: 'broken file' });
    await expect(done).rejects.toThrow('broken file');
    expect(helpers.every((h) => h.terminated)).toBe(true);
    expect(coordinators[0].terminated).toBe(true);
  });

  it('a crashed coordinator fails the parse rather than leaving it waiting', async () => {
    const { main, coordinators, parser } = sharedSetup(1);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', id: 'm', total: ids.length, ids });
    coordinators[0].crash();
    await expect(done).rejects.toThrow(/coordinator/);
    // The main worker is told to stop, so its queue does not hang.
    expect(posted(main)).toContainEqual({ type: 'stopShare', id: 'm' });
  });

  it('removing the model mid-load ends the helpers and stops the main worker before the close', async () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', id: 'm', total: ids.length, ids });
    parser.disposeModel('m');
    expect(helpers.every((h) => h.terminated)).toBe(true);
    expect(coordinators[0].terminated).toBe(true);
    const types = posted(main).map((m) => m.type);
    expect(types.indexOf('stopShare')).toBeLessThan(types.indexOf('disposeModel'));
    main.reply({ type: 'parsed', id: 'm' });
    await expect(done).resolves.toMatchObject({ id: 'm' });
  });

  it('removing the model before it is listed ends the helpers and still frees the main worker', async () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    parser.disposeModel('m');
    expect(helpers.every((h) => h.terminated)).toBe(true);
    expect(coordinators[0].terminated).toBe(true);
    // The main worker hears it is to stop, even though it has not listed yet.
    expect(posted(main)).toContainEqual({ type: 'stopShare', id: 'm' });
    main.reply({ type: 'listed', id: 'm', total: ids.length, ids });
    expect(coordinators[0].posted).toHaveLength(0);
    main.reply({ type: 'parsed', id: 'm' });
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
    main.reply({ type: 'listed', id: 'm', total: ids.length, ids });
    expect(posted(coordinator).map((m) => m.type)).toEqual(['plan', 'fail']);
    expect(posted(coordinator)[1]).toEqual({ type: 'fail', worker: 1 });
  });
  it('merges the workers’ timings and says how many helpers there were', async () => {
    const { main, helpers, parser } = sharedSetup(1);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    main.reply({ type: 'listed', id: 'm', total: 0, ids: [] });
    helpers[0].reply({ type: 'shareStreamed', id: 'm', timings: { marks: { 'helper.opened': 5 }, spans: { 'helper.open': 3 } } });
    main.reply({ type: 'parsed', id: 'm', timings: { marks: { 'worker.opened': 2 }, spans: { 'worker.open': 4 } } });
    const model = await done;
    expect(model.timings).toEqual({
      marks: { 'worker.opened': 2, 'helper.opened': 5 },
      spans: { 'worker.open': 4, 'helper.open': 3, helpers: 1 },
    });
  });

  it('dispose terminates helpers and the coordinator as well as the main worker', () => {
    const { main, helpers, coordinators, parser } = sharedSetup(2);
    void parser.parseStreaming(new ArrayBuffer(8), 'm', () => {}).catch(() => {});
    main.reply({ type: 'listed', id: 'm', total: ids.length, ids });
    parser.dispose();
    expect(main.terminated).toBe(true);
    expect(coordinators[0].terminated).toBe(true);
    expect(helpers.every((h) => h.terminated)).toBe(true);
  });

  it('a parse without helpers needs no coordinator', () => {
    const { main, coordinators, parser } = sharedSetup(0);
    void parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    expect(main.posted[0]).toEqual({ type: 'parse', id: 'm', buffer: expect.any(ArrayBuffer) });
    main.reply({ type: 'listed', id: 'm', total: 3 });
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
    worker.reply({ type: 'parsed', id: 'm' });
    const model = await done;
    // The load settles first; the disk catches up after.
    worker.reply({ type: 'cacheWritten', id: 'm', report: { ok: true, parts: 3, bytes: 300 } });
    await expect(model.cache).resolves.toMatchObject({ ok: true, parts: 3, bytes: 300 });
  });

  it('without a key there is nothing to wait for', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {});
    expect(worker.posted[0]).not.toHaveProperty('cacheKey');
    worker.reply({ type: 'parsed', id: 'm' });
    expect((await done).cache).toBeUndefined();
  });

  it('a shared load is cached once the main worker and every helper have stored their parts', async () => {
    const { main, helpers, parser } = sharedSetup(2);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {}, undefined, { cacheKey: 'k' });
    main.reply({ type: 'listed', id: 'm', total: ids.length, ids });
    expect(helpers.map((h) => h.posted[0])).toEqual([
      expect.objectContaining({ type: 'share', worker: 1, cacheKey: 'k' }),
      expect.objectContaining({ type: 'share', worker: 2, cacheKey: 'k' }),
    ]);
    // Helpers report "all delivered" before their writes finish: the load settles then.
    helpers[0].reply({ type: 'shareStreamed', id: 'm' });
    helpers[1].reply({ type: 'shareStreamed', id: 'm' });
    main.reply({ type: 'parsed', id: 'm' });
    const model = await done;
    expect(helpers.some((h) => h.terminated)).toBe(false); // still writing
    let settled = false;
    void model.cache!.then(() => (settled = true));
    main.reply({ type: 'cacheWritten', id: 'm', report: { ok: true, parts: 2, bytes: 20, files: [{ worker: 0, sizes: [10, 10] }] } });
    helpers[0].reply({ type: 'shareDone', id: 'm', cache: { ok: true, parts: 1, bytes: 10, files: [{ worker: 1, sizes: [10] }] } });
    await Promise.resolve();
    expect(settled).toBe(false);
    helpers[1].reply({ type: 'shareDone', id: 'm', cache: { ok: true, parts: 4, bytes: 40, files: [{ worker: 2, sizes: [10, 10, 10, 10] }] } });
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
    main.reply({ type: 'listed', id: 'm', total: ids.length, ids });
    helpers[0].crash();
    main.reply({ type: 'parsed', id: 'm' });
    const model = await done;
    main.reply({ type: 'cacheWritten', id: 'm', report: { ok: true, parts: 2, bytes: 20 } });
    await expect(model.cache).resolves.toMatchObject({ ok: false });
  });

  it('removing the model before its parts are stored spoils the cache write', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const done = parser.parseStreaming(new ArrayBuffer(8), 'm', () => {}, undefined, { cacheKey: 'k' });
    worker.reply({ type: 'parsed', id: 'm' });
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
    worker.reply({ type: 'error', id: 'm', message: 'bad' });
    await expect(done).rejects.toThrow('bad');
    expect(cache).toBeUndefined();
  });
});
