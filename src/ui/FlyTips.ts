/**
 * The keys for flying, shown only while flying (#98), with the cruising speed
 * as it changes. Collapses to just the speed; that choice is remembered.
 *
 * Sits under the toolbar, in the gap between the Models panel on the left and
 * the Parameters panel / colour legend on the right, and ignores the pointer
 * everywhere but its own button, so it never gets in the way of a drag.
 */

const COLLAPSED_KEY = 'ifcviewer:fly-tips-collapsed';

const TIPS: ReadonlyArray<readonly [string, string]> = [
  ['W A S D', 'Forward, left, back, right'],
  ['E / Q', 'Up / down'],
  ['← →', 'Turn left / right'],
  ['↑ ↓', 'Look up / down'],
  ['Drag', 'Look around'],
  ['Scroll, X / Z', 'Faster / slower'],
  ['Shift', 'Hold to go 4× faster'],
  ['Space', 'Hold to go slow and precise'],
  ['Esc or G', 'Back to orbit'],
];

/** Cruising speed for display: tidy steps stay tidy (0.75 m/s, 5 m/s). */
export function formatFlySpeed(speed: number): string {
  const text = speed < 1 ? speed.toFixed(2).replace(/0$/, '') : String(Math.round(speed * 100) / 100);
  return `${text} m/s`;
}

export class FlyTips {
  private el: HTMLElement;
  private speedEl: HTMLElement;
  private listEl: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private collapsed: boolean;

  constructor(parent: HTMLElement, initialSpeed: number) {
    this.collapsed = readCollapsed();

    this.el = document.createElement('div');
    this.el.className = 'fly-tips';
    this.el.hidden = true;
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-label', 'Flying');

    const head = document.createElement('div');
    head.className = 'fly-tips-head';
    const title = document.createElement('span');
    title.className = 'fly-tips-title';
    title.textContent = 'Flying';
    this.speedEl = document.createElement('span');
    this.speedEl.className = 'fly-tips-speed';
    this.speedEl.setAttribute('aria-live', 'polite');
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.type = 'button';
    this.toggleBtn.className = 'fly-tips-toggle';
    this.toggleBtn.addEventListener('click', () => {
      this.setCollapsed(!this.collapsed);
      // Off the button, so Space (slow) cannot press it.
      this.toggleBtn.blur();
    });
    head.append(title, this.speedEl, this.toggleBtn);

    this.listEl = document.createElement('dl');
    this.listEl.className = 'fly-tips-list';
    for (const [keys, action] of TIPS) {
      const dt = document.createElement('dt');
      const kbd = document.createElement('kbd');
      kbd.textContent = keys;
      dt.appendChild(kbd);
      const dd = document.createElement('dd');
      dd.textContent = action;
      this.listEl.append(dt, dd);
    }

    this.el.append(head, this.listEl);
    parent.appendChild(this.el);

    this.setSpeed(initialSpeed);
    this.applyCollapsed();
  }

  show(): void {
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }

  isShown(): boolean {
    return !this.el.hidden;
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  setSpeed(speed: number): void {
    this.speedEl.textContent = formatFlySpeed(speed);
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    writeCollapsed(collapsed);
    this.applyCollapsed();
  }

  dispose(): void {
    this.el.remove();
  }

  private applyCollapsed(): void {
    this.el.classList.toggle('collapsed', this.collapsed);
    this.listEl.hidden = this.collapsed;
    this.toggleBtn.textContent = this.collapsed ? 'Keys' : 'Hide';
    this.toggleBtn.title = this.collapsed ? 'Show the flying keys' : 'Hide the flying keys, keep the speed';
    this.toggleBtn.setAttribute('aria-expanded', String(!this.collapsed));
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage blocked: the choice lasts until the page closes.
  }
}
