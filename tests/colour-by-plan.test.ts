import { describe, it, expect } from 'vitest';
import {
  buildColourPlan,
  entryElements,
  rowsInScope,
  tickedColours,
  type PlanModelInput,
} from '../src/inspector/colourByPlan';
import type { ParameterColumn } from '../src/inspector/parameterColumn';
import type { ParameterValue } from '../src/inspector/types';
import type { UnitRef } from '../src/inspector/units';
import { DEFAULT_GRADIENT, NO_VALUE_COLOUR, NO_VALUE_OPACITY, hexToRgb, sampleGradient, toLinear } from '../src/viewer/colourPalettes';

const MM: UnitRef = { key: 'LENGTHUNIT:MILLI:METRE', symbol: 'mm' };
const M: UnitRef = { key: 'LENGTHUNIT::METRE', symbol: 'm' };

function numeric(modelId: string, values: number[], units: UnitRef[] = [MM], unitIndex?: number[]): ParameterColumn {
  return {
    type: 'numeric',
    key: 'Dimensions.Width',
    count: values.filter((v) => !Number.isNaN(v)).length,
    values: Float64Array.from(values),
    units,
    unitIndex: unitIndex ? Uint16Array.from(unitIndex) : null,
    modelId,
    ids: Int32Array.from(values.map((_, i) => 100 + i)),
  };
}

function discrete(modelId: string, codes: number[], dictionary: ParameterValue[]): ParameterColumn {
  return {
    type: 'discrete',
    key: 'Pset_Common.FireRating',
    count: codes.filter((c) => c >= 0).length,
    codes: Int32Array.from(codes),
    dictionary,
    modelId,
    ids: Int32Array.from(codes.map((_, i) => 100 + i)),
  };
}

const whole = (column: ParameterColumn): PlanModelInput => ({ column, rows: null });
const opts = { palette: DEFAULT_GRADIENT };

describe('colour by parameter — numbers in one unit', () => {
  it('few distinct values: one step per value, lowest red, highest green', () => {
    const plan = buildColourPlan('k', [whole(numeric('a', [200, 100, 300, 100, NaN]))], opts);
    expect(plan.mode).toBe('steps');
    expect(plan.entries.map((e) => [e.label, e.count])).toEqual([
      ['100 mm', 2],
      ['200 mm', 1],
      ['300 mm', 1],
      ['No value', 1],
    ]);
    expect(plan.entries[0].color).toEqual(sampleGradient(DEFAULT_GRADIENT, 0));
    expect(plan.entries[2].color).toEqual(sampleGradient(DEFAULT_GRADIENT, 1));
    const p = plan.models[0];
    expect(Array.from(p.entry)).toEqual([1, 0, 2, 0, 3]);
    // The element without a value is the near-white "no value" colour.
    expect(p.rgba[16]).toBeCloseTo(toLinear(hexToRgb(NO_VALUE_COLOUR)).r);
    expect(p.rgba[19]).toBeCloseTo(NO_VALUE_OPACITY);
    expect(p.rgba[3]).toBe(1);
  });

  it('many distinct values: a continuous gradient, with ranges to tick', () => {
    const values = Array.from({ length: 60 }, (_, i) => i * 10);
    const plan = buildColourPlan('k', [whole(numeric('a', values))], opts);
    expect(plan.mode).toBe('gradient');
    expect(plan.range).toEqual({ min: 0, max: 590, unit: 'mm' });
    expect(plan.entries).toHaveLength(6);
    expect(plan.entries[0].label).toBe('0 – 98 mm');
    expect(plan.entries.reduce((n, e) => n + e.count, 0)).toBe(60);
    const p = plan.models[0];
    // The lowest is the first stop, the highest the last, each element its own shade.
    const low = toLinear(sampleGradient(DEFAULT_GRADIENT, 0));
    const high = toLinear(sampleGradient(DEFAULT_GRADIENT, 1));
    expect(p.rgba[0]).toBeCloseTo(low.r, 5);
    expect(p.rgba[59 * 4 + 1]).toBeCloseTo(high.g, 5);
    expect(p.rgba[4]).not.toBe(p.rgba[8]);
    expect(p.entry[59]).toBe(5);
  });

  it('a single value is one entry, not a scale', () => {
    const plan = buildColourPlan('k', [whole(numeric('a', [5, 5, 5]))], opts);
    expect(plan.mode).toBe('steps');
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].count).toBe(3);
  });
});

describe('colour by parameter — units that differ', () => {
  it('numbers in two units are coloured as separate values, and the legend says why', () => {
    const plan = buildColourPlan('k', [whole(numeric('a', [3, 3, 3, 5], [MM, M], [0, 1, 1, 0]))], opts);
    expect(plan.mode).toBe('categories');
    expect(plan.entries.map((e) => [e.label, e.count])).toEqual([
      ['3 m', 2],
      ['3 mm', 1],
      ['5 mm', 1],
    ]);
    expect(plan.note).toMatch(/2 different units \(mm, m\)/);
  });

  it('an unstated unit in two models is not taken to be the same unit', () => {
    const q: UnitRef = { key: '?LENGTHUNIT', symbol: '' };
    const plan = buildColourPlan('k', [whole(numeric('a', [1, 2], [q])), whole(numeric('b', [1, 2], [q]))], opts);
    expect(plan.mode).toBe('categories');
    expect(plan.entries).toHaveLength(4);
  });

  it('the same stated unit in two models shares one scale', () => {
    const plan = buildColourPlan('k', [whole(numeric('a', [1, 2])), whole(numeric('b', [3]))], opts);
    expect(plan.mode).toBe('steps');
    expect(plan.entries.map((e) => e.label)).toEqual(['1 mm', '2 mm', '3 mm']);
    expect(plan.models.map((p) => p.modelId)).toEqual(['a', 'b']);
  });
});

describe('colour by parameter — text and yes/no', () => {
  it('distinct colours, most common first, with "no value" last', () => {
    const plan = buildColourPlan('k', [whole(discrete('a', [0, 1, 1, -1, 2, 1], ['EI 30', 'EI 60', 'EI 90']))], opts);
    expect(plan.mode).toBe('categories');
    expect(plan.entries.map((e) => [e.label, e.count, e.kind])).toEqual([
      ['EI 60', 3, 'value'],
      ['EI 30', 1, 'value'],
      ['EI 90', 1, 'value'],
      ['No value', 1, 'none'],
    ]);
    const colours = new Set(plan.entries.map((e) => `${e.color.r},${e.color.g},${e.color.b}`));
    expect(colours.size).toBe(4);
  });

  it('caps the legend: past the most common values, the rest share one entry', () => {
    const dictionary = Array.from({ length: 300 }, (_, i) => `Name ${i}`);
    const codes = Array.from({ length: 1000 }, (_, i) => (i < 100 ? 0 : i % 300));
    const plan = buildColourPlan('k', [whole(discrete('a', codes, dictionary))], opts);
    expect(plan.entries).toHaveLength(13);
    expect(plan.entries[0]).toMatchObject({ label: 'Name 0', kind: 'value' });
    expect(plan.entries[12]).toMatchObject({ label: '288 other values', kind: 'other' });
    expect(plan.entries.reduce((n, e) => n + e.count, 0)).toBe(1000);
    expect(plan.note).toMatch(/300 values: the 12 most common/);
  });

  it('a model without the parameter leaves its elements as "no value" on the same legend', () => {
    const plan = buildColourPlan(
      'k',
      [whole(discrete('a', [0, 0], [true])), whole(discrete('b', [-1, -1, -1], []))],
      opts,
    );
    expect(plan.entries.map((e) => [e.label, e.count])).toEqual([
      ['true', 2],
      ['No value', 3],
    ]);
    expect(plan.scopeSize).toBe(5);
  });

  it('numbers and text together are coloured as distinct values', () => {
    const plan = buildColourPlan('k', [whole(discrete('a', [0, 1], [3, 'three'])), whole(numeric('b', [3]))], opts);
    expect(plan.mode).toBe('categories');
    // The text model's 3 and the number model's 3 mm are not merged.
    expect(plan.entries.map((e) => e.label).sort()).toEqual(['3', '3 mm', 'three']);
  });
});

describe('colour by parameter — scope and ticking', () => {
  it('a selection colours only its own elements', () => {
    const column = numeric('a', [1, 2, 3, 4]);
    const rows = rowsInScope(column.ids, new Set([101, 103, 999]));
    expect(Array.from(rows)).toEqual([1, 3]);
    const plan = buildColourPlan('k', [{ column, rows }], opts);
    expect(Array.from(plan.models[0].ids)).toEqual([101, 103]);
    expect(plan.scopeSize).toBe(2);
    expect(plan.entries.map((e) => e.label)).toEqual(['2 mm', '4 mm']);
  });

  it('an unticked entry gives its elements back their own colour (NaN)', () => {
    const plan = buildColourPlan('k', [whole(discrete('a', [0, 1, 0], ['x', 'y']))], opts);
    const out = new Float32Array(plan.models[0].rgba.length);
    tickedColours(plan.models[0], [false, true], out);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(out[4]).toBe(plan.models[0].rgba[4]);
    expect(Number.isNaN(out[8])).toBe(true);
  });

  it('lists the elements of an entry, across models', () => {
    const plan = buildColourPlan('k', [whole(discrete('a', [0, 1], ['x', 'y'])), whole(discrete('b', [0], ['x']))], opts);
    expect(entryElements(plan, 0)).toEqual([
      { modelId: 'a', expressId: 100 },
      { modelId: 'b', expressId: 100 },
    ]);
  });

  it('plans 50,000 elements quickly', () => {
    const values = Array.from({ length: 50000 }, (_, i) => (i % 7 === 0 ? NaN : i * 0.37));
    const t0 = performance.now();
    const plan = buildColourPlan('k', [whole(numeric('a', values))], opts);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(plan.mode).toBe('gradient');
  });
});
