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

  it('feeds onBatch per batch message and resolves with all meshes accumulated', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);
    const onBatch = vi.fn();

    const promise = parser.parseStreaming(new ArrayBuffer(8), 'm', onBatch);

    worker.reply({ type: 'batch', id: 'm', meshes: [mesh(1), mesh(2)], progress: { loaded: 2, total: 3 } });
    worker.reply({ type: 'batch', id: 'm', meshes: [mesh(3)], progress: { loaded: 3, total: 3 } });
    worker.reply({ type: 'parsed', id: 'm' });

    const model = await promise;
    expect(onBatch).toHaveBeenCalledTimes(2);
    expect(onBatch.mock.calls[0][1]).toEqual({ loaded: 2, total: 3 });
    expect(model.id).toBe('m');
    expect(model.meshes.map((x) => x.expressID)).toEqual([1, 2, 3]);
  });

  it('correlates replies by id when multiple parses are in flight', async () => {
    const worker = new MockWorker();
    const parser = new WorkerIfcParser(worker);

    const pa = parser.parseStreaming(new ArrayBuffer(4), 'A', () => {});
    const pb = parser.parseStreaming(new ArrayBuffer(4), 'B', () => {});

    worker.reply({ type: 'batch', id: 'B', meshes: [mesh(9)], progress: { loaded: 1, total: 1 } });
    worker.reply({ type: 'parsed', id: 'B' });
    worker.reply({ type: 'parsed', id: 'A' });

    const [a, b] = await Promise.all([pa, pb]);
    expect(a.meshes).toHaveLength(0);
    expect(b.meshes.map((x) => x.expressID)).toEqual([9]);
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
