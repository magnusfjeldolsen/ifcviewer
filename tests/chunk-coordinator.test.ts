import { describe, it, expect } from 'vitest';
import { ChunkCoordinator, PREFETCH_CHUNKS, type ChunkPortLike } from '../src/parser/chunkCoordinator';
import type { ToChunkPort } from '../src/parser/ifcMessages';

class FakePort implements ChunkPortLike {
  got: ToChunkPort[] = [];
  answered = 0;
  postMessage(msg: ToChunkPort): void {
    this.got.push(msg);
  }
  /** Chunks received and not yet reported done. */
  open(): ToChunkPort[] {
    return this.got.slice(this.answered).filter((c) => c.ids !== null);
  }
  stops(): number {
    return this.got.filter((c) => c.ids === null).length;
  }
}

const ids = Array.from({ length: 500 }, (_, i) => i + 1);

/** Run every worker to completion, round-robin; returns ids delivered in order of delivery. */
function runAll(c: ChunkCoordinator, ports: FakePort[], alive: (k: number) => boolean = () => true): number[] {
  const delivered: number[] = [];
  for (let guard = 0; guard < 10000; guard++) {
    let progressed = false;
    ports.forEach((p, key) => {
      if (!alive(key)) return;
      const next = p.got[p.answered];
      if (!next) return;
      p.answered++;
      progressed = true;
      if (next.ids === null) return;
      delivered.push(...next.ids);
      // As in the app: the geometry reaches the main thread, which says so,
      // and the worker asks for the next chunk.
      c.received(key, next.index);
      c.receive(key, { type: 'done', index: next.index });
    });
    if (!progressed) break;
  }
  return delivered;
}

describe('ChunkCoordinator', () => {
  it('gives a ready worker a chunk to stream and one waiting', () => {
    const ports = [new FakePort(), new FakePort()];
    const c = new ChunkCoordinator(ids, ports);
    c.receive(0, { type: 'ready' });
    expect(ports[0].got).toHaveLength(PREFETCH_CHUNKS);
    expect(ports[1].got).toHaveLength(0);
  });

  it('streams every element exactly once across the workers, then tells each once that there is no more', () => {
    const ports = [new FakePort(), new FakePort(), new FakePort()];
    const c = new ChunkCoordinator(ids, ports);
    ports.forEach((_, k) => c.receive(k, { type: 'ready' }));
    const delivered = runAll(c, ports);
    expect([...delivered].sort((a, b) => a - b)).toEqual(ids);
    for (const p of ports) expect(p.stops()).toBe(1);
    // Everyone took part.
    for (const p of ports) expect(p.got.some((m) => m.ids !== null)).toBe(true);
  });

  it('a worker that joins late still gets work while there is some', () => {
    const ports = [new FakePort(), new FakePort()];
    const c = new ChunkCoordinator(ids, ports);
    c.receive(0, { type: 'ready' });
    // Main worker delivers a few chunks alone…
    for (let i = 0; i < 3; i++) {
      const next = ports[0].open()[0];
      ports[0].answered++;
      c.received(0, next.index);
      c.receive(0, { type: 'done', index: next.index });
    }
    // …then the helper is ready.
    c.receive(1, { type: 'ready' });
    expect(ports[1].open().length).toBe(PREFETCH_CHUNKS);
  });

  it('does not stop anyone while a chunk is still out, and hands a failed worker’s chunks to the others', () => {
    const ports = [new FakePort(), new FakePort()];
    const c = new ChunkCoordinator(ids, ports);
    c.receive(1, { type: 'ready' }); // the helper takes two chunks…
    const lost = ports[1].open().flatMap((m) => m.ids!);
    c.receive(0, { type: 'ready' });
    const delivered = runAll(c, ports, (k) => k === 0); // …and never delivers them
    expect(ports[0].stops()).toBe(0); // the main worker waits: chunks are out
    c.fail(1);
    delivered.push(...runAll(c, ports, (k) => k === 0));
    expect([...delivered].sort((a, b) => a - b)).toEqual(ids);
    expect(lost.every((id) => delivered.includes(id))).toBe(true);
    expect(ports[0].stops()).toBe(1);
    expect(ports[1].stops()).toBe(0); // a dead worker is not written to
  });

  it('a worker saying it is done does not make a chunk delivered: only the main thread’s receipt does', () => {
    const ports = [new FakePort(), new FakePort()];
    const c = new ChunkCoordinator([1, 2, 3], ports);
    c.receive(1, { type: 'ready' });
    const held = ports[1].open();
    expect(held.length).toBeGreaterThan(0);
    // The helper finishes its chunks and says so, but dies before its
    // geometry reaches the main thread.
    for (const ch of held) c.receive(1, { type: 'done', index: ch.index });
    c.fail(1);
    // The main worker gets those chunks again: nothing is lost.
    c.receive(0, { type: 'ready' });
    const again = ports[0].open().flatMap((m) => m.ids!);
    expect(again.sort()).toEqual(held.flatMap((m) => m.ids!).sort());
  });

  it('a chunk whose geometry did arrive is not handed out again when its worker fails afterwards', () => {
    const ports = [new FakePort(), new FakePort()];
    const all = Array.from({ length: 100 }, (_, i) => i + 1);
    const c = new ChunkCoordinator(all, ports);
    c.receive(1, { type: 'ready' });
    const [first, second] = ports[1].open();
    c.received(1, first.index); // arrived on the main thread
    c.fail(1); // then the helper died
    c.receive(0, { type: 'ready' });
    const delivered = runAll(c, ports, (k) => k === 0);
    expect(delivered).not.toEqual(expect.arrayContaining(first.ids!));
    expect([...first.ids!, ...delivered].sort((a, b) => a - b)).toEqual(all);
    expect(second.ids!.every((id) => delivered.includes(id))).toBe(true);
  });

  it('end stops everyone still listening, once', () => {
    const ports = [new FakePort(), new FakePort()];
    const c = new ChunkCoordinator(ids, ports);
    c.receive(0, { type: 'ready' });
    c.end();
    c.end();
    expect(ports.map((p) => p.stops())).toEqual([1, 1]);
  });

  it('an empty list stops everyone at once', () => {
    const ports = [new FakePort(), new FakePort()];
    new ChunkCoordinator([], ports);
    expect(ports.map((p) => p.stops())).toEqual([1, 1]);
  });
});
