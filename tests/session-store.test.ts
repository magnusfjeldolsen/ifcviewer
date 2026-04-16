import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from '../src/services/SessionStore';
import type { SessionState } from '../src/services/SessionStore';

// Mock localStorage for node environment
const store = new Map<string, string>();
const localStorageMock: Storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => { store.clear(); },
  get length() { return store.size; },
  key: (index: number) => [...store.keys()][index] ?? null,
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

describe('SessionStore', () => {
  let sessionStore: SessionStore;

  beforeEach(() => {
    store.clear();
    sessionStore = new SessionStore();
  });

  it('should default memoryEnabled to true when key is absent', () => {
    expect(sessionStore.isMemoryEnabled()).toBe(true);
  });

  it('should return false after setMemoryEnabled(false)', () => {
    sessionStore.setMemoryEnabled(false);
    expect(sessionStore.isMemoryEnabled()).toBe(false);
  });

  it('should return true after setMemoryEnabled(true)', () => {
    sessionStore.setMemoryEnabled(false);
    sessionStore.setMemoryEnabled(true);
    expect(sessionStore.isMemoryEnabled()).toBe(true);
  });

  it('should round-trip session state', () => {
    const state: SessionState = {
      camera: {
        position: { x: 1, y: 2, z: 3 },
        target: { x: 4, y: 5, z: 6 },
      },
    };
    sessionStore.saveSession(state);
    expect(sessionStore.getSession()).toEqual(state);
  });

  it('should return null when no session is saved', () => {
    expect(sessionStore.getSession()).toBeNull();
  });

  it('should return null for corrupt JSON in session key', () => {
    store.set('ifcviewer:session', '{not valid json');
    expect(sessionStore.getSession()).toBeNull();
  });

  it('should clear session data but keep toggle key', () => {
    sessionStore.setMemoryEnabled(true);
    sessionStore.saveSession({
      camera: {
        position: { x: 1, y: 2, z: 3 },
        target: { x: 0, y: 0, z: 0 },
      },
    });

    sessionStore.clearSession();

    expect(sessionStore.getSession()).toBeNull();
    expect(sessionStore.isMemoryEnabled()).toBe(true);
  });
});
