import { describe, it, expect } from 'vitest';
import { ChunkInbox, NO_MORE, ShareRegistry } from '../src/parser/shareRegistry';

const settled = async <T,>(p: Promise<T>): Promise<{ done: boolean; value?: T }> => {
  let out: { done: boolean; value?: T } = { done: false };
  void p.then((value) => (out = { done: true, value }));
  await new Promise((r) => setTimeout(r, 0));
  return out;
};

describe('ShareRegistry', () => {
  it('two queued parses of the same model each get their own port (Reset View twice)', async () => {
    const r = new ShareRegistry<string>();
    // Both chunkPort messages arrive while the first parse is still opening.
    r.providePort(1, 'port-A');
    r.providePort(2, 'port-B');
    expect(await r.portFor(1)).toBe('port-A');
    expect(await settled(r.portFor(2))).toEqual({ done: true, value: 'port-B' });
  });

  it('keyed by model id instead, the second port is lost and the second parse waits forever', async () => {
    // What the worker did before: the key was the model id, the same for both.
    const r = new ShareRegistry<string>();
    r.providePort(7, 'port-A');
    r.providePort(7, 'port-B'); // lands on the first, already resolved, entry
    expect(await r.portFor(7)).toBe('port-A');
    expect((await settled(r.portFor(7))).done).toBe(false);
  });

  it('a port that arrives after the parse asks for it still reaches it', async () => {
    const r = new ShareRegistry<string>();
    const p = r.portFor(3);
    r.providePort(3, 'late');
    expect(await p).toBe('late');
    expect(r.size).toBe(0);
  });

  it('a stop before the parse takes chunks ends it at once; it does not touch another parse', async () => {
    const r = new ShareRegistry<string>();
    r.stop(1);
    const a = r.open(1);
    expect(await a.next()).toEqual(NO_MORE);
    const b = r.open(2);
    expect((await settled(b.next())).done).toBe(false);
    r.close(1);
    r.close(2);
    expect(r.size).toBe(0);
  });

  it('a stop while streaming comes after the chunks already handed out', async () => {
    const r = new ShareRegistry<string>();
    const inbox = r.open(1);
    inbox.push({ type: 'chunk', index: 0, ids: [1, 2] });
    r.stop(1);
    expect(await inbox.next()).toEqual({ type: 'chunk', index: 0, ids: [1, 2] });
    expect(await inbox.next()).toEqual(NO_MORE);
  });

  it('a stale stop for a finished parse leaves nothing behind once closed', () => {
    const r = new ShareRegistry<string>();
    r.open(1);
    r.close(1);
    r.stop(1); // arrives after the parse ended
    r.close(1);
    expect(r.size).toBe(0);
  });
});

describe('ChunkInbox', () => {
  it('hands out chunks in arrival order, waiting when empty', async () => {
    const inbox = new ChunkInbox();
    const first = inbox.next();
    inbox.push({ type: 'chunk', index: 0, ids: [1] });
    inbox.push({ type: 'chunk', index: 1, ids: [2] });
    expect((await first).index).toBe(0);
    expect((await inbox.next()).index).toBe(1);
  });
});
