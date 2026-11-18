/**
 * How wide the inspector panel may be, and how that width is remembered.
 *
 * Pure: no DOM, no globals. The drag / keyboard wiring lives in
 * `resizeHandle.ts`; everything that decides a number lives here so it can
 * be tested without a layout engine.
 *
 * The panel sits at the left of the screen, so its right edge is the one that
 * faces the canvas and the one the user drags.
 */

/**
 * The width a fresh panel opens at, and what a double-click on the handle goes
 * back to. 20px more than the old fixed 280px: the flat view's one-line rows
 * give the ⌕ button a column of its own, and the value column needs it back.
 */
export const DEFAULT_PANEL_WIDTH = 300;

/** Narrower than this and the Name / Value columns stop being readable. */
export const MIN_PANEL_WIDTH = 220;

/** Wider than this is past the point of reading one more word. */
export const MAX_PANEL_WIDTH = 720;

/**
 * Canvas left visible to the right of the panel at its widest, counted from
 * the viewport's left edge (the panel's own 12px left offset included). The
 * model must stay reachable, so the panel never covers the whole viewport.
 */
export const VIEWPORT_MARGIN = 120;

/** Arrow-key step; Shift multiplies it by four. */
export const KEY_STEP = 16;

/** Same pattern as the view choice: one key of its own, outside Settings. */
export const WIDTH_STORAGE_KEY = 'ifcviewer:inspectorWidth';

/**
 * The widest the panel may be in a viewport this wide. Never below today's
 * default, so a small screen keeps the panel it already had rather than
 * having it squeezed by a rule meant for dragging.
 */
export function maxPanelWidth(viewportWidth: number): number {
  return Math.max(DEFAULT_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, viewportWidth - VIEWPORT_MARGIN));
}

/** Bring any requested width inside the allowed range, in whole pixels. */
export function clampPanelWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_PANEL_WIDTH;
  const upper = maxPanelWidth(viewportWidth);
  return Math.round(Math.min(upper, Math.max(MIN_PANEL_WIDTH, width)));
}

/** Width while dragging: the start width moved by how far the pointer went. */
export function widthFromDrag(
  startWidth: number,
  startX: number,
  currentX: number,
  viewportWidth: number,
): number {
  return clampPanelWidth(startWidth + (currentX - startX), viewportWidth);
}

/**
 * Width after a key press on the handle, or null when the key is not one the
 * handle answers to (so the caller leaves the event alone).
 */
export function widthFromKey(
  current: number,
  key: string,
  shift: boolean,
  viewportWidth: number,
): number | null {
  const step = shift ? KEY_STEP * 4 : KEY_STEP;
  switch (key) {
    case 'ArrowRight':
      return clampPanelWidth(current + step, viewportWidth);
    case 'ArrowLeft':
      return clampPanelWidth(current - step, viewportWidth);
    case 'Home':
      return clampPanelWidth(MIN_PANEL_WIDTH, viewportWidth);
    case 'End':
      return clampPanelWidth(MAX_PANEL_WIDTH, viewportWidth);
    default:
      return null;
  }
}

/** The storage surface this module needs; `window.localStorage` fits it. */
export type WidthStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The width the user last chose, or null when none is stored or it cannot be
 * read. A stored value that is not a positive number counts as none.
 */
export function readStoredWidth(storage: WidthStorage | undefined | null): number | null {
  try {
    const raw = storage?.getItem(WIDTH_STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Remember a width; null forgets it (back to the default). */
export function writeStoredWidth(storage: WidthStorage | undefined | null, width: number | null): void {
  try {
    if (width === null) storage?.removeItem(WIDTH_STORAGE_KEY);
    else storage?.setItem(WIDTH_STORAGE_KEY, String(width));
  } catch {
    /* storage may be disabled — the width still holds for this session */
  }
}
