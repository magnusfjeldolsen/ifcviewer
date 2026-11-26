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
import { shownNumber } from './parameterFold';
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
  /** The group's value (absent for "(no value)"): tells look-alike labels apart. */
  value?: ParameterValue;
  /** For a number in a unit its model does not state: whose. */
  modelId?: string;
}

/** What a group is, besides its label. */
interface GroupMeta {
  value?: ParameterValue;
  modelId?: string;
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
  readonly meta: GroupMeta[] = [];

  of(key: string, label: string, meta: GroupMeta = {}): number {
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.keys.length;
      this.index.set(key, i);
      this.keys.push(key);
      this.labels.push(label);
      this.meta.push(meta);
    }
    return i;
  }

  /** A line of group `g`, with what it is. */
  line(g: number, stats: Stats, distinct?: number): GroupLine {
    const out: GroupLine = { key: this.keys[g], label: this.labels[g], stats, ...this.meta[g] };
    if (distinct !== undefined) out.distinct = distinct;
    return out;
  }
}

function valueKey(v: ParameterValue): string {
  // Numbers by how they show, as the Parameters list counts them.
  return `${typeof v}:${String(typeof v === 'number' ? shownNumber(v) : v)}`;
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
    group.dictionary.forEach((v, code) => (map[code] = groups.of(`v:${valueKey(v)}`, legendValueText(v), { value: v })));
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
    const shown = shownNumber(v);
    let g = perUnit[u].get(shown);
    if (g === undefined) {
      const unit = group.units[u];
      const label = legendValueText(shown) + (unit.symbol ? ` ${unit.symbol}` : '');
      g = groups.of(`n:${shown}|${mergedUnitKey(modelId, unit.key)}`, label, {
        value: shown,
        ...(isNotStated(unit.key) ? { modelId } : {}),
      });
      perUnit[u].set(shown, g);
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
      out.push(groups.line(g, { count: this.count[g], sum: this.sum[g], min: this.min[g], max: this.max[g] }));
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
      const shown = shownNumber(v);
      let i = this.numbers.get(shown);
      if (i === undefined) this.numbers.set(shown, (i = this.size++));
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
      out.push(groups.line(g, { count: this.count[g], sum: NaN, min: NaN, max: NaN }, this.seen[g].size));
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
  /** Values that are not numbers (text, yes/no). */
  let textCount = 0;

  /** The bucket of a unit of a model's numbers. */
  const bucketFor = (modelId: string, unit: UnitRef): Bucket => {
    const key = mergedUnitKey(modelId, unit.key);
    let b = buckets.get(key);
    if (!b) {
      b = {
        totals: {
          unit: { key: unit.key, symbol: unit.symbol },
          key,
          ...(isNotStated(unit.key) ? { modelId } : {}),
          stats: emptyStats(),
        },
        groupStats: grouped ? new GroupStats() : null,
      };
      buckets.set(key, b);
      order.push(b);
    }
    return b;
  };
  const addNumber = (b: Bucket, v: number, g: number): void => {
    const s = b.totals.stats;
    s.count++;
    s.sum += v;
    if (v < s.min) s.min = v;
    if (v > s.max) s.max = v;
    if (g >= 0) b.groupStats!.add(g, v);
  };

  for (const input of inputs) {
    const { column, rows } = input;
    const n = rows ? rows.length : input.ids.length;
    scopeSize += n;
    if (!column || column.count === 0) continue;
    const groupOf = grouped ? groupMapper(input.modelId, input.group ?? null, groups) : null;

    if (column.type === 'numeric') {
      const bucketOf = column.units.map((unit) => bucketFor(input.modelId, unit));
      const vals = column.values;
      const unitIndex = column.unitIndex;
      for (let k = 0; k < n; k++) {
        const r = rows ? rows[k] : k;
        const v = vals[r];
        if (Number.isNaN(v)) continue;
        addNumber(bucketOf[unitIndex ? unitIndex[r] : 0], v, groupOf ? groupOf(r) : -1);
      }
      continue;
    }

    // Text, yes/no, enumerations, and numbers among them. What counts is
    // what the scope holds: numbers here are added up like any others when
    // the scope has no text.
    const valueOf = new Int32Array(column.dictionary.length);
    const isNumber = new Uint8Array(column.dictionary.length);
    column.dictionary.forEach((v, code) => {
      valueOf[code] = values.of(v);
      isNumber[code] = typeof v === 'number' ? 1 : 0;
    });
    // A column built before units were kept for its numbers: their unit is not known.
    const units = column.units && column.units.length > 0 ? column.units : [{ key: '?UNIT', symbol: '' }];
    const unitIndex = column.unitIndex ?? null;
    let bucketOf: Bucket[] | null = null;
    const codes = column.codes;
    for (let k = 0; k < n; k++) {
      const r = rows ? rows[k] : k;
      const code = codes[r];
      if (code < 0) continue;
      const g = groupOf ? groupOf(r) : -1;
      if (isNumber[code]) {
        bucketOf ??= units.map((unit) => bucketFor(input.modelId, unit));
        addNumber(bucketOf[unitIndex ? unitIndex[r] : 0], column.dictionary[code] as number, g);
      } else textCount++;
      seenValues.add(valueOf[code]);
      if (g >= 0) textGroups.add(g, valueOf[code]);
    }
  }

  for (const b of order) numbersCount += b.totals.stats.count;
  const withValue = numbersCount + textCount;
  const kind: Totals['kind'] =
    withValue === 0 ? 'none' : textCount === 0 ? 'numeric' : numbersCount === 0 ? 'discrete' : 'mixed';

  if (kind === 'mixed') {
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
          .filter((b) => b.totals.stats.count > 0)
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

/**
 * The lines with labels that tell them apart. Two groups can look alike: a
 * number in a unit two models leave unstated (one group per model), or the
 * text "true" and yes/no true. Those get the model's name, or quotes round text; anything still
 * alike gets a number. Lines that are not alike keep their label.
 */
export function distinctLabels(lines: readonly GroupLine[], modelName: (modelId: string) => string): GroupLine[] {
  const count = new Map<string, number>();
  for (const l of lines) count.set(l.label, (count.get(l.label) ?? 0) + 1);
  if (lines.every((l) => count.get(l.label) === 1)) return [...lines];
  const better = (l: GroupLine): string => {
    let label = l.label;
    if (typeof l.value === 'string') label = `"${l.value}"`;
    if (l.modelId) label += ` (${modelName(l.modelId)})`;
    return label;
  };
  const relabelled = lines.map((l) => (count.get(l.label)! > 1 ? { ...l, label: better(l) } : l));
  const seen = new Map<string, number>();
  return relabelled.map((l) => {
    const n = (seen.get(l.label) ?? 0) + 1;
    seen.set(l.label, n);
    return n === 1 ? l : { ...l, label: `${l.label} #${n}` };
  });
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
  /** The group's key (labels need not be unique); absent for "other". */
  key?: string;
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
    return { label: l.label, value, share: value / whole, colour: i, key: l.key };
  });
  const rest = sorted.slice(top);
  if (rest.length > 0) {
    const value = rest.reduce((n, l) => n + (by === 'sum' ? l.stats.sum : l.stats.count), 0);
    slices.push({ label: `Other (${rest.length})`, value, share: value / whole, colour: -1 });
  }
  return slices;
}

/**
 * Rows as tab-separated text that pastes into a spreadsheet as cells.
 * Numbers keep 12 significant digits: still numbers to the spreadsheet, but
 * without the float noise of a sum (1234.5600000000002 → 1234.56).
 */
export function toTsv(rows: readonly (readonly (string | number)[])[]): string {
  const cell = (c: string | number): string =>
    typeof c === 'number' ? (Number.isFinite(c) ? String(Number(c.toPrecision(12))) : '') : c.replace(/[\t\r\n]+/g, ' ');
  return rows.map((r) => r.map(cell).join('\t')).join('\n');
}
