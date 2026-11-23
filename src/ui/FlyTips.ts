/**
 * The keys for flying, shown only while flying (#98), with the cruising speed
 * as it changes. Collapses to just the speed; that choice is remembered.
 *
 * Sits under the toolbar, in the gap between the Models panel on the left and
 * the Parameters panel / colour legend on the right, and ignores the pointer
 * everywhere but its own button, so it never gets in the way of a drag.
 */

const COLLAPSED_KEY = 'ifcviewer:fly-tips-collapsed';

/** How the mouse looks around: captured (`mouse`) or by dragging (`drag`). */
export type FlyTipsLook = 'mouse' | 'drag';

/** The key list. Only the mouse rows change with how looking works. */
export function flyTips(look: FlyTipsLook): ReadonlyArray<readonly [string, string]> {
  return [
    ['W A S D', 'Forward, left, back, right'],
    ['E / Q', 'Up / down'],
    ['← → ↑ ↓', 'Turn and look up / down'],
    look === 'mouse' ? ['Mouse', 'Move it to look'] : ['Drag', 'Drag to look (click to capture the mouse)'],
    look === 'mouse' ? ['Click', 'Selects under the ring'] : ['Click', 'Selects what you click'],
    ['Right-click', 'Menu (leaves flying)'],
    ['Scroll, X / Z', 'Faster / slower'],
    ['Shift / Space', 'Hold: 4× faster / slow'],
    ['H', 'Hide or show these keys'],
    ['Esc', 'Leaves flying (G too)'],
  ];
}
/** Cruising speed for display: tidy steps stay tidy (0.75 m/s, 5 m/s). */
export function formatFlySpeed(speed: number): string {
  const text = speed < 1 ? speed.toFixed(2).replace(/0$/, '') : String(Math.round(speed * 100) / 100);
  return `${text} m/s`;
}

/**
 * True on a device with a touch screen and no mouse or trackpad, where flying
 * — all keys and fine dragging — has no way to move. Pages cannot see whether
 * a keyboard is attached, so the caller should change its mind on the first
 * key press.
 */
export function looksTouchOnly(win: Pick<Window, 'matchMedia'> | undefined = globalThis.window): boolean {
  if (!win || typeof win.matchMedia !== 'function') return false;
  return !win.matchMedia('(any-pointer: fine)').matches && win.matchMedia('(any-pointer: coarse)').matches;
}

export class FlyTips {
  private el: HTMLElement;
  private speedEl: HTMLElement;
  private listEl: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private collapsed: boolean;
  private look: FlyTipsLook = 'mouse';
  /** Folded for lack of room above the centre of the view (not remembered). */
  private tight = false;

  constructor(parent: HTMLElement, initialSpeed: number) {
    this.collapsed = readCollapsed();

    this.el = document.createElement('div');
    this.el.className = 'fly-tips';
    this.el.hidden = true;

    const head = document.createElement('div');
    head.className = 'fly-tips-head';
    const title = document.createElement('span');
    title.className = 'fly-tips-title';
    title.textContent = 'Flying';
    this.speedEl = document.createElement('span');
    this.speedEl.className = 'fly-tips-speed';
    // Only the speed is announced, politely, as it changes; the key list is
    // ordinary content a screen reader can read when asked.
    this.speedEl.setAttribute('aria-live', 'polite');
    this.speedEl.setAttribute('aria-atomic', 'true');
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.type = 'button';
    this.toggleBtn.className = 'fly-tips-toggle';
    this.toggleBtn.addEventListener('click', () => {
      this.toggleCollapsed();
      // Off the button, so Space (slow) cannot press it.
      this.toggleBtn.blur();
    });
    head.append(title, this.speedEl, this.toggleBtn);

    this.listEl = document.createElement('dl');
    this.listEl.className = 'fly-tips-list';
    this.renderList();

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

  /** Switch the tips between captured mouse and drag-to-look. */
  setLook(look: FlyTipsLook): void {
    if (look === this.look) return;
    this.look = look;
    this.renderList();
  }

  getLook(): FlyTipsLook {
    return this.look;
  }

  /** Fold to the speed or unfold the keys (the H key). */
  toggleCollapsed(): void {
    // Folded only for lack of room: asking for the keys shows them.
    if (this.tight) {
      this.tight = false;
      this.applyCollapsed();
      return;
    }
    this.setCollapsed(!this.collapsed);
  }

  /**
   * Fold the key list, without remembering it, when it would reach below
   * y — on a short window it would otherwise cover the centre of the view.
   */
  fitAbove(y: number): void {
    this.tight = false;
    this.applyCollapsed();
    if (this.collapsed || !this.isShown()) return;
    if (this.el.getBoundingClientRect().bottom > y) {
      this.tight = true;
      this.applyCollapsed();
    }
  }

  /** Folded, by choice or for lack of room. */
  isFolded(): boolean {
    return this.collapsed || this.tight;
  }

  private renderList(): void {
    this.listEl.replaceChildren();
    for (const [keys, action] of flyTips(this.look)) {
      const dt = document.createElement('dt');
      const kbd = document.createElement('kbd');
      kbd.textContent = keys;
      dt.appendChild(kbd);
      const dd = document.createElement('dd');
      dd.textContent = action;
      this.listEl.append(dt, dd);
    }
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
    const folded = this.collapsed || this.tight;
    this.el.classList.toggle('collapsed', folded);
    this.listEl.hidden = folded;
    this.toggleBtn.textContent = folded ? 'Keys' : 'Hide';
    this.toggleBtn.title = folded ? 'Show the flying keys (H)' : 'Hide the flying keys, keep the speed (H)';
    this.toggleBtn.setAttribute('aria-expanded', String(!folded));
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
