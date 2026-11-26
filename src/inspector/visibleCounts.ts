/**
 * What the Parameters list counts when part of a model is hidden (#115).
 *
 * The list's own counts cover the whole model. When some elements cannot be
 * seen (hidden, the model switched off, cut away by the section plane: the
 * rule the Totals tab uses), this counts the same parameters and values over
 * the elements that can, from value columns that are already built, so it is
 * a pass over typed arrays and never reads the model.
 *
 * Pure and DOM-free.
 */

import type { ColumnData } from './parameterColumn';
import { shownNumber } from './parameterFold';
import type { ParameterValue } from './types';

/** How many elements of one parameter can be seen, and per value when asked for. */
export interface VisibleParameter {
  /** Elements that can be seen and have a value. */
  count: number;
  /**
   * Elements that can be seen, per value (see `visibleValueKey`); null when
   * not counted: only the open parameter's values are, and not those of a
   * parameter that is unique per element.
   */
  values: Map<string, number> | null;
}

/** What the list needs to show counts of what can be seen. */
export interface VisibleView {
  modelId: string;
  /** The model is switched off: nothing of it can be seen, and nothing else is counted. */
  off?: boolean;
  /** Elements of the scope that can be seen. */
  elements: number;
  /** The scope's size. */
  total: number;
  /** Per parameter, for the parameters whose column is built. */
  parameters: ReadonlyMap<string, VisibleParameter>;
}

/** Identifies one entry of a value list: the value, and its unit when the list keeps units apart. */
export function visibleValueKey(value: ParameterValue, unitKey?: string): string {
  return `${typeof value}:${String(value)}|${unitKey ?? ''}`;
}

/**
 * The rows of `ids` that `visible` accepts; null when all of them are
 * (nothing is hidden, so the whole-model counts stand).
 */
export function visibleRows(ids: Int32Array, visible: (expressId: number) => boolean): Int32Array | null {
  const out = new Int32Array(ids.length);
  let k = 0;
  for (let i = 0; i < ids.length; i++) if (visible(ids[i])) out[k++] = i;
  return k === ids.length ? null : out.slice(0, k);
}

/** How many of `rows` have a value in `c`: one pass, no maps, no strings. */
export function countVisibleHaving(c: ColumnData, rows: Int32Array): number {
  let n = 0;
  if (c.type === 'discrete') {
    const codes = c.codes;
    for (let r = 0; r < rows.length; r++) if (codes[rows[r]] >= 0) n++;
  } else {
    const values = c.values;
    for (let r = 0; r < rows.length; r++) {
      const v = values[rows[r]];
      if (v === v) n++;
    }
  }
  return n;
}

/** Which parameter's values are listed now, and whether per-value counts are worth working out for it. */
export interface OpenDetail {
  key: string;
  /** False for a parameter that is unique per element: its entries are not counted. */
  perValue: boolean;
}

/**
 * Every built column counted over `rows`: only how many have a value, and
 * the per-value map just for the open parameter (when `perValue`).
 */
export function countVisibleColumns(
  columns: readonly ColumnData[],
  rows: Int32Array,
  open: OpenDetail | null,
): Map<string, VisibleParameter> {
  const out = new Map<string, VisibleParameter>();
  for (const c of columns) {
    out.set(c.key, open && open.perValue && open.key === c.key ? countVisible(c, rows) : { count: countVisibleHaving(c, rows), values: null });
  }
  return out;
}

/** One column counted over `rows`, with entries keyed as the value list keys them. */
export function countVisible(c: ColumnData, rows: Int32Array): { count: number; values: Map<string, number> } {
  const values = new Map<string, number>();
  let count = 0;
  if (c.type === 'discrete') {
    // The list keeps a discrete column's values apart by value alone. Tally
    // per dictionary code in a typed array, and build one key per distinct value.
    const tally = new Int32Array(c.dictionary.length);
    const codes = c.codes;
    for (let r = 0; r < rows.length; r++) {
      const code = codes[rows[r]];
      if (code >= 0) tally[code]++;
    }
    for (let code = 0; code < tally.length; code++) {
      if (tally[code] === 0) continue;
      // Numbers that show alike are one line in the list, so several codes can share a key.
      const v = c.dictionary[code];
      const key = visibleValueKey(typeof v === 'number' ? shownNumber(v) : v);
      values.set(key, (values.get(key) ?? 0) + tally[code]);
      count += tally[code];
    }
    return { count, values };
  }
  // Numbers: tally per number (and unit) with numeric map keys, then one string key per distinct value.
  const perUnit: Map<number, number>[] = (c.units.length > 0 ? c.units : [{ key: '', symbol: '' }]).map(
    () => new Map<number, number>(),
  );
  const unitIndex = c.unitIndex;
  const data = c.values;
  const single = perUnit[0];
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r];
    const v = data[i];
    if (v !== v) continue;
    const tally = unitIndex ? perUnit[unitIndex[i]] : single;
    tally.set(v, (tally.get(v) ?? 0) + 1);
  }
  for (let u = 0; u < perUnit.length; u++) {
    const unitKey = unitIndex ? c.units[u]?.key : undefined;
    for (const [v, n] of perUnit[u]) {
      // Keyed by the number as it is printed, as the list's lines are; hair-apart numbers add up.
      const key = visibleValueKey(shownNumber(v), unitKey);
      values.set(key, (values.get(key) ?? 0) + n);
      count += n;
    }
  }
  return { count, values };
}
