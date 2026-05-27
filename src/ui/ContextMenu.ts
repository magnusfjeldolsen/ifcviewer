/**
 * Generic positioned right-click menu — framework-free DOM.
 *
 * Reuses the panel/tray styling idiom (semi-transparent white, 8px radius, soft
 * shadow; see styles.css `.context-menu`). The owning code (App) builds the
 * `MenuItem[]` from current state on each open and wires each `onClick` to the
 * relevant manager — this component is purely presentation + dismissal.
 *
 * Dismissal: Escape, outside-click (pointerdown outside the menu), scroll/zoom,
 * window blur, or after an enabled item fires. A click INSIDE the menu (but not
 * on an enabled item) does not dismiss. Positioned at the cursor and clamped to
 * the viewport (flips up/left near the right/bottom edges).
 *
 * See dev/plans/handoff-context-menu.md.
 */

export interface MenuItem {
  /**
   * Row label. A header / disabled item shows this without interactivity.
   * Omitted on a `separator` row (which renders a divider, not a labelled row).
   */
  label?: string;
  /** Click handler. OMIT for a header / non-interactive row. */
  onClick?: () => void;
  /** Render the row greyed-out and inert (its onClick never fires). */
  disabled?: boolean;
  /** Reserved for future flyouts (e.g. "Select similar ▸"); unused in v1. */
  submenu?: MenuItem[];
  /** Render a divider instead of a row. */
  separator?: boolean;
}

export class ContextMenu {
  private parent: HTMLElement;
  private el: HTMLElement | null = null;
  private x = 0;
  private y = 0;

  // Bound global listeners — stable refs for add/removeEventListener.
  private boundOnKeyDown: (e: KeyboardEvent) => void;
  private boundOnOutsidePointerDown: (e: Event) => void;
  private boundOnScroll: () => void;
  private boundOnBlur: () => void;

  constructor(parent: HTMLElement) {
    this.parent = parent;
    this.boundOnKeyDown = (e) => {
      if (e.key === 'Escape') this.close();
    };
    this.boundOnOutsidePointerDown = (e) => {
      // A click inside the menu must NOT dismiss; everything else does.
      if (this.el && e.target instanceof Node && this.el.contains(e.target)) return;
      this.close();
    };
    this.boundOnScroll = () => this.close();
    this.boundOnBlur = () => this.close();
  }

  /** True while the menu is on-screen. */
  isOpen(): boolean {
    return this.el !== null;
  }

  /**
   * Open the menu at viewport coordinates (x, y) with the given items. Replaces
   * any currently-open menu. Installs the global dismissal listeners and clamps
   * the position into the viewport.
   */
  open(x: number, y: number, items: MenuItem[]): void {
    this.close(); // tear down any prior instance + its listeners

    this.x = x;
    this.y = y;

    const el = document.createElement('div');
    el.className = 'context-menu';
    el.style.position = 'fixed';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'context-menu-separator';
        el.appendChild(sep);
        continue;
      }

      const row = document.createElement('div');
      row.className = 'context-menu-item';
      row.textContent = item.label ?? '';

      const isHeader = !item.onClick && !item.disabled;
      if (isHeader) {
        row.classList.add('context-menu-header');
      }
      if (item.disabled) {
        row.classList.add('disabled');
      }

      const interactive = !!item.onClick && !item.disabled;
      if (interactive) {
        row.addEventListener('click', () => {
          // Fire then close (one-shot). close() runs first to detach listeners
          // so the handler can itself open a new menu without leaks.
          const fn = item.onClick!;
          this.close();
          fn();
        });
      }

      el.appendChild(row);
    }

    this.parent.appendChild(el);
    this.el = el;

    // Global dismissal. pointerdown (capture) catches outside-clicks before
    // they reach other handlers; scroll/blur close on view changes.
    document.addEventListener('keydown', this.boundOnKeyDown);
    document.addEventListener('pointerdown', this.boundOnOutsidePointerDown, true);
    window.addEventListener('scroll', this.boundOnScroll, true);
    window.addEventListener('blur', this.boundOnBlur);

    this.reposition();
  }

  /**
   * Re-run the viewport clamp using the menu's current measured size. Exposed
   * so callers (and tests) can re-clamp after the element has dimensions; the
   * menu flips left/up so it never overflows the right/bottom edges.
   */
  reposition(): void {
    if (!this.el) return;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = this.x;
    let top = this.y;
    if (left + w > vw) left = Math.max(0, vw - w);
    if (top + h > vh) top = Math.max(0, vh - h);

    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  /** Close the menu and detach all global listeners. Idempotent. */
  close(): void {
    if (!this.el) return;
    document.removeEventListener('keydown', this.boundOnKeyDown);
    document.removeEventListener('pointerdown', this.boundOnOutsidePointerDown, true);
    window.removeEventListener('scroll', this.boundOnScroll, true);
    window.removeEventListener('blur', this.boundOnBlur);
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
  }

  /** Tear down — removes the element + all listeners. Idempotent. */
  dispose(): void {
    this.close();
  }
}
