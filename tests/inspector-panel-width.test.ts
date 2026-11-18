// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_PANEL_WIDTH,
  KEY_STEP,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  VIEWPORT_MARGIN,
  WIDTH_STORAGE_KEY,
  clampPanelWidth,
  maxPanelWidth,
  readStoredWidth,
  widthFromDrag,
  widthFromKey,
  writeStoredWidth,
  type WidthStorage,
} from '../src/inspector/panel/panelWidth';
import { attachResizeHandle } from '../src/inspector/panel/resizeHandle';

function memoryStorage(initial: Record<string, string> = {}): WidthStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const throwingStorage: WidthStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

describe('panel width rules', () => {
  it('keeps a width inside the min and max on a wide screen', () => {
    expect(clampPanelWidth(100, 1920)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(5000, 1920)).toBe(MAX_PANEL_WIDTH);
    expect(clampPanelWidth(400.4, 1920)).toBe(400);
  });

  it('never lets the panel cover the viewport: the max leaves a margin of canvas', () => {
    expect(maxPanelWidth(700)).toBe(700 - VIEWPORT_MARGIN);
    expect(clampPanelWidth(5000, 700)).toBe(700 - VIEWPORT_MARGIN);
  });

  it('on a screen too small for that margin, keeps today\'s default rather than squeezing it', () => {
    expect(maxPanelWidth(360)).toBe(DEFAULT_PANEL_WIDTH);
    expect(clampPanelWidth(600, 360)).toBe(DEFAULT_PANEL_WIDTH);
  });

  it('falls back to the default for a width that is not a number', () => {
    expect(clampPanelWidth(Number.NaN, 1920)).toBe(DEFAULT_PANEL_WIDTH);
  });

  it('drag moves the width by the distance the pointer travelled', () => {
    expect(widthFromDrag(280, 300, 420, 1920)).toBe(400);
    expect(widthFromDrag(280, 300, 0, 1920)).toBe(MIN_PANEL_WIDTH);
  });

  it('arrow keys step the width, Shift steps further, Home/End jump to the ends', () => {
    expect(widthFromKey(280, 'ArrowRight', false, 1920)).toBe(280 + KEY_STEP);
    expect(widthFromKey(280, 'ArrowLeft', false, 1920)).toBe(280 - KEY_STEP);
    expect(widthFromKey(280, 'ArrowRight', true, 1920)).toBe(280 + KEY_STEP * 4);
    expect(widthFromKey(280, 'Home', false, 1920)).toBe(MIN_PANEL_WIDTH);
    expect(widthFromKey(280, 'End', false, 1920)).toBe(MAX_PANEL_WIDTH);
    expect(widthFromKey(280, 'Enter', false, 1920)).toBeNull();
  });
});

describe('panel width persistence', () => {
  it('round-trips a width', () => {
    const s = memoryStorage();
    writeStoredWidth(s, 420);
    expect(s.data.get(WIDTH_STORAGE_KEY)).toBe('420');
    expect(readStoredWidth(s)).toBe(420);
  });

  it('forgets the width when written as null', () => {
    const s = memoryStorage({ [WIDTH_STORAGE_KEY]: '420' });
    writeStoredWidth(s, null);
    expect(readStoredWidth(s)).toBeNull();
  });

  it('treats a corrupt or missing value as none', () => {
    expect(readStoredWidth(memoryStorage())).toBeNull();
    expect(readStoredWidth(memoryStorage({ [WIDTH_STORAGE_KEY]: 'wide' }))).toBeNull();
    expect(readStoredWidth(memoryStorage({ [WIDTH_STORAGE_KEY]: '-5' }))).toBeNull();
    expect(readStoredWidth(null)).toBeNull();
  });

  it('survives storage that throws', () => {
    expect(readStoredWidth(throwingStorage)).toBeNull();
    expect(() => writeStoredWidth(throwingStorage, 400)).not.toThrow();
    expect(() => writeStoredWidth(throwingStorage, null)).not.toThrow();
  });
});

describe('resize handle', () => {
  let panel: HTMLElement;
  const originalWidth = window.innerWidth;

  /** jsdom has no PointerEvent constructor; a MouseEvent with a pointerId does. */
  function pointer(type: string, clientX: number, pointerId = 1, button = 0): Event {
    const e = new MouseEvent(type, { clientX, button, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'pointerId', { value: pointerId });
    return e;
  }

  const shownWidth = (): string => panel.style.getPropertyValue('--inspector-width');

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    panel = document.createElement('div');
    document.body.appendChild(panel);
  });

  afterEach(() => {
    panel.remove();
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true });
  });

  it('sits on the panel, focusable, and starts at the default width', () => {
    const h = attachResizeHandle(panel, memoryStorage());
    expect(h.element.parentElement).toBe(panel);
    expect(h.element.tabIndex).toBe(0);
    expect(h.element.getAttribute('role')).toBe('separator');
    expect(shownWidth()).toBe(`${DEFAULT_PANEL_WIDTH}px`);
    h.dispose();
  });

  it('starts at the remembered width', () => {
    const h = attachResizeHandle(panel, memoryStorage({ [WIDTH_STORAGE_KEY]: '450' }));
    expect(shownWidth()).toBe('450px');
    h.dispose();
  });

  it('a drag widens the panel and remembers the width when it ends', () => {
    const s = memoryStorage();
    const h = attachResizeHandle(panel, s);
    h.element.dispatchEvent(pointer('pointerdown', 292));
    expect(panel.classList.contains('resizing')).toBe(true);
    h.element.dispatchEvent(pointer('pointermove', 392));
    expect(shownWidth()).toBe(`${DEFAULT_PANEL_WIDTH + 100}px`);
    // Not stored mid-drag — only once the gesture ends.
    expect(s.data.has(WIDTH_STORAGE_KEY)).toBe(false);
    h.element.dispatchEvent(pointer('pointerup', 392));
    expect(panel.classList.contains('resizing')).toBe(false);
    expect(s.data.get(WIDTH_STORAGE_KEY)).toBe(String(DEFAULT_PANEL_WIDTH + 100));
    h.dispose();
  });

  it('the pointerdown does not reach anything behind the handle', () => {
    const h = attachResizeHandle(panel, memoryStorage());
    let reachedParent = false;
    panel.addEventListener('pointerdown', () => (reachedParent = true));
    const down = pointer('pointerdown', 292);
    h.element.dispatchEvent(down);
    expect(reachedParent).toBe(false);
    expect(down.defaultPrevented).toBe(true);
    h.dispose();
  });

  it('ignores a right-button press and moves without a press', () => {
    const h = attachResizeHandle(panel, memoryStorage());
    h.element.dispatchEvent(pointer('pointerdown', 292, 1, 2));
    h.element.dispatchEvent(pointer('pointermove', 500));
    expect(shownWidth()).toBe(`${DEFAULT_PANEL_WIDTH}px`);
    h.dispose();
  });

  it('double-click goes back to the default width and forgets the stored one', () => {
    const s = memoryStorage({ [WIDTH_STORAGE_KEY]: '500' });
    const h = attachResizeHandle(panel, s);
    h.element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(shownWidth()).toBe(`${DEFAULT_PANEL_WIDTH}px`);
    expect(s.data.has(WIDTH_STORAGE_KEY)).toBe(false);
    h.dispose();
  });

  it('arrow keys resize and remember', () => {
    const s = memoryStorage();
    const h = attachResizeHandle(panel, s);
    const key = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    h.element.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(shownWidth()).toBe(`${DEFAULT_PANEL_WIDTH + KEY_STEP}px`);
    expect(s.data.get(WIDTH_STORAGE_KEY)).toBe(String(DEFAULT_PANEL_WIDTH + KEY_STEP));
    h.dispose();
  });

  it('a narrower window shrinks what is shown but keeps what was chosen', () => {
    const s = memoryStorage({ [WIDTH_STORAGE_KEY]: '700' });
    const h = attachResizeHandle(panel, s);
    expect(shownWidth()).toBe('700px');
    Object.defineProperty(window, 'innerWidth', { value: 700, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(shownWidth()).toBe(`${700 - VIEWPORT_MARGIN}px`);
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(shownWidth()).toBe('700px');
    expect(s.data.get(WIDTH_STORAGE_KEY)).toBe('700');
    h.dispose();
  });

  it('dispose removes the handle', () => {
    const h = attachResizeHandle(panel, memoryStorage());
    h.dispose();
    expect(panel.querySelector('.inspector-resize-handle')).toBeNull();
  });
});
