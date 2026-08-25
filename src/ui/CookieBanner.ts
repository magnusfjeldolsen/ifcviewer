import { CookieConsent } from '../services/CookieConsent';

/**
 * Analytics consent prompt.
 *
 * Presented as a **centred dialog over a dimmed backdrop**, not a strip along
 * the bottom edge: a corner banner is trivially ignored, and a consent signal
 * nobody read is not worth having.
 *
 * Three things it deliberately does NOT do, because a prompt this prominent
 * would otherwise shade into a dark pattern:
 *
 * 1. **Accept and Decline are the same size, weight and colour.** Making
 *    "Accept" the loud one is the classic cookie-banner trick; a refusal has
 *    to be exactly as easy as consent or the consent is not freely given.
 * 2. **It is dismissible without answering** — `Esc`, the backdrop, or the
 *    close button. The viewer stays fully usable either way, so this is never
 *    a wall demanding consent in exchange for the app. Dismissing records
 *    *nothing*, so the prompt returns on the next visit.
 * 3. **It says what is actually collected**, including that it is Google
 *    Analytics and that Google receives the data. It also says what is *not*
 *    collected, which is the part people actually care about here: the IFC
 *    files never leave the browser.
 *
 * Once answered (or dismissed) it collapses to a small cookie icon that
 * reopens the dialog, so a choice can always be revisited.
 */
export class CookieBanner {
  private container: HTMLElement;
  private onAcceptCallback: (() => void) | null = null;
  /** Bound while the dialog is open so `Esc` and the focus trap work. */
  private keyListener: ((e: KeyboardEvent) => void) | null = null;
  /** Whatever had focus before the dialog opened, restored on close. */
  private previouslyFocused: HTMLElement | null = null;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'cookie-banner';
    parent.appendChild(this.container);

    if (CookieConsent.getStatus() === 'pending') {
      this.renderExpanded();
    } else {
      this.renderIcon();
    }
  }

  onAccept(cb: () => void): void {
    this.onAcceptCallback = cb;
  }

  private renderIcon(): void {
    this.teardownDialog();
    this.container.innerHTML = '';
    this.container.classList.remove('cookie-banner-open');

    const icon = document.createElement('button');
    icon.className = 'cookie-icon';
    icon.type = 'button';
    icon.textContent = '\u{1F36A}';
    icon.title = 'Cookie preferences';
    icon.setAttribute('aria-label', 'Cookie preferences');
    icon.addEventListener('click', () => this.renderExpanded());
    this.container.appendChild(icon);
  }

  private renderExpanded(): void {
    this.container.innerHTML = '';
    // The open class is what turns the corner-anchored container into a
    // full-viewport overlay; the collapsed icon must not sit under one.
    this.container.classList.add('cookie-banner-open');
    this.previouslyFocused = document.activeElement as HTMLElement | null;

    const backdrop = document.createElement('div');
    backdrop.className = 'cookie-backdrop';
    // Clicking away is a dismissal, not a decision — see the class comment.
    backdrop.addEventListener('click', () => this.dismiss());

    const panel = document.createElement('div');
    panel.className = 'cookie-expanded';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'cookie-title');

    const title = document.createElement('h2');
    title.className = 'cookie-title';
    title.id = 'cookie-title';
    title.textContent = '\u{1F36A} Can we count your visit?';

    const body = document.createElement('p');
    body.className = 'cookie-body';
    body.textContent =
      'This is a free, open-source IFC viewer, and the only thing I really '
      + 'want to know is whether anyone uses it. Saying yes loads Google '
      + 'Analytics, which sets cookies and tells Google roughly where you are '
      + 'and what browser you use.';

    const reassurance = document.createElement('p');
    reassurance.className = 'cookie-body cookie-body-quiet';
    reassurance.textContent =
      'Either way, the models you open never leave your browser — there is no '
      + 'server to send them to. You can change your mind any time from the '
      + 'cookie icon.';

    const buttons = document.createElement('div');
    buttons.className = 'cookie-buttons';

    // Same class, same size, same weight — only the label differs.
    const declineBtn = document.createElement('button');
    declineBtn.className = 'decline';
    declineBtn.type = 'button';
    declineBtn.textContent = 'No thanks';
    declineBtn.addEventListener('click', () => {
      CookieConsent.decline();
      this.renderIcon();
    });

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'accept';
    acceptBtn.type = 'button';
    acceptBtn.textContent = 'Yes, count me';
    acceptBtn.addEventListener('click', () => {
      CookieConsent.accept();
      this.onAcceptCallback?.();
      this.renderIcon();
    });

    const close = document.createElement('button');
    close.className = 'cookie-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Ask me later';
    close.setAttribute('aria-label', 'Ask me later');
    close.addEventListener('click', () => this.dismiss());

    buttons.append(declineBtn, acceptBtn);
    panel.append(close, title, body, reassurance, buttons);
    this.container.append(backdrop, panel);

    this.setupDialogKeys(panel);
    // Focus the panel rather than a button: landing on "Yes" would nudge a
    // keyboard user toward accepting by pressing Enter out of habit.
    panel.tabIndex = -1;
    panel.focus();
  }

  /** Close without recording anything — the prompt returns next visit. */
  private dismiss(): void {
    this.renderIcon();
  }

  private setupDialogKeys(panel: HTMLElement): void {
    this.keyListener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.dismiss();
        return;
      }
      if (e.key !== 'Tab') return;

      // Keep Tab inside the dialog while it is modal, or focus wanders into
      // the viewer behind the backdrop where it cannot be seen.
      const focusable = panel.querySelectorAll<HTMLElement>('button');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', this.keyListener, true);
  }

  private teardownDialog(): void {
    if (this.keyListener) {
      document.removeEventListener('keydown', this.keyListener, true);
      this.keyListener = null;
    }
    if (this.previouslyFocused && document.contains(this.previouslyFocused)) {
      this.previouslyFocused.focus();
    }
    this.previouslyFocused = null;
  }

  dispose(): void {
    this.teardownDialog();
    this.container.remove();
  }
}
