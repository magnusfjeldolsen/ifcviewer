/**
 * Flat-view rendering for the InspectorPanel.
 *
 * Three columns (Name, Value, Unit), one row per leaf from
 * `props.flat`. The filter input above the table debounces user input
 * and hides non-matching rows.
 *
 * Pure: takes the target body element, the props, and a context object
 * carrying panel-owned callbacks + filter state accessors. No closure
 * over the panel instance.
 *
 * Split out of `InspectorPanel.ts` so the flat renderer has its own
 * file. No behavior change.
 */

import type { ElementProperties, PropertyFlatRow } from '../types';

/** Filter input debounce in the Flat view. */
const FILTER_DEBOUNCE_MS = 100;

/** Truncate `s` to `n` chars with an ellipsis. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

/**
 * Dependencies the flat renderer pulls from the panel. Filter state is
 * panel-owned (lives across view toggles), so we get/set it via these
 * accessors rather than re-create it each render.
 */
export interface FlatRenderContext {
  valueTruncateAt: number;
  copyWithFlash: (el: HTMLElement, text: string) => void;
  /** Build the varies-row tooltip text for a flat path. */
  formatVariesTooltip: (path: string) => string;
  /** Whether the panel currently has props rendered (gates varies tooltip lookup). */
  hasCurrentProps: () => boolean;
  /** Current filter string (already lower-cased and trimmed). */
  getFlatFilter: () => string;
  /** Persist a new filter string (already lower-cased and trimmed). */
  setFlatFilter: (value: string) => void;
  /** Get / set the debounce timer handle on the panel. */
  getDebounceTimer: () => ReturnType<typeof setTimeout> | null;
  setDebounceTimer: (handle: ReturnType<typeof setTimeout> | null) => void;
}

export function renderFlat(
  target: HTMLElement,
  props: ElementProperties,
  ctx: FlatRenderContext,
): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'inspector-flat';

  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.className = 'inspector-filter';
  filterInput.placeholder = 'Filter properties…';
  filterInput.value = ctx.getFlatFilter();
  filterInput.addEventListener('input', () => {
    const existing = ctx.getDebounceTimer();
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      ctx.setFlatFilter(filterInput.value.trim().toLowerCase());
      applyFilter();
    }, FILTER_DEBOUNCE_MS);
    ctx.setDebounceTimer(handle);
  });
  wrapper.appendChild(filterInput);

  const table = document.createElement('div');
  table.className = 'inspector-flat-table';
  const headerRow = document.createElement('div');
  headerRow.className = 'inspector-flat-row inspector-flat-header';
  for (const label of ['Name', 'Value', 'Unit']) {
    const cell = document.createElement('span');
    cell.className = 'inspector-flat-cell';
    cell.textContent = label;
    headerRow.appendChild(cell);
  }
  table.appendChild(headerRow);

  // Rows already sorted alphabetically by path in repository's buildFlatRows.
  const rows: HTMLElement[] = [];
  for (const r of props.flat) {
    const row = buildFlatRow(r, ctx);
    rows.push(row);
    table.appendChild(row);
  }
  wrapper.appendChild(table);

  if (props.flat.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'inspector-empty';
    empty.textContent = 'No properties available.';
    wrapper.appendChild(empty);
  }

  target.appendChild(wrapper);

  const applyFilter = (): void => {
    const q = ctx.getFlatFilter();
    for (let i = 0; i < props.flat.length; i++) {
      const match = q === '' || props.flat[i].path.toLowerCase().includes(q);
      rows[i].style.display = match ? '' : 'none';
    }
  };
  applyFilter();
}

function buildFlatRow(r: PropertyFlatRow, ctx: FlatRenderContext): HTMLElement {
  const row = document.createElement('div');
  row.className = 'inspector-flat-row';
  row.dataset.path = r.path;

  const nameCell = document.createElement('span');
  nameCell.className = 'inspector-flat-cell inspector-flat-name';
  nameCell.textContent = r.path;
  nameCell.title = r.description ? `${r.path}\n${r.description}` : r.path;

  const valueCell = document.createElement('span');
  valueCell.className = 'inspector-flat-cell inspector-flat-value';
  if (r.rawValue.kind === 'varies') {
    valueCell.classList.add('inspector-row-varies');
    valueCell.textContent = 'varies';
    // Tooltip lists the distinct values from the intersection input.
    // Falls back to a plain label if no distinct map is available.
    if (ctx.hasCurrentProps()) {
      valueCell.title = ctx.formatVariesTooltip(r.path);
    }
  } else {
    const display = r.displayValue || '';
    const shown = display === '' ? '—' : truncate(display, ctx.valueTruncateAt);
    valueCell.textContent = shown;
    if (display && display.length > ctx.valueTruncateAt) {
      valueCell.classList.add('inspector-truncated');
    }
    valueCell.title = display ? `${display} (click to copy)` : '';
    valueCell.addEventListener('click', () => {
      if (!display) return;
      ctx.copyWithFlash(valueCell, display);
    });
  }

  const unitCell = document.createElement('span');
  unitCell.className = 'inspector-flat-cell inspector-flat-unit';
  unitCell.textContent = r.unit ?? '';

  row.appendChild(nameCell);
  row.appendChild(valueCell);
  row.appendChild(unitCell);
  return row;
}
