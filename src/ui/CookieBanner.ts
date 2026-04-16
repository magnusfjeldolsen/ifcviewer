import { CookieConsent } from '../services/CookieConsent';

export class CookieBanner {
  private container: HTMLElement;
  private onAcceptCallback: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'cookie-banner';
    parent.appendChild(this.container);

    const status = CookieConsent.getStatus();
    if (status === 'pending') {
      this.renderExpanded();
    } else {
      this.renderIcon();
    }
  }

  onAccept(cb: () => void): void {
    this.onAcceptCallback = cb;
  }

  private renderIcon(): void {
    this.container.innerHTML = '';
    const icon = document.createElement('button');
    icon.className = 'cookie-icon';
    icon.textContent = '\u{1F36A}';
    icon.title = 'Cookie preferences';
    icon.addEventListener('click', () => this.renderExpanded());
    this.container.appendChild(icon);
  }

  private renderExpanded(): void {
    this.container.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'cookie-expanded';

    const text = document.createElement('span');
    text.textContent = '\u{1F36A} This site uses cookies for analytics.';

    const buttons = document.createElement('div');
    buttons.className = 'cookie-buttons';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'accept';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => {
      CookieConsent.accept();
      this.onAcceptCallback?.();
      this.renderIcon();
    });

    const declineBtn = document.createElement('button');
    declineBtn.className = 'decline';
    declineBtn.textContent = 'Decline';
    declineBtn.addEventListener('click', () => {
      CookieConsent.decline();
      this.renderIcon();
    });

    buttons.appendChild(acceptBtn);
    buttons.appendChild(declineBtn);
    panel.appendChild(text);
    panel.appendChild(buttons);
    this.container.appendChild(panel);
  }

  dispose(): void {
    this.container.remove();
  }
}
