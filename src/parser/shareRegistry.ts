/**
 * The IFC worker's bookkeeping for shared parses: the coordinator port each
 * parse streams its chunks through, the chunks waiting on it, and stops that
 * arrive before the parse is ready for them.
 *
 * Everything here is keyed by the parse's **token**, not its model id. A
 * model id outlives a parse: Reset View parses the same model again, and two
 * Reset Views in a row queue two parses of it. Keyed by id, the second
 * parse's port landed on the first parse's entry and was lost, the second
 * parse waited for a port forever, and the worker's serial queue — every
 * property query behind it — never moved again.
 */

import type { ToChunkPort } from './ifcMessages';

/** The "no more chunks" message. */
export const NO_MORE: ToChunkPort = { type: 'chunk', index: -1, ids: null };

/** The chunks handed to one parse, in arrival order. */
export class ChunkInbox {
  private items: ToChunkPort[] = [];
  private waiter: ((c: ToChunkPort) => void) | null = null;

  push(chunk: ToChunkPort): void {
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w(chunk);
    } else {
      this.items.push(chunk);
    }
  }

  next(): Promise<ToChunkPort> {
    const c = this.items.shift();
    if (c) return Promise.resolve(c);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

export class ShareRegistry<P> {
  private ports = new Map<number, { promise: Promise<P>; resolve: (p: P) => void }>();
  private inboxes = new Map<number, ChunkInbox>();
  private stopped = new Set<number>();

  private entry(token: number): { promise: Promise<P>; resolve: (p: P) => void } {
    let e = this.ports.get(token);
    if (!e) {
      let resolve!: (p: P) => void;
      const promise = new Promise<P>((r) => {
        resolve = r;
      });
      e = { promise, resolve };
      this.ports.set(token, e);
    }
    return e;
  }

  /** The `chunkPort` message for `token` arrived (before or after the parse asks). */
  providePort(token: number, port: P): void {
    this.entry(token).resolve(port);
  }

  /** The port for `token`'s chunks, once it has arrived. */
  portFor(token: number): Promise<P> {
    const promise = this.entry(token).promise;
    void promise.then(() => this.ports.delete(token));
    return promise;
  }

  /** `token` starts taking chunks: its inbox (already holding "no more" if it was stopped first). */
  open(token: number): ChunkInbox {
    const inbox = new ChunkInbox();
    this.inboxes.set(token, inbox);
    if (this.stopped.delete(token)) inbox.push(NO_MORE);
    return inbox;
  }

  /** `token` has finished taking chunks. */
  close(token: number): void {
    this.inboxes.delete(token);
    this.stopped.delete(token);
  }

  /** Stop `token` after the chunks it already has, now or as soon as it starts. */
  stop(token: number): void {
    const inbox = this.inboxes.get(token);
    if (inbox) inbox.push(NO_MORE);
    else this.stopped.add(token);
  }

  /** Entries held (tests check nothing leaks). */
  get size(): number {
    return this.ports.size + this.inboxes.size + this.stopped.size;
  }
}
