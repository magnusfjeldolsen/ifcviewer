/**
 * Value columns: one parameter's value for every element of a model's scope,
 * in typed arrays (#67, for colouring in #68 and totals in #69).
 *
 * A column is built once, in the IFC worker, by reading every element of the
 * scope (the same read discovery does), and then answers "what value does
 * element i have" and "which elements have value v" without asking the
 * worker again. Every column of a model lines up with one shared `ids`
 * array, the model's scope: row i is element `ids[i]` in every column.
 *
 *  - **Numeric** (every value is a number): `values` is a `Float64Array`,
 *    NaN where the element has no value. The units the values are in are
 *    listed once; `unitIndex` says which one each row is in, and is null when
 *    they are all in one.
 *  - **Discrete** (text, yes/no, enumerations, or a mix with numbers):
 *    `codes` is an `Int32Array` of indices into `dictionary`, -1 where the
 *    element has no value.
 *
 * About 12 bytes per element for a numeric column (8 with one unit) and 4
 * plus the dictionary for a discrete one; built only when asked for. See
 * docs/adr/0004.
 *
 * A row's value is decided exactly as discovery decides it
 * (`parameterValueOf` on the first row at the path), so a column's counts
 * are the counts the Parameters list shows, and the elements it finds for a
 * value are the elements that count was of.
 *
 * Pure and DOM-free: the worker imports the builder, the main thread the
 * readers.
 */

import { parameterValueOf, shownNumber, sortValueCounts, type ValueCount } from './parameterFold';
import type { ElementProperties, ParameterValue } from './types';
import type { UnitCount, UnitRef } from './units';

interface ColumnCommon {
  /** The parameter: its flat-row path, e.g. "Pset_WallCommon.Width". */
  key: string;
  /** Rows that have a value. */
  count: number;
}

/** Every value a number. */
export interface NumericColumnData extends ColumnCommon {
  type: 'numeric';
  /** Per row; NaN where the element has no value. */
  values: Float64Array;
  /** The units the values are in, in order of first appearance (see `units.ts`). */
  units: UnitRef[];
  /**
   * Per row, an index into `units`; null when every value is in `units[0]`.
   * 16-bit, widened to 32-bit in the (absurd) case of more than 65,536 units.
   */
  unitIndex: Uint16Array | Uint32Array | null;
}

/** Text, yes/no, enumerations, or numbers mixed with those. */
export interface DiscreteColumnData extends ColumnCommon {
  type: 'discrete';
  /** Per row, an index into `dictionary`; -1 where the element has no value. */
  codes: Int32Array;
  /** The distinct values, in order of first appearance. */
  dictionary: ParameterValue[];
  /**
   * When some values are numbers (a mix): the units those numbers are in,
   * and per row an index into them (null when there is one). Lets totals
   * add up a scope whose own values are all numbers (#69).
   */
  units?: UnitRef[];
  unitIndex?: Uint16Array | Uint32Array | null;
}

/** A column as the worker sends it: without the scope, which the main thread already has. */
export type ColumnData = NumericColumnData | DiscreteColumnData;

/** A column with its scope: row i is element `ids[i]`. */
export type ParameterColumn = ColumnData & {
  modelId: string;
  /** The model's scope, shared by every column of the model. */
  ids: Int32Array;
};

/** The buffers to transfer (not copy) with a column. */
export function columnTransferables(c: ColumnData): ArrayBuffer[] {
  if (c.type === 'discrete') {
    return c.unitIndex ? [c.codes.buffer as ArrayBuffer, c.unitIndex.buffer as ArrayBuffer] : [c.codes.buffer as ArrayBuffer];
  }
  return c.unitIndex
    ? [c.values.buffer as ArrayBuffer, c.unitIndex.buffer as ArrayBuffer]
    : [c.values.buffer as ArrayBuffer];
}

/**
 * Builds one column in the worker, element by element. Holds both a numeric
 * and a coded form while building (it cannot know which it is until the
 * last element) and keeps the one that fits.
 */
export class ColumnBuilder {
  private numbers: Float64Array;
  private codes: Int32Array;
  private unitOf: Uint16Array | Uint32Array;
  private dictionary: ParameterValue[] = [];
  private codeOf = new Map<ParameterValue, number>();
  private units: UnitRef[] = [];
  private unitIndexOf = new Map<string, number>();
  private allNumeric = true;
  private count = 0;

  constructor(
    private readonly key: string,
    readonly size: number,
  ) {
    this.numbers = new Float64Array(size).fill(NaN);
    this.codes = new Int32Array(size).fill(-1);
    this.unitOf = new Uint16Array(size);
  }

  /** Row `index` is this element. */
  add(index: number, props: ElementProperties): void {
    // The first row at the path, as `firstRowPerPath` decides it, without
    // building a map of every path for each element.
    const row = props.flat.find((r) => r.path === this.key);
    if (!row) return;
    const value = parameterValueOf(row.rawValue, row.displayValue);
    if (value === null) return;
    this.count++;

    let code = this.codeOf.get(value);
    if (code === undefined) {
      code = this.dictionary.length;
      this.dictionary.push(value);
      this.codeOf.set(value, code);
    }
    this.codes[index] = code;

    if (typeof value !== 'number') {
      this.allNumeric = false;
      return;
    }
    this.numbers[index] = value;
    const unitKey = row.unitKey ?? '';
    let u = this.unitIndexOf.get(unitKey);
    if (u === undefined) {
      u = this.units.length;
      this.units.push({ key: unitKey, symbol: row.unit ?? '' });
      this.unitIndexOf.set(unitKey, u);
      // An index past 16 bits would wrap round to another unit: widen first.
      if (u > 0xffff && this.unitOf instanceof Uint16Array) this.unitOf = Uint32Array.from(this.unitOf);
    }
    this.unitOf[index] = u;
  }

  /** The finished column. The builder must not be used afterwards. */
  finish(): ColumnData {
    if (this.allNumeric && this.count > 0) {
      return {
        type: 'numeric',
        key: this.key,
        count: this.count,
        values: this.numbers,
        units: this.units,
        unitIndex: this.units.length > 1 ? this.unitOf : null,
      };
    }
    const column: DiscreteColumnData = { type: 'discrete', key: this.key, count: this.count, codes: this.codes, dictionary: this.dictionary };
    // Numbers among text: keep their units (only then), as a number column would.
    if (this.units.length > 0) {
      column.units = this.units;
      column.unitIndex = this.units.length > 1 ? this.unitOf : null;
    }
    return column;
  }
}

// ---------------------------------------------------------------------------
// Reading a column (main thread)
// ---------------------------------------------------------------------------

/**
 * Every distinct value with how many elements hold it, most common first —
 * as the Parameters list orders them. When a number column's values are in
 * more than one unit, a value is distinct per unit: 3 mm and 3 m are two
 * entries, each carrying its unit.
 */
export function columnValueCounts(c: ColumnData): ValueCount[] {
  if (c.type === 'discrete') {
    const n = new Array<number>(c.dictionary.length).fill(0);
    for (let i = 0; i < c.codes.length; i++) {
      const code = c.codes[i];
      if (code >= 0) n[code]++;
    }
    // Numbers that show alike are one value, whatever code they were given.
    const merged = new Map<ParameterValue, number>();
    c.dictionary.forEach((v, i) => {
      const k = typeof v === 'number' ? shownNumber(v) : v;
      merged.set(k, (merged.get(k) ?? 0) + n[i]);
    });
    return sortValueCounts([...merged.entries()].map(([value, count]) => ({ value, count })));
  }
  if (c.unitIndex) {
    const unitIndex = c.unitIndex;
    const perUnit = c.units.map(() => new Map<number, number>());
    for (let i = 0; i < c.values.length; i++) {
      const v = c.values[i];
      if (Number.isNaN(v)) continue;
      const counts = perUnit[unitIndex[i]];
      const shown = shownNumber(v);
      counts.set(shown, (counts.get(shown) ?? 0) + 1);
    }
    return sortValueCounts(
      perUnit.flatMap((counts, u) => [...counts.entries()].map(([value, count]) => ({ value, count, unit: c.units[u] }))),
    );
  }
  const counts = new Map<number, number>();
  for (let i = 0; i < c.values.length; i++) {
    const v = c.values[i];
    if (!Number.isNaN(v)) {
      const shown = shownNumber(v);
      counts.set(shown, (counts.get(shown) ?? 0) + 1);
    }
  }
  return sortValueCounts([...counts.entries()].map(([value, count]) => ({ value, count })));
}

/**
 * The rows whose value is `value`, compared exactly as the list counted it.
 * With `unitKey`, only rows whose number is in that unit: what picking one
 * entry of a mixed-unit list selects. A column in a single unit matches its
 * own unit's key (or no key given).
 */
export function columnRowsWithValue(c: ColumnData, value: ParameterValue, unitKey?: string): number[] {
  const rows: number[] = [];
  if (c.type === 'numeric') {
    if (typeof value !== 'number') return rows;
    let only = -1;
    if (unitKey !== undefined) {
      only = c.units.findIndex((u) => u.key === unitKey);
      if (only < 0) return rows;
    }
    const unitIndex = c.unitIndex;
    const shown = shownNumber(value);
    for (let i = 0; i < c.values.length; i++) {
      if (shownNumber(c.values[i]) !== shown) continue;
      if (only >= 0 && (unitIndex ? unitIndex[i] : 0) !== only) continue;
      rows.push(i);
    }
    return rows;
  }
  // Every code whose value shows the same as `value` (numbers by how they show).
  const want = typeof value === 'number' ? shownNumber(value) : value;
  const codes = new Set<number>();
  c.dictionary.forEach((v, i) => {
    if ((typeof v === 'number' ? shownNumber(v) : v) === want) codes.add(i);
  });
  if (codes.size === 0) return rows;
  // A number among text, asked for in one unit: only rows in that unit.
  let only = -1;
  if (unitKey !== undefined && typeof value === 'number' && c.units) {
    only = c.units.findIndex((u) => u.key === unitKey);
    if (only < 0) return rows;
  }
  const unitIndex = c.unitIndex ?? null;
  for (let i = 0; i < c.codes.length; i++) {
    if (!codes.has(c.codes[i])) continue;
    if (only >= 0 && (unitIndex ? unitIndex[i] : 0) !== only) continue;
    rows.push(i);
  }
  return rows;
}

/** The elements whose value is `value` (in unit `unitKey`, when given). */
export function columnIdsWithValue(c: ParameterColumn, value: ParameterValue, unitKey?: string): number[] {
  return columnRowsWithValue(c, value, unitKey).map((row) => c.ids[row]);
}

/**
 * The units of the values in `rows` (all rows when omitted), most common
 * first: what `canSum` needs to answer for a selection rather than the
 * whole scope. Empty for a discrete column.
 */
export function columnUnits(c: ColumnData, rows?: Iterable<number>): UnitCount[] {
  if (c.type === 'discrete') return [];
  const n = new Array<number>(c.units.length).fill(0);
  const visit = (i: number): void => {
    if (!Number.isNaN(c.values[i])) n[c.unitIndex ? c.unitIndex[i] : 0]++;
  };
  if (rows) for (const i of rows) visit(i);
  else for (let i = 0; i < c.values.length; i++) visit(i);
  return c.units
    .map((u, i) => ({ ...u, count: n[i] }))
    .filter((u) => u.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** Bytes held in the column's typed arrays (not counting the shared `ids`). */
export function columnBytes(c: ColumnData): number {
  if (c.type === 'discrete') return c.codes.byteLength + (c.unitIndex?.byteLength ?? 0);
  return c.values.byteLength + (c.unitIndex?.byteLength ?? 0);
}
