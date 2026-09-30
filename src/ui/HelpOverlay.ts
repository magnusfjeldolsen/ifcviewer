import type { KeyboardShortcuts } from './KeyboardShortcuts';

const MOUSE_CONTROLS = [
  { input: 'Left drag', action: 'Orbit' },
  { input: 'Right drag', action: 'Pan' },
  { input: 'Middle drag', action: 'Pan' },
  { input: 'Scroll', action: 'Zoom' },
];

/**
 * Keys the measurement tool owns. Snapping is the reason both exist: the
 * first pick of a measurement decides what it means, so being able to choose
 * what the cursor caught — and to stop it catching anything — is not a
 * nicety.
 */
const MEASUREMENT_KEYS = [
  { input: 'Tab', action: 'Cycle what the cursor snaps to (corner, edge, surface, point)' },
  { input: 'S', action: 'Snapping on / off' },
  { input: 'Right-click', action: 'Cancel a half-placed measurement' },
];

export class HelpOverlay {
  private button: HTMLButtonElement;
  private overlay: HTMLElement | null = null;
  private shortcuts: KeyboardShortcuts;
  private boundClose: (e: MouseEvent) => void;
  private boundEscape: (e: KeyboardEvent) => void;

  constructor(parent: HTMLElement, shortcuts: KeyboardShortcuts) {
    this.shortcuts = shortcuts;

    this.button = document.createElement('button');
    this.button.className = 'help-button';
    this.button.title = 'Keyboard shortcuts (?)';
    this.button.textContent = '?';
    this.button.addEventListener('click', () => this.toggle());
    parent.appendChild(this.button);

    this.boundClose = (e: MouseEvent) => {
      if (this.overlay && !this.overlay.contains(e.target as Node) && e.target !== this.button) {
        this.hide();
      }
    };

    this.boundEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.overlay) {
        this.hide();
      }
    };
  }

  toggle(): void {
    if (this.overlay) {
      this.hide();
    } else {
      this.show();
    }
  }

  private show(): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'help-overlay';

    const title = document.createElement('h3');
    title.className = 'help-overlay-title';
    title.textContent = 'Controls';
    this.overlay.appendChild(title);

    // Keyboard shortcuts section
    const kbHeading = document.createElement('h4');
    kbHeading.className = 'help-overlay-section';
    kbHeading.textContent = 'Keyboard';
    this.overlay.appendChild(kbHeading);

    const shortcuts = this.shortcuts.getAll();
    for (const entry of shortcuts) {
      this.overlay.appendChild(this.createRow(this.formatKey(entry.key), entry.label));
    }

    // Tool-scoped keys. Not in `KeyboardShortcuts` because they only mean
    // anything while the measurement tool is active, and registering them
    // globally would make them fire when it is not.
    const measureHeading = document.createElement('h4');
    measureHeading.className = 'help-overlay-section';
    measureHeading.textContent = 'While measuring';
    this.overlay.appendChild(measureHeading);

    for (const entry of MEASUREMENT_KEYS) {
      this.overlay.appendChild(this.createRow(entry.input, entry.action));
    }

    // Mouse controls section
    const mouseHeading = document.createElement('h4');
    mouseHeading.className = 'help-overlay-section';
    mouseHeading.textContent = 'Mouse';
    this.overlay.appendChild(mouseHeading);

    for (const ctrl of MOUSE_CONTROLS) {
      this.overlay.appendChild(this.createRow(ctrl.input, ctrl.action));
    }

    this.button.parentElement!.appendChild(this.overlay);
    this.button.classList.add('active');

    // Defer listener attachment so the current click doesn't immediately close
    requestAnimationFrame(() => {
      document.addEventListener('click', this.boundClose);
      document.addEventListener('keydown', this.boundEscape);
    });
  }

  private hide(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    this.button.classList.remove('active');
    document.removeEventListener('click', this.boundClose);
    document.removeEventListener('keydown', this.boundEscape);
  }

  private createRow(key: string, label: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'help-overlay-row';

    const keyEl = document.createElement('kbd');
    keyEl.className = 'help-overlay-key';
    keyEl.textContent = key;

    const labelEl = document.createElement('span');
    labelEl.className = 'help-overlay-label';
    labelEl.textContent = label;

    row.appendChild(keyEl);
    row.appendChild(labelEl);
    return row;
  }

  private formatKey(key: string): string {
    if (key === 'Escape') return 'Esc';
    return key.toUpperCase();
  }

  isOpen(): boolean {
    return this.overlay !== null;
  }

  dispose(): void {
    this.hide();
    this.button.remove();
  }
}
