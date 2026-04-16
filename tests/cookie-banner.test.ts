// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { CookieBanner } from '../src/ui/CookieBanner';
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

describe('CookieBanner', () => {
  let parent: HTMLElement;

  beforeEach(() => {
    store.clear();
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  it('should render expanded when consent is pending', () => {
    new CookieBanner(parent);
    expect(parent.querySelector('.cookie-expanded')).not.toBeNull();
    expect(parent.querySelector('.cookie-icon')).toBeNull();
  });

  it('should render icon only when consent is accepted', () => {
    CookieConsent.accept();
    new CookieBanner(parent);
    expect(parent.querySelector('.cookie-icon')).not.toBeNull();
    expect(parent.querySelector('.cookie-expanded')).toBeNull();
  });

  it('should render icon only when consent is declined', () => {
    CookieConsent.decline();
    new CookieBanner(parent);
    expect(parent.querySelector('.cookie-icon')).not.toBeNull();
    expect(parent.querySelector('.cookie-expanded')).toBeNull();
  });

  it('should collapse to icon and save consent on accept click', () => {
    const banner = new CookieBanner(parent);
    let accepted = false;
    banner.onAccept(() => { accepted = true; });

    const acceptBtn = parent.querySelector('button.accept') as HTMLButtonElement;
    acceptBtn.click();

    expect(CookieConsent.getStatus()).toBe('accepted');
    expect(accepted).toBe(true);
    expect(parent.querySelector('.cookie-icon')).not.toBeNull();
  });

  it('should collapse to icon and save consent on decline click', () => {
    new CookieBanner(parent);

    const declineBtn = parent.querySelector('button.decline') as HTMLButtonElement;
    declineBtn.click();

    expect(CookieConsent.getStatus()).toBe('declined');
    expect(parent.querySelector('.cookie-icon')).not.toBeNull();
  });

  it('should expand when icon is clicked', () => {
    CookieConsent.accept();
    new CookieBanner(parent);

    const icon = parent.querySelector('.cookie-icon') as HTMLButtonElement;
    icon.click();

    expect(parent.querySelector('.cookie-expanded')).not.toBeNull();
  });
});
