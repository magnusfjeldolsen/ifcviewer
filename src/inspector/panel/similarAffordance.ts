/**
 * The "⌕" select-similar affordance shared by the Tree and Flat renderers.
 *
 * One builder so the gating rule lives in a single place: the button appears
 * only when a handler is wired (single-element selection — a multi-selection
 * has no single "this value") AND the row's value is matchable. Rows where a
 * match would be meaningless or ambiguous — quantities, structured kinds,
 * nulls, the `varies` sentinel — get no button rather than a button that
 * selects nothing.
 *
 * See dev/plans/handoff-select-similar.md.
 */

import { canSelectSimilar } from '../selectSimilar';
import type { PropertyFlatRow, PropertyValue } from '../types';

/** The panel-supplied handler; absent when select-similar isn't available. */
export type SelectSimilarHandler = (path: string, value: PropertyValue) => void;

/**
 * Build the affordance for a row, or return null when it shouldn't be
 * offered. `path` is undefined for rows with no dotted path (nothing to
 * match against in other elements).
 */
export function buildSimilarButton(
  path: string | undefined,
  value: PropertyValue,
  displayValue: string,
  onSelectSimilar: SelectSimilarHandler | undefined,
): HTMLElement | null {
  if (!onSelectSimilar || !path) return null;
  const row: Pick<PropertyFlatRow, 'path' | 'rawValue'> = { path, rawValue: value };
  if (!canSelectSimilar(row)) return null;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'inspector-similar-btn';
  btn.textContent = '⌕';
  btn.title = displayValue
    ? `Select all with ${path} = ${displayValue}`
    : `Select all with the same ${path}`;
  btn.setAttribute('aria-label', btn.title);
  btn.addEventListener('click', (e) => {
    // The value cell behind this button copies to clipboard on click; the
    // row itself may sit inside a collapsible header. Neither should fire.
    e.stopPropagation();
    onSelectSimilar(path, value);
  });
  return btn;
}
