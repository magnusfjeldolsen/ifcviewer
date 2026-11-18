/**
 * The drag handle on the inspector panel's right edge (the edge facing the
 * canvas). Thin DOM wiring over `panelWidth.ts`, which owns every number.
 *
 * - Drag: pointer capture on the handle, so the whole gesture belongs to it —
 *   the canvas never sees the moves, and no orbit or marquee starts.
 * - Double-click: back to the default width, and the stored width forgotten.
 * - Keyboard: the handle is focusable; ←/→ resize (Shift for bigger steps),
 *   Home/End jump to the narrowest/widest.
 * - The chosen width survives a reload; a narrower window re-clamps what is
 *   shown without forgetting what was chosen.
 *
 * The width is written as the `--inspector-width` custom property so the
 * stylesheet's `.collapsed` rule still wins while the panel is collapsed.
 */

import {
  DEFAULT_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  clampPanelWidth,
  maxPanelWidth,
  readStoredWidth,
  widthFromDrag,
  widthFromKey,
  writeStoredWidth,
  type WidthStorage,
} from './panelWidth';

export interface ResizeHandle {
  element: HTMLElement;
  /** The width the panel is shown at now. */
  getWidth(): number;
  dispose(): void;
}

function defaultStorage(): WidthStorage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function attachResizeHandle(
  panel: HTMLElement,
  storage: WidthStorage | null = defaultStorage(),
): ResizeHandle {
  const viewportWidth = (): number => window.innerWidth;

  const handle = document.createElement('div');
  handle.className = 'inspector-resize-handle';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize inspector');
  handle.title = 'Drag to resize · double-click to reset';
  panel.appendChild(handle);

  /** What the user chose; the shown width is this clamped to the viewport. */
  let chosen = readStoredWidth(storage) ?? DEFAULT_PANEL_WIDTH;
  let shown = DEFAULT_PANEL_WIDTH;

  const apply = (): void => {
    shown = clampPanelWidth(chosen, viewportWidth());
    panel.style.setProperty('--inspector-width', `${shown}px`);
    handle.setAttribute('aria-valuenow', String(shown));
    handle.setAttribute('aria-valuemin', String(MIN_PANEL_WIDTH));
    handle.setAttribute('aria-valuemax', String(maxPanelWidth(viewportWidth())));
  };

  const choose = (width: number, persist: boolean): void => {
    chosen = width;
    apply();
    if (persist) writeStoredWidth(storage, chosen);
  };

  // ── Drag ──
  let drag: { pointerId: number; startX: number; startWidth: number } | null = null;

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { pointerId: e.pointerId, startX: e.clientX, startWidth: shown };
    try {
      handle.setPointerCapture?.(e.pointerId);
    } catch {
      /* a synthetic pointer has nothing to capture */
    }
    panel.classList.add('resizing');
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    choose(widthFromDrag(drag.startWidth, drag.startX, e.clientX, viewportWidth()), false);
  };

  const endDrag = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
    try {
      handle.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    panel.classList.remove('resizing');
    writeStoredWidth(storage, chosen);
  };

  const onDoubleClick = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    chosen = DEFAULT_PANEL_WIDTH;
    apply();
    writeStoredWidth(storage, null);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const next = widthFromKey(shown, e.key, e.shiftKey, viewportWidth());
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    choose(next, true);
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('dblclick', onDoubleClick);
  handle.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', apply);

  apply();

  return {
    element: handle,
    getWidth: () => shown,
    dispose: () => {
      window.removeEventListener('resize', apply);
      handle.remove();
    },
  };
}
