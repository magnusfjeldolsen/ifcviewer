/**
 * An older build of the viewer, open in another tab, holds the database at
 * its version and does not let go; the upgrade a newer tab asks for is then
 * "blocked" and never completes. Nothing in the viewer may wait on that.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { SessionStore, STORAGE_OPEN_TIMEOUT_MS } from '../src/services/SessionStore';

/** An IDBOpenDBRequest the test settles by hand. */
interface FakeRequest {
  result?: unknown;
  error?: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
  onupgradeneeded: ((e: { oldVersion: number }) => void) | null;
}

let requests: FakeRequest[] = [];

beforeEach(() => {
  requests = [];
  vi.stubGlobal('indexedDB', {
    open: () => {
      const r: FakeRequest = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      requests.push(r);
      return r;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A database that answers `get` with nothing and completes every transaction. */
function fakeDb() {
  return {
    objectStoreNames: { contains: () => true },
    onversionchange: null as null | (() => void),
    close: vi.fn(),
    transaction: () => {
      const tx = {
        oncomplete: null as null | (() => void),
        onerror: null,
        objectStore: () => ({
          get: () => {
            const req = { result: undefined, onsuccess: null as null | (() => void), onerror: null };
            setTimeout(() => req.onsuccess?.(), 0);
            return req;
          },
          put: () => setTimeout(() => tx.oncomplete?.(), 0),
        }),
      };
      return tx;
    },
  };
}

describe('SessionStore when another tab blocks the upgrade', () => {
  it('fails at once instead of hanging, and says why', async () => {
    const store = new SessionStore();
    const blocked = vi.fn();
    store.onStorageBlocked(blocked);
    const get = store.getModel('m');
    requests[0].onblocked?.();
    await expect(get).resolves.toBeNull();
    await expect(store.saveModel('m', 'm.ifc', new ArrayBuffer(4))).resolves.toBeUndefined();
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(store.isStorageBlocked()).toBe(true);
  });

  it('works again once the other tab lets go', async () => {
    const store = new SessionStore();
    const get = store.getModel('m');
    requests[0].onblocked?.();
    await get;
    requests[0].result = fakeDb();
    requests[0].onsuccess?.();
    expect(store.isStorageBlocked()).toBe(false);
    await expect(store.getModel('m')).resolves.toBeNull(); // answered by the database now
    expect(requests).toHaveLength(1); // the same open request, not a new one
  });

  it('gives up after a timeout when the database never answers at all', async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const get = store.getModel('m');
    await vi.advanceTimersByTimeAsync(STORAGE_OPEN_TIMEOUT_MS + 1);
    await expect(get).resolves.toBeNull();
  });
});
