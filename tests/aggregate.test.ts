/**
 * Totals (#69): the pure aggregation over value columns. Units are never
 * mixed, an unstated unit is its own model's, grouping splits every total.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregate,
  barFractions,
  lineElements,
  mean,
  pieSlices,
  sortLines,
  toTsv,
  type GroupLine,
  type TotalsInput,
} from '../src/inspector/aggregate';
import type { ColumnData, DiscreteColumnData, NumericColumnData } from '../src/inspector/parameterColumn';
import type { ParameterValue } from '../src/inspector/types';
import type { UnitRef } from '../src/inspector/units';

const M3: UnitRef = { key: 'si:m³', symbol: 'm³' };
const FT3: UnitRef = { key: 'conv:cubic foot*0.0283168 si:m³', symbol: 'ft³' };
const UNSTATED: UnitRef = { key: '?VOLUMEUNIT', symbol: '' };

function numeric(values: (number | null)[], units: UnitRef[] = [M3], unitOf?: number[]): NumericColumnData {
  return {
    type: 'numeric',
    key: 'Q.Volume',
    count: values.filter((v) => v !== null).length,
    values: Float64Array.from(values.map((v) => (v === null ? NaN : v))),
    units,
    unitIndex: unitOf ? Uint16Array.from(unitOf) : null,
  };
}

function discrete(values: (ParameterValue | null)[]): DiscreteColumnData {
  const dictionary: ParameterValue[] = [];
  const codes = values.map((v) => {
    if (v === null) return -1;
    let i = dictionary.indexOf(v);
    if (i < 0) i = dictionary.push(v) - 1;
    return i;
  });
  return { type: 'discrete', key: 'P.Text', count: codes.filter((c) => c >= 0).length, codes: Int32Array.from(codes), dictionary };
}

function input(modelId: string, column: ColumnData | null, size: number, rows?: number[], group?: ColumnData | null): TotalsInput {
  const out: TotalsInput = {
    modelId,
    ids: Int32Array.from({ length: size }, (_, i) => 100 + i),
    rows: rows ? Int32Array.from(rows) : null,
    column,
  };
  if (group !== undefined) out.group = group;
  return out;
}

describe('aggregate: one parameter over a scope', () => {
  it('counts, adds up, and finds min, max and average in one unit', () => {
    const t = aggregate([input('a', numeric([1, 2, null, 4]), 4)]);
    expect(t.kind).toBe('numeric');
    expect(t.scopeSize).toBe(4);
    expect(t.withValue).toBe(3);
    expect(t.numbers).toHaveLength(1);
    const s = t.numbers[0].stats;
    expect(s).toEqual({ count: 3, sum: 7, min: 1, max: 4 });
    expect(mean(s)).toBeCloseTo(7 / 3);
    expect(t.verdict).toMatchObject({ ok: true, unit: M3, unitStated: true });
  });

  it('keeps to the rows in scope', () => {
    const t = aggregate([input('a', numeric([1, 2, 3, 4]), 4, [1, 3])]);
    expect(t.scopeSize).toBe(2);
    expect(t.numbers[0].stats.sum).toBe(6);
  });

  it('refuses to add up numbers in two units: one total per unit, most values first', () => {
    const t = aggregate([input('a', numeric([1, 2, 3], [FT3, M3], [0, 1, 1]), 3)]);
    expect(t.numbers.map((u) => [u.unit.symbol, u.stats.sum])).toEqual([
      ['m³', 5],
      ['ft³', 1],
    ]);
    expect(t.verdict).toMatchObject({ ok: false, reason: 'mixed-units' });
  });

  it('adds up two models in the same stated unit', () => {
    const t = aggregate([input('a', numeric([1, 2]), 2), input('b', numeric([10]), 1)]);
    expect(t.numbers).toHaveLength(1);
    expect(t.numbers[0].stats).toEqual({ count: 3, sum: 13, min: 1, max: 10 });
    expect(t.scopeSize).toBe(3);
  });

  it('never adds up an unstated unit from two models', () => {
    const t = aggregate([input('a', numeric([1, 2], [UNSTATED]), 2), input('b', numeric([10], [UNSTATED]), 1)]);
    expect(t.numbers).toHaveLength(2);
    expect(t.numbers.map((u) => u.modelId).sort()).toEqual(['a', 'b']);
    expect(t.verdict.ok).toBe(false);
  });

  it('adds up an unstated unit within one model, saying it is not stated', () => {
    const t = aggregate([input('a', numeric([1, 2], [UNSTATED]), 2)]);
    expect(t.verdict).toMatchObject({ ok: true, unitStated: false });
    expect(t.numbers[0].stats.sum).toBe(3);
  });

  it('counts a model without the parameter in the scope but not in the values', () => {
    const t = aggregate([input('a', numeric([5]), 1), input('b', null, 3)]);
    expect(t.scopeSize).toBe(4);
    expect(t.withValue).toBe(1);
  });

  it('says when nothing in the scope has a value', () => {
    const t = aggregate([input('a', numeric([1, null]), 2, [1]), input('b', null, 2)]);
    expect(t.kind).toBe('none');
    expect(t.withValue).toBe(0);
    expect(t.verdict.ok).toBe(false);
  });

  it('counts text and its distinct values across models', () => {
    const t = aggregate([input('a', discrete(['A', 'B', null, 'A']), 4), input('b', discrete(['B', 'C']), 2)]);
    expect(t.kind).toBe('discrete');
    expect(t.withValue).toBe(5);
    expect(t.distinct).toBe(3);
    expect(t.numbers).toEqual([]);
    expect(t.verdict).toMatchObject({ ok: false, reason: 'not-numeric' });
  });

  it('calls a parameter mixed when one model has numbers and another text', () => {
    const t = aggregate([input('a', numeric([1, 2]), 2), input('b', discrete(['x']), 1)]);
    expect(t.kind).toBe('mixed');
    expect(t.withValue).toBe(3);
    expect(t.distinct).toBe(3);
    expect(t.verdict).toMatchObject({ ok: false, reason: 'mixed-kinds' });
  });
});

describe('aggregate: grouped by a second parameter', () => {
  const byClass = discrete(['IfcBeam', 'IfcBeam', 'IfcColumn', null]);

  it('splits each unit total into one line per group, with no value last', () => {
    const t = aggregate([input('a', numeric([1, 2, 5, 7]), 4, undefined, byClass)]);
    const lines = t.numbers[0].groups!;
    expect(lines.map((l) => [l.label, l.stats.count, l.stats.sum])).toEqual([
      ['IfcBeam', 2, 3],
      ['IfcColumn', 1, 5],
      ['(no value)', 1, 7],
    ]);
  });

  it('merges groups with the same value across models', () => {
    const t = aggregate([
      input('a', numeric([1, 2]), 2, undefined, discrete(['IfcBeam', 'IfcSlab'])),
      input('b', numeric([10]), 1, undefined, discrete(['IfcBeam'])),
    ]);
    const lines = t.numbers[0].groups!;
    expect(lines.find((l) => l.label === 'IfcBeam')!.stats.sum).toBe(11);
  });

  it('puts every element of a model without the group-by parameter in no value', () => {
    const t = aggregate([input('a', numeric([1, 2]), 2, undefined, null)]);
    expect(t.numbers[0].groups!.map((l) => [l.label, l.stats.sum])).toEqual([['(no value)', 3]]);
  });

  it('groups by a number, with its unit', () => {
    const t = aggregate([input('a', numeric([1, 2, 3]), 3, undefined, numeric([200, 200, 300], [{ key: 'si:mm', symbol: 'mm' }]))]);
    expect(t.numbers[0].groups!.map((l) => l.label)).toEqual(['200 mm', '300 mm']);
  });

  it('counts text and distinct values per group', () => {
    const t = aggregate([input('a', discrete(['A', 'B', 'A', 'C']), 4, undefined, byClass)]);
    expect(t.groups!.map((l) => [l.label, l.stats.count, l.distinct])).toEqual([
      ['IfcBeam', 2, 2],
      ['IfcColumn', 1, 1],
      ['(no value)', 1, 1],
    ]);
  });

  it('keeps groups apart per unit', () => {
    const t = aggregate([input('a', numeric([1, 2, 3], [M3, FT3], [0, 1, 0]), 3, undefined, discrete(['X', 'X', 'Y']))]);
    const m3 = t.numbers.find((u) => u.unit.symbol === 'm³')!;
    const ft3 = t.numbers.find((u) => u.unit.symbol === 'ft³')!;
    expect(m3.groups!.map((l) => [l.label, l.stats.sum])).toEqual([
      ['X', 1],
      ['Y', 3],
    ]);
    expect(ft3.groups!.map((l) => [l.label, l.stats.sum])).toEqual([['X', 2]]);
  });
});

describe('lineElements: what clicking a line selects', () => {
  it('selects the elements of one group that have a value, across models', () => {
    const inputs = [
      input('a', numeric([1, null, 5]), 3, undefined, discrete(['IfcBeam', 'IfcBeam', 'IfcSlab'])),
      input('b', numeric([2]), 1, undefined, discrete(['IfcBeam'])),
    ];
    const t = aggregate(inputs);
    const beam = t.numbers[0].groups!.find((l) => l.label === 'IfcBeam')!;
    expect(lineElements(inputs, { unitKey: t.numbers[0].key, groupKey: beam.key })).toEqual([
      { modelId: 'a', expressId: 100 },
      { modelId: 'b', expressId: 100 },
    ]);
  });

  it('selects only the values in one unit', () => {
    const inputs = [input('a', numeric([1, 2, 3], [M3, FT3], [0, 1, 0]), 3)];
    const t = aggregate(inputs);
    const ft3 = t.numbers.find((u) => u.unit.symbol === 'ft³')!;
    expect(lineElements(inputs, { unitKey: ft3.key })).toEqual([{ modelId: 'a', expressId: 101 }]);
  });

  it('keeps to the rows in scope', () => {
    expect(lineElements([input('a', numeric([1, 2, 3]), 3, [0, 2])], {}).map((e) => e.expressId)).toEqual([100, 102]);
  });
});

const line = (label: string, count: number, sum: number, key = `v:${label}`): GroupLine => ({
  key,
  label,
  stats: { count, sum, min: sum / count, max: sum / count },
});

describe('ordering and charts', () => {
  const lines = [line('B', 1, 10), line('A', 3, 30), line('(no value)', 9, 99, 'none'), line('C', 2, 20)];

  it('sorts by any statistic, with no value always last', () => {
    expect(sortLines(lines, 'sum', true).map((l) => l.label)).toEqual(['A', 'C', 'B', '(no value)']);
    expect(sortLines(lines, 'count', false).map((l) => l.label)).toEqual(['B', 'C', 'A', '(no value)']);
    expect(sortLines(lines, 'label', false).map((l) => l.label)).toEqual(['A', 'B', 'C', '(no value)']);
  });

  it('draws bars against the largest, and none when a value is negative', () => {
    expect(barFractions([line('a', 1, 5), line('b', 1, 10)], 'sum')).toEqual([0.5, 1]);
    expect(barFractions([line('a', 1, -5), line('b', 1, 10)], 'sum')).toBeNull();
  });

  it('shares the whole among the largest groups, the rest as other', () => {
    const many = Array.from({ length: 10 }, (_, i) => line(`g${i}`, 1, i + 1));
    const slices = pieSlices(many, 'sum', 3)!;
    expect(slices.map((s) => s.label)).toEqual(['g9', 'g8', 'g7', 'Other (7)']);
    expect(slices.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1);
    expect(slices[3].colour).toBe(-1);
  });

  it('has no share chart when a sum is negative or the whole is zero', () => {
    expect(pieSlices([line('a', 1, -1), line('b', 1, 3)], 'sum')).toBeNull();
    expect(pieSlices([line('a', 1, 0)], 'sum')).toBeNull();
  });

  it('writes tab-separated text with full-precision numbers', () => {
    expect(toTsv([['Group', 'Sum'], ['a\tb', 1 / 3], ['c', NaN]])).toBe(`Group\tSum\na b\t${1 / 3}\nc\t`);
  });
});
