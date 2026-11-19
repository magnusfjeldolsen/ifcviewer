/**
 * Totals (#69): count, sum, min, max and average of one parameter over a
 * scope of elements, across models, optionally grouped by a second
 * parameter.
 *
 * Pure and DOM-free. Reads the value columns (`parameterColumn.ts`) the
 * Parameters list and the colouring already use: one pass over typed
 * arrays per model, no object per element.
 *
 * Units follow ADR 4: numbers are added up only within one unit, compared
 * by unit key, never converted. Numbers in several units give one total per
 * unit. A unit the model does not state (`?LENGTHUNIT`) is that model's own:
 * two models that both leave lengths unstated may not mean the same unit,
 * so their numbers are not added together.
 */

import { legendValueText } from './colourByPlan';
import type { ColumnData } from './parameterColumn';
import type { ParameterValue } from './types';
import { canSum, isNotStated, type SumVerdict, type UnitRef } from './units';

/** Count, sum, min and max of some numbers; for text only `count` means anything. */
export interface Stats {
  count: number;
  sum: number;
  min: number;
  max: number;
}

/** One model's part of a total. */
export interface TotalsInput {
  modelId: string;
  /** The model's scope: row i of every column is element `ids[i]`. */
  ids: Int32Array;
  /** The rows of the scope that are in the totals' scope; null for all of them. */
  rows: Int32Array | null;
  /** The parameter's column; null when the model does not have the parameter. */
  column: ColumnData | null;
  /**
   * The group-by parameter's column, when grouping: null when the model does
   * not have that parameter (its elements fall in "(no value)"). Leave it
   * out (undefined) when not grouping.
   */
  group?: ColumnData | null;
}

/** One group's line in a grouped table. */
export interface GroupLine {
  /** Identifies the group across models and units. */
  key: string;
  /** The group's value as shown. */
  label: string;
  stats: Stats;
  /** Text rows: how many distinct values the group's elements have. */
  distinct?: number;
}

/** The numbers of a total that are in one unit. */
export interface UnitTotals {
  /** The unit as shown. */
  unit: UnitRef;
  /** Identifies the unit across models (see the module comment). */
  key: string;
  /** For a unit the model does not state: whose. */
  modelId?: string;
  stats: Stats;
  /** When grouped: one line per group, in order of first appearance. */
  groups?: GroupLine[];
}

export interface Totals {
  /**
   * `numeric`: every value is a number. `discrete`: text, yes/no or
   * enumerations. `mixed`: numbers and other values. `none`: no element in
   * the scope has a value.
   */
  kind: 'numeric' | 'discrete' | 'mixed' | 'none';
  /** Elements in the scope. */
  scopeSize: number;
  /** Elements in the scope that have a value. */
  withValue: number;
  /** The numbers, one entry per unit, most values first. Empty unless `numeric`. */
  numbers: UnitTotals[];
  /** Whether the numbers can be added up into one total, and why not. */
  verdict: SumVerdict;
  /** How many distinct values (`discrete` and `mixed`). */
  distinct: number;
  /** `discrete` and `mixed`, when grouped: count and distinct values per group. */
  groups?: GroupLine[];
}

/** The key that a unit is compared by across models. */
export function mergedUnitKey(modelId: string, unitKey: string): string {
  return isNotStated(unitKey) ? `${unitKey}@${modelId}` : unitKey;
}

/** The average of `s`, NaN when it has no numbers. */
export function mean(s: Stats): number {
  return s.count > 0 ? s.sum / s.count : NaN;
}

function emptyStats(): Stats {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity };
}

const NO_VALUE_GROUP = 'none';
export const NO_VALUE_LABEL = '(no value)';

/** The groups seen so far, across models: an index per group. */
class GroupRegistry {
  private index = new Map<string, number>();
  readonly keys: string[] = [];
  readonly labels: string[] = [];

  of(key: string, label: string): number {
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.keys.length;
      this.index.set(key, i);
      this.keys.push(key);
      this.labels.push(label);
    }
    return i;
  }
}

function valueKey(v: ParameterValue): string {
  return `${typeof v}:${String(v)}`;
}

/**
 * For one model: the group index of each row of its scope, as a function
 * (allocates nothing per call). Every row of a model without the group-by
 * parameter, or without a value for it, is in "(no value)".
 */
function groupMapper(modelId: string, group: ColumnData | null, groups: GroupRegistry): (row: number) => number {
  let none = -1;
  const noValue = (): number => (none >= 0 ? none : (none = groups.of(NO_VALUE_GROUP, NO_VALUE_LABEL)));
  if (!group) return noValue;
  if (group.type === 'discrete') {
    const map = new Int32Array(group.dictionary.length);
    group.dictionary.forEach((v, code) => (map[code] = groups.of(`v:${valueKey(v)}`, legendValueText(v))));
    const codes = group.codes;
    return (row) => (codes[row] < 0 ? noValue() : map[codes[row]]);
  }
  const values = group.values;
  const unitIndex = group.unitIndex;
  const perUnit = group.units.map(() => new Map<number, number>());
  return (row) => {
    const v = values[row];
    if (Number.isNaN(v)) return noValue();
    const u = unitIndex ? unitIndex[row] : 0;
    let g = perUnit[u].get(v);
    if (g === undefined) {
      const unit = group.units[u];
      const label = legendValueText(v) + (unit.symbol ? ` ${unit.symbol}` : '');
      g = groups.of(`n:${v}|${mergedUnitKey(modelId, unit.key)}`, label);
      perUnit[u].set(v, g);
    }
    return g;
  };
}

/** Per-group stats in parallel arrays, grown as groups appear. */
class GroupStats {
  count: number[] = [];
  sum: number[] = [];
  min: number[] = [];
  max: number[] = [];

  add(g: number, v: number): void {
    while (this.count.length <= g) {
      this.count.push(0);
      this.sum.push(0);
      this.min.push(Infinity);
      this.max.push(-Infinity);
    }
    this.count[g]++;
    this.sum[g] += v;
    if (v < this.min[g]) this.min[g] = v;
    if (v > this.max[g]) this.max[g] = v;
  }

  lines(groups: GroupRegistry): GroupLine[] {
    const out: GroupLine[] = [];
    for (let g = 0; g < this.count.length; g++) {
      if (this.count[g] === 0) continue;
      out.push({
        key: groups.keys[g],
        label: groups.labels[g],
        stats: { count: this.count[g], sum: this.sum[g], min: this.min[g], max: this.max[g] },
      });
    }
    return out;
  }
}

interface Bucket {
  totals: UnitTotals;
  groupStats: GroupStats | null;
}

/** Distinct values across models: one index per value. */
class ValueRegistry {
  private text = new Map<string, number>();
  private numbers = new Map<number, number>();
  size = 0;

  of(v: ParameterValue): number {
    if (typeof v === 'number') {
      let i = this.numbers.get(v);
      if (i === undefined) this.numbers.set(v, (i = this.size++));
      return i;
    }
    const k = valueKey(v);
    let i = this.text.get(k);
    if (i === undefined) this.text.set(k, (i = this.size++));
    return i;
  }
}

/** Count and distinct values per group, for text. */
class GroupDistinct {
  count: number[] = [];
  seen: Set<number>[] = [];

  add(g: number, value: number): void {
    while (this.count.length <= g) {
      this.count.push(0);
      this.seen.push(new Set());
    }
    this.count[g]++;
    this.seen[g].add(value);
  }

  lines(groups: GroupRegistry): GroupLine[] {
    const out: GroupLine[] = [];
    for (let g = 0; g < this.count.length; g++) {
      if (this.count[g] === 0) continue;
      out.push({
        key: groups.keys[g],
        label: groups.labels[g],
        stats: { count: this.count[g], sum: NaN, min: NaN, max: NaN },
        distinct: this.seen[g].size,
      });
    }
    return out;
  }
}

/**
 * The totals of one parameter over the scope that `inputs` describe (one
 * entry per model in the scope). Grouped when any input carries a `group`
 * column (or null for one).
 */
export function aggregate(inputs: readonly TotalsInput[]): Totals {
  const grouped = inputs.some((i) => i.group !== undefined);
  const groups = new GroupRegistry();
  const buckets = new Map<string, Bucket>();
  const order: Bucket[] = [];
  const values = new ValueRegistry();
  const seenValues = new Set<number>();
  const textGroups = new GroupDistinct();
  let scopeSize = 0;
  let numbersCount = 0;
  let otherCount = 0;
  let numbersInText = 0;

  for (const input of inputs) {
    const { column, rows } = input;
    const n = rows ? rows.length : input.ids.length;
    scopeSize += n;
    if (!column || column.count === 0) continue;
    const groupOf = grouped ? groupMapper(input.modelId, input.group ?? null, groups) : null;

    if (column.type === 'numeric') {
      // The bucket of each of the column's units.
      const bucketOf: Bucket[] = column.units.map((unit) => {
        const key = mergedUnitKey(input.modelId, unit.key);
        let b = buckets.get(key);
        if (!b) {
          b = {
            totals: {
              unit: { key: unit.key, symbol: unit.symbol },
              key,
              ...(isNotStated(unit.key) ? { modelId: input.modelId } : {}),
              stats: emptyStats(),
            },
            groupStats: grouped ? new GroupStats() : null,
          };
          buckets.set(key, b);
          order.push(b);
        }
        return b;
      });
      const vals = column.values;
      const unitIndex = column.unitIndex;
      for (let k = 0; k < n; k++) {
        const r = rows ? rows[k] : k;
        const v = vals[r];
        if (Number.isNaN(v)) continue;
        const b = bucketOf[unitIndex ? unitIndex[r] : 0];
        const s = b.totals.stats;
        s.count++;
        s.sum += v;
        if (v < s.min) s.min = v;
        if (v > s.max) s.max = v;
        if (groupOf) b.groupStats!.add(groupOf(r), v);
      }
      continue;
    }

    // Text, yes/no, enumerations (and numbers among them).
    const valueOf = new Int32Array(column.dictionary.length);
    const isNumber = new Uint8Array(column.dictionary.length);
    column.dictionary.forEach((v, code) => {
      valueOf[code] = values.of(v);
      isNumber[code] = typeof v === 'number' ? 1 : 0;
    });
    const codes = column.codes;
    for (let k = 0; k < n; k++) {
      const r = rows ? rows[k] : k;
      const code = codes[r];
      if (code < 0) continue;
      otherCount++;
      numbersInText += isNumber[code];
      seenValues.add(valueOf[code]);
      if (groupOf) textGroups.add(groupOf(r), valueOf[code]);
    }
  }

  for (const b of order) numbersCount += b.totals.stats.count;
  const withValue = numbersCount + otherCount;
  const kind: Totals['kind'] =
    withValue === 0
      ? 'none'
      : otherCount === 0
        ? 'numeric'
        : numbersCount === 0 && numbersInText === 0
          ? 'discrete'
          : 'mixed';

  if (kind === 'mixed' && numbersCount > 0) {
    // Numbers from columns that were all numbers count as values too.
    for (const input of inputs) {
      const { column, rows } = input;
      if (!column || column.type !== 'numeric') continue;
      const groupOf = grouped ? groupMapper(input.modelId, input.group ?? null, groups) : null;
      const n = rows ? rows.length : input.ids.length;
      for (let k = 0; k < n; k++) {
        const r = rows ? rows[k] : k;
        const v = column.values[r];
        if (Number.isNaN(v)) continue;
        const value = values.of(v);
        seenValues.add(value);
        if (groupOf) textGroups.add(groupOf(r), value);
      }
    }
  }

  const numbers =
    kind === 'numeric'
      ? order
          .map((b) => ({ ...b.totals, ...(b.groupStats ? { groups: b.groupStats.lines(groups) } : {}) }))
          .sort((a, b) => b.stats.count - a.stats.count)
      : [];
  const verdict: SumVerdict =
    kind === 'numeric'
      ? canSum({ kind: 'numeric', units: numbers.map((u) => ({ key: u.key, symbol: u.unit.symbol, count: u.stats.count })) })
      : canSum({ kind: kind === 'none' ? 'numeric' : kind === 'mixed' ? 'mixed' : 'text', units: [] });
  // canSum was given the merged keys; report the units as the model states them.
  if (verdict.ok) verdict.unit = numbers[0].unit;

  const totals: Totals = {
    kind,
    scopeSize,
    withValue,
    numbers,
    verdict,
    distinct: kind === 'discrete' || kind === 'mixed' ? seenValues.size : 0,
  };
  if (grouped && (kind === 'discrete' || kind === 'mixed')) totals.groups = textGroups.lines(groups);
  return totals;
}

/**
 * The elements of the scope behind one line of a table: those with a value
 * for the parameter, in unit `unitKey` (a merged key, see `UnitTotals.key`)
 * when given, and in group `groupKey` when given. What clicking the line
 * selects.
 */
export function lineElements(
  inputs: readonly TotalsInput[],
  line: { unitKey?: string; groupKey?: string },
): { modelId: string; expressId: number }[] {
  const out: { modelId: string; expressId: number }[] = [];
  const groups = new GroupRegistry();
  for (const input of inputs) {
    const { column, rows } = input;
    if (!column) continue;
    const n = rows ? rows.length : input.ids.length;
    const groupOf = line.groupKey !== undefined ? groupMapper(input.modelId, input.group ?? null, groups) : null;
    let unitOk: ((r: number) => boolean) | null = null;
    if (line.unitKey !== undefined) {
      if (column.type !== 'numeric') continue;
      const ok = column.units.map((u) => mergedUnitKey(input.modelId, u.key) === line.unitKey);
      if (!ok.some(Boolean)) continue;
      const unitIndex = column.unitIndex;
      unitOk = (r) => ok[unitIndex ? unitIndex[r] : 0];
    }
    for (let k = 0; k < n; k++) {
      const r = rows ? rows[k] : k;
      const has = column.type === 'numeric' ? !Number.isNaN(column.values[r]) : column.codes[r] >= 0;
      if (!has) continue;
      if (unitOk && !unitOk(r)) continue;
      if (groupOf && groups.keys[groupOf(r)] !== line.groupKey) continue;
      out.push({ modelId: input.modelId, expressId: input.ids[r] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ordering and charts
// ---------------------------------------------------------------------------

/** What a grouped table can be sorted by. */
export type SortBy = 'label' | 'count' | 'sum' | 'min' | 'max' | 'mean' | 'distinct';

/** The number a line is sorted and drawn by. */
export function lineValue(line: GroupLine, by: SortBy): number {
  switch (by) {
    case 'count':
      return line.stats.count;
    case 'sum':
      return line.stats.sum;
    case 'min':
      return line.stats.min;
    case 'max':
      return line.stats.max;
    case 'mean':
      return mean(line.stats);
    case 'distinct':
      return line.distinct ?? 0;
    case 'label':
      return NaN;
  }
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Lines sorted by `by`, largest first when `descending`. "(no value)" is
 * always last; ties keep their order of first appearance.
 */
export function sortLines(lines: readonly GroupLine[], by: SortBy, descending: boolean): GroupLine[] {
  const dir = descending ? -1 : 1;
  return lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => {
      const an = a.line.key === NO_VALUE_GROUP;
      const bn = b.line.key === NO_VALUE_GROUP;
      if (an !== bn) return an ? 1 : -1;
      let d: number;
      if (by === 'label') d = collator.compare(a.line.label, b.line.label);
      else {
        const av = lineValue(a.line, by);
        const bv = lineValue(b.line, by);
        d = Number.isNaN(av) || Number.isNaN(bv) ? 0 : av - bv;
      }
      return d !== 0 ? d * dir : a.i - b.i;
    })
    .map((x) => x.line);
}

/**
 * Bar lengths, 0..1, for lines by `by`: proportional to the largest. Null
 * when bars would mislead (a negative value, or sorting by name).
 */
export function barFractions(lines: readonly GroupLine[], by: SortBy): number[] | null {
  if (by === 'label') return null;
  let max = 0;
  for (const l of lines) {
    const v = lineValue(l, by);
    if (Number.isNaN(v)) continue;
    if (v < 0) return null;
    if (v > max) max = v;
  }
  return lines.map((l) => {
    const v = lineValue(l, by);
    return max > 0 && !Number.isNaN(v) ? v / max : 0;
  });
}

/** One slice of a share chart. */
export interface Slice {
  label: string;
  value: number;
  /** Of the whole, 0..1. */
  share: number;
  /** Index into the category colours; -1 for "other". */
  colour: number;
}

/** Slices shown before the rest are joined into "Other". */
export const PIE_SLICES = 8;

/**
 * The share of each group in the whole, by `by` (`sum` for numbers, `count`
 * for text): the largest `top` groups, then one "Other" slice. Null when a
 * share means nothing: a negative value, or a whole of zero.
 */
export function pieSlices(lines: readonly GroupLine[], by: 'sum' | 'count', top = PIE_SLICES): Slice[] | null {
  let whole = 0;
  for (const l of lines) {
    const v = by === 'sum' ? l.stats.sum : l.stats.count;
    if (v < 0 || Number.isNaN(v)) return null;
    whole += v;
  }
  if (whole <= 0) return null;
  const sorted = sortLines(lines, by, true);
  const slices: Slice[] = sorted.slice(0, top).map((l, i) => {
    const value = by === 'sum' ? l.stats.sum : l.stats.count;
    return { label: l.label, value, share: value / whole, colour: i };
  });
  const rest = sorted.slice(top);
  if (rest.length > 0) {
    const value = rest.reduce((n, l) => n + (by === 'sum' ? l.stats.sum : l.stats.count), 0);
    slices.push({ label: `Other (${rest.length})`, value, share: value / whole, colour: -1 });
  }
  return slices;
}

/** Rows as tab-separated text that pastes into a spreadsheet as cells. */
export function toTsv(rows: readonly (readonly (string | number)[])[]): string {
  const cell = (c: string | number): string =>
    typeof c === 'number' ? (Number.isFinite(c) ? String(c) : '') : c.replace(/[\t\r\n]+/g, ' ');
  return rows.map((r) => r.map(cell).join('\t')).join('\n');
}
