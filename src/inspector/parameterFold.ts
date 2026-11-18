/**
 * Parameter discovery fold: element after element, what parameters exist in
 * a scope, how many elements carry each, and what their values look like.
 *
 * Pure and DOM-free so the worker can import it. It never holds an
 * element's properties after `add` returns: per parameter it keeps counts,
 * a numeric range, and at most `DISTINCT_CAP` distinct values. The one
 * exception is a parameter that has not repeated a value yet once it passes
 * the cap — it keeps a set of what it has seen until the first repeat, so
 * "unique per element" (GlobalId, Tag) can be told apart from "many values".
 * Only truly unique parameters keep that set to the end.
 *
 * One value per element per path: rows go through `firstRowPerPath`, the
 * same rule matching uses, so a path on both the instance and its type is
 * counted once, with the instance's value.
 */

import { firstRowPerPath } from './repository/flatRows';
import type {
  ElementProperties,
  ModelParameters,
  ParameterKind,
  ParameterSummary,
  ParameterValue,
  PropertyFlatRow,
  PropertyValue,
} from './types';

/** Distinct values kept per parameter. Past this, only the count "more than" is known. */
export const DISTINCT_CAP = 200;

/**
 * The value discovery counts for one row, or null when the row has none.
 *
 * Single values and quantities keep their normalised type (a number stays a
 * number); an enumeration is its values joined, as the inspector shows it;
 * any other kind (list, bounded, table) counts as its display text.
 */
export function parameterValueOf(value: PropertyValue, display: string): ParameterValue | null {
  switch (value.kind) {
    case 'single':
      if (typeof value.value === 'number' && !Number.isFinite(value.value)) return null;
      return value.value;
    case 'quantity':
      return Number.isFinite(value.value) ? value.value : null;
    case 'enumerated':
      return value.values.length > 0 ? value.values.join(', ') : null;
    case 'varies':
    case 'material-ref':
    case 'complex':
      return null;
    default:
      return display === '' ? null : display;
  }
}

function kindOf(v: ParameterValue): Exclude<ParameterKind, 'mixed'> {
  if (typeof v === 'number') return 'numeric';
  if (typeof v === 'boolean') return 'boolean';
  return 'text';
}

interface Accumulator {
  count: number;
  kind: ParameterKind | null;
  unit: string | undefined;
  unitSeen: boolean;
  unitsDiffer: boolean;
  min: number;
  max: number;
  sum: number;
  numericCount: number;
  /** Distinct value → count, until the cap is passed; then null. */
  values: Map<ParameterValue, number> | null;
  /** Some value has occurred on two elements. */
  repeated: boolean;
  /** Past the cap and not repeated yet: every value seen, to spot the first repeat. */
  seen: Set<ParameterValue> | null;
}

export class ParameterFold {
  private params = new Map<string, Accumulator>();
  private elements = 0;

  constructor(private readonly cap: number = DISTINCT_CAP) {}

  /** Fold one element's properties in. */
  add(props: ElementProperties): void {
    this.addRows(props.flat);
  }

  /** Fold one element's flat rows in. */
  addRows(rows: readonly PropertyFlatRow[]): void {
    this.elements++;
    for (const [path, row] of firstRowPerPath(rows)) {
      const value = parameterValueOf(row.rawValue, row.displayValue);
      if (value === null) continue;
      let acc = this.params.get(path);
      if (!acc) {
        acc = {
          count: 0,
          kind: null,
          unit: undefined,
          unitSeen: false,
          unitsDiffer: false,
          min: Infinity,
          max: -Infinity,
          sum: 0,
          numericCount: 0,
          values: new Map(),
          repeated: false,
          seen: null,
        };
        this.params.set(path, acc);
      }
      this.fold(acc, value, row.unit);
    }
  }

  /** Elements folded so far. */
  get elementCount(): number {
    return this.elements;
  }

  /** The summary so far. `scopeSize` is the number of elements the scope holds. */
  result(modelId: string, scopeSize: number): ModelParameters {
    const keys = [...this.params.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parameters = keys.map((key) => summarise(key, this.params.get(key)!));
    return { modelId, scopeSize, parameters };
  }

  private fold(acc: Accumulator, value: ParameterValue, unit: string | undefined): void {
    acc.count++;
    const kind = kindOf(value);
    acc.kind = acc.kind === null || acc.kind === kind ? kind : 'mixed';

    if (unit !== undefined && unit !== '') {
      if (!acc.unitSeen) {
        acc.unit = unit;
        acc.unitSeen = true;
      } else if (unit !== acc.unit) {
        acc.unitsDiffer = true;
      }
    }

    if (typeof value === 'number') {
      if (value < acc.min) acc.min = value;
      if (value > acc.max) acc.max = value;
      acc.sum += value;
      acc.numericCount++;
    }

    if (acc.values) {
      const c = acc.values.get(value);
      if (c !== undefined) {
        acc.values.set(value, c + 1);
        acc.repeated = true;
      } else if (acc.values.size < this.cap) {
        acc.values.set(value, 1);
      } else {
        // Past the cap: the counts are dropped (a partial tally would
        // mislead). Keep watching for a repeat only while there has been none.
        acc.seen = acc.repeated ? null : new Set(acc.values.keys());
        acc.seen?.add(value);
        acc.values = null;
      }
    } else if (acc.seen) {
      if (acc.seen.has(value)) {
        acc.repeated = true;
        acc.seen = null;
      } else {
        acc.seen.add(value);
      }
    }
  }
}

function summarise(key: string, acc: Accumulator): ParameterSummary {
  const out: ParameterSummary = {
    key,
    count: acc.count,
    kind: acc.kind ?? 'text',
    distinct: acc.values ? acc.values.size : null,
    uniquePerElement: !acc.repeated && acc.count > 1,
  };
  if (acc.unit !== undefined) out.unit = acc.unit;
  if (acc.unitsDiffer) out.unitsDiffer = true;
  if (acc.numericCount > 0) out.numeric = { min: acc.min, max: acc.max, sum: acc.sum };
  if (acc.values) {
    out.values = [...acc.values.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || compareValues(a.value, b.value));
  }
  return out;
}

/** A stable order for values of mixed types: numbers, then booleans, then text. */
function compareValues(a: ParameterValue, b: ParameterValue): number {
  const rank = (v: ParameterValue): number => (typeof v === 'number' ? 0 : typeof v === 'boolean' ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
