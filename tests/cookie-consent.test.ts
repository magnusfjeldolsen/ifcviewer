import { describe, it, expect, beforeEach } from 'vitest';
import { CookieConsent, DECLINE_REPROMPT_DAYS } from '../src/services/CookieConsent';

const store = new Map<string, string>();
const localStorageMock: Storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => { store.clear(); },
  get length() { return store.size; },
  key: (index: number) => [...store.keys()][index] ?? null,
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, configurable: true });

const KEY = 'ifcviewer:cookieConsent';
const DAY = 24 * 60 * 60 * 1000;
/** A fixed "now" so nothing here depends on the wall clock. */
const NOW = Date.UTC(2026, 7, 19);
const days = (n: number): number => n * DAY;

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
    store.set(KEY, 'invalid');
    expect(CookieConsent.getStatus()).toBe('pending');
  });

  it('should return pending for a stored object with an unknown status', () => {
    store.set(KEY, JSON.stringify({ status: 'maybe', at: NOW }));
    expect(CookieConsent.getStatus()).toBe('pending');
  });
});

describe('CookieConsent decline expiry', () => {
  beforeEach(() => {
    store.clear();
  });

  it('honours a fresh decline right up to the last day', () => {
    CookieConsent.decline(NOW);
    expect(CookieConsent.getStatus(NOW)).toBe('declined');
    expect(CookieConsent.getStatus(NOW + days(DECLINE_REPROMPT_DAYS - 1))).toBe('declined');
  });

  it('asks again once the decline is older than the re-prompt period', () => {
    // The point of the feature: a decline is a moment's reflex, not a
    // permanent position, so it lapses instead of silencing the banner
    // forever.
    CookieConsent.decline(NOW);
    expect(CookieConsent.getStatus(NOW + days(DECLINE_REPROMPT_DAYS))).toBe('pending');
    expect(CookieConsent.getStatus(NOW + days(365))).toBe('pending');
  });

  it('never expires an accept', () => {
    // Consent we act on is only ever re-confirmed in the direction the user
    // can reverse at any time from the cookie icon.
    CookieConsent.accept(NOW);
    expect(CookieConsent.getStatus(NOW + days(3650))).toBe('accepted');
  });

  it('buys another full period when the user declines again', () => {
    CookieConsent.decline(NOW);
    const reAsked = NOW + days(DECLINE_REPROMPT_DAYS);
    expect(CookieConsent.getStatus(reAsked)).toBe('pending');

    CookieConsent.decline(reAsked);
    expect(CookieConsent.getStatus(reAsked)).toBe('declined');
    expect(CookieConsent.getStatus(reAsked + days(DECLINE_REPROMPT_DAYS - 1))).toBe('declined');
  });

  it('re-asks visitors whose decline predates the timestamp format', () => {
    // Shipped format was the bare status string. Those are exactly the
    // declines that have gone unasked the longest.
    store.set(KEY, 'declined');
    expect(CookieConsent.getStatus(NOW)).toBe('pending');
  });

  it('keeps an accept written in the old bare-string format', () => {
    // Losing this would silently stop analytics for everyone who already
    // opted in — the one regression this change must not cause.
    store.set(KEY, 'accepted');
    expect(CookieConsent.getStatus(NOW)).toBe('accepted');
  });

  it('re-asks rather than trusting a timestamp from the future', () => {
    // A clock that was wrong when the decline was written would otherwise
    // silence the banner for as long as the skew lasts.
    store.set(KEY, JSON.stringify({ status: 'declined', at: NOW + days(500) }));
    expect(CookieConsent.getStatus(NOW)).toBe('pending');
  });

  it('re-asks when the stored timestamp is missing or not a number', () => {
    store.set(KEY, JSON.stringify({ status: 'declined' }));
    expect(CookieConsent.getStatus(NOW)).toBe('pending');
    store.set(KEY, JSON.stringify({ status: 'declined', at: 'yesterday' }));
    expect(CookieConsent.getStatus(NOW)).toBe('pending');
  });

  it('survives localStorage being unavailable', () => {
    // Private browsing throws on both read and write; the banner must still
    // render rather than the whole app failing to construct.
    const throwing: Storage = {
      ...localStorageMock,
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
    Object.defineProperty(globalThis, 'localStorage', { value: throwing, configurable: true });
    try {
      expect(() => CookieConsent.decline(NOW)).not.toThrow();
      expect(CookieConsent.getStatus(NOW)).toBe('pending');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
