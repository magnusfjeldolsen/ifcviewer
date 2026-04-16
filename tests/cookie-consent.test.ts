import { describe, it, expect, beforeEach } from 'vitest';
import { CookieConsent } from '../src/services/CookieConsent';

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

describe('CookieConsent', () => {
  beforeEach(() => {
    store.clear();
  });

  it('should return pending when no value is stored', () => {
    expect(CookieConsent.getStatus()).toBe('pending');
  });

  it('should return accepted after accept()', () => {
    CookieConsent.accept();
    expect(CookieConsent.getStatus()).toBe('accepted');
  });

  it('should return declined after decline()', () => {
    CookieConsent.decline();
    expect(CookieConsent.getStatus()).toBe('declined');
  });

  it('should return pending for invalid stored value', () => {
    store.set('ifcviewer:cookieConsent', 'invalid');
    expect(CookieConsent.getStatus()).toBe('pending');
  });
});
