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
import type { ParameterValue } from './types';

/** How many elements of one parameter can be seen, and per value. */
export interface VisibleParameter {
  /** Elements that can be seen and have a value. */
  count: number;
  /** Elements that can be seen, per value: see `visibleValueKey`. */
  values: Map<string, number>;
}

/** What the list needs to show counts of what can be seen. */
export interface VisibleView {
  modelId: string;
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

/** One column counted over `rows`, with entries keyed as the value list keys them. */
export function countVisible(c: ColumnData, rows: Int32Array): VisibleParameter {
  const values = new Map<string, number>();
  let count = 0;
  const bump = (key: string): void => {
    values.set(key, (values.get(key) ?? 0) + 1);
    count++;
  };
  if (c.type === 'discrete') {
    // The list keeps a discrete column's values apart by value alone.
    for (let r = 0; r < rows.length; r++) {
      const code = c.codes[rows[r]];
      if (code >= 0) bump(visibleValueKey(c.dictionary[code]));
    }
    return { count, values };
  }
  const unitIndex = c.unitIndex;
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r];
    const v = c.values[i];
    if (Number.isNaN(v)) continue;
    bump(visibleValueKey(v, unitIndex ? c.units[unitIndex[i]]?.key : undefined));
  }
  return { count, values };
}
