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

  it('presents the dialog as a modal for assistive tech', () => {
    new CookieBanner(parent);
    const panel = parent.querySelector('.cookie-expanded')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-labelledby')).toBe('cookie-title');
  });

  it('names Google Analytics rather than saying "cookies" and stopping there', () => {
    // A prompt this prominent has to be accurate about what it is asking
    // for; "this site uses cookies" would not describe sharing data with a
    // third party.
    new CookieBanner(parent);
    const text = parent.querySelector('.cookie-expanded')!.textContent ?? '';
    expect(text).toContain('Google');
  });

  it('offers accept and decline as siblings in one button row', () => {
    // Equal prominence is enforced in CSS (identical rules for .accept and
    // .decline); the structural half of that promise is that neither is
    // tucked somewhere else in the DOM.
    new CookieBanner(parent);
    const row = parent.querySelector('.cookie-buttons')!;
    expect(row.querySelector('button.accept')).not.toBeNull();
    expect(row.querySelector('button.decline')).not.toBeNull();
    expect(row.children.length).toBe(2);
  });

  it('records nothing when dismissed with the close button', () => {
    // Dismissal is not a decision. Treating it as one - in either direction -
    // would be inventing a consent signal the user never gave.
    new CookieBanner(parent);
    (parent.querySelector('.cookie-close') as HTMLButtonElement).click();

    expect(CookieConsent.getStatus()).toBe('pending');
    expect(parent.querySelector('.cookie-icon')).not.toBeNull();
    expect(parent.querySelector('.cookie-expanded')).toBeNull();
  });

  it('records nothing when dismissed by clicking the backdrop', () => {
    new CookieBanner(parent);
    (parent.querySelector('.cookie-backdrop') as HTMLElement).click();

    expect(CookieConsent.getStatus()).toBe('pending');
    expect(parent.querySelector('.cookie-icon')).not.toBeNull();
  });

  it('records nothing when dismissed with Escape', () => {
    new CookieBanner(parent);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(CookieConsent.getStatus()).toBe('pending');
    expect(parent.querySelector('.cookie-icon')).not.toBeNull();
  });

  it('asks again on the next visit after a dismissal', () => {
    // The whole point of dismissal-is-not-a-decision: a fresh banner over
    // the same storage must still be pending.
    const first = new CookieBanner(parent);
    (parent.querySelector('.cookie-close') as HTMLButtonElement).click();
    first.dispose();

    new CookieBanner(parent);
    expect(parent.querySelector('.cookie-expanded')).not.toBeNull();
  });

  it('stops listening for Escape once collapsed', () => {
    // The listener is on `document` with capture; leaking it would let a
    // stray Escape anywhere in the app re-enter dialog teardown.
    new CookieBanner(parent);
    (parent.querySelector('.cookie-close') as HTMLButtonElement).click();

    expect(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }).not.toThrow();
    expect(parent.querySelector('.cookie-expanded')).toBeNull();
  });

  it('does not answer for the user when the dialog is reopened and dismissed', () => {
    CookieConsent.accept();
    new CookieBanner(parent);
    (parent.querySelector('.cookie-icon') as HTMLButtonElement).click();
    (parent.querySelector('.cookie-close') as HTMLButtonElement).click();

    // Reopening to look, then closing, must not revoke an existing accept.
    expect(CookieConsent.getStatus()).toBe('accepted');
  });

  it('should expand when icon is clicked', () => {
    CookieConsent.accept();
    new CookieBanner(parent);

    const icon = parent.querySelector('.cookie-icon') as HTMLButtonElement;
    icon.click();

    expect(parent.querySelector('.cookie-expanded')).not.toBeNull();
  });
});
