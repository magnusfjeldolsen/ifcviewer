import { describe, it, expect } from 'vitest';
import {
  buildColourPlan,
  entryElements,
  rangeEdges,
  rangeOf,
  rowsInScope,
  tickedColours,
  type PlanModelInput,
} from '../src/inspector/colourByPlan';
import type { ParameterColumn } from '../src/inspector/parameterColumn';
import type { ParameterValue } from '../src/inspector/types';
import type { UnitRef } from '../src/inspector/units';
import { DEFAULT_GRADIENT, categoryColour, rgbToHex, NO_VALUE_COLOUR, NO_VALUE_OPACITY, hexToRgb, sampleGradient, toLinear } from '../src/viewer/colourPalettes';

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
    expect(plan.entries[0].label).toBe('0 to <98 mm');
    expect(plan.entries[5].label).toBe('492 to 590 mm');
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

describe('colour by parameter — range edges', () => {
  it('a value on an edge goes to the range above it; the last range includes the highest', () => {
    // 1 to 2.2 in six ranges of 0.2: float noise once put 1.2 and 1.4 below their edge.
    const edges = rangeEdges(1, 2.2, 6);
    expect(edges).toEqual([1, 1.2, 1.4, 1.6, 1.8, 2, 2.2]);
    expect([1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 1.19, 1.21].map((v) => rangeOf(v, edges))).toEqual([0, 1, 2, 3, 4, 5, 5, 0, 1]);
  });

  it('the legend says which end of a range is included', () => {
    const values = [1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 1.05, 1.1, 1.15, 1.25, 1.3, 1.35, 1.45];
    const plan = buildColourPlan('k', [whole(numeric('a', values))], opts);
    expect(plan.mode).toBe('gradient');
    expect(plan.entries.map((e) => [e.label, e.count])).toEqual([
      ['1 to <1.2 mm', 4],
      ['1.2 to <1.4 mm', 4],
      ['1.4 to <1.6 mm', 2],
      ['1.6 to <1.8 mm', 1],
      ['1.8 to <2 mm', 1],
      ['2 to 2.2 mm', 2],
    ]);
  });

  it('ranges no element falls in are left out', () => {
    const values = [...Array.from({ length: 20 }, (_, i) => i * 0.1), 100];
    const plan = buildColourPlan('k', [whole(numeric('a', values))], opts);
    expect(plan.entries.map((e) => e.label)).toEqual(['0 to <17 mm', '83 to 100 mm']);
    // The scale still runs from the lowest to the highest value.
    expect(plan.range).toMatchObject({ min: 0, max: 100 });
    // Elements point at the entries that are shown.
    expect(plan.models[0].entry[20]).toBe(1);
  });
});

describe('colour by parameter — values that show the same', () => {
  it('numbers that show as the same text are one value', () => {
    const plan = buildColourPlan('k', [whole(numeric('a', [3000, 3000.0000001, 2999.99999999, 1500]))], opts);
    expect(plan.entries.map((e) => [e.label, e.count])).toEqual([
      ['1500 mm', 1],
      ['3000 mm', 3],
    ]);
  });

  it('near-equal values do not push a few values over the step limit', () => {
    const values = Array.from({ length: 40 }, (_, i) => 100 * (1 + (i % 4)) + 1e-9 * i);
    const plan = buildColourPlan('k', [whole(numeric('a', values))], opts);
    expect(plan.mode).toBe('steps');
    expect(plan.entries).toHaveLength(4);
  });

  it('in mixed units too, values are grouped by what is shown', () => {
    const plan = buildColourPlan('k', [whole(numeric('a', [3, 3.0000000001, 3], [MM, M], [0, 0, 1]))], opts);
    expect(plan.entries.map((e) => [e.label, e.count])).toEqual([
      ['3 mm', 2],
      ['3 m', 1],
    ]);
  });

  it('text "3" and the number 3 stay apart', () => {
    const plan = buildColourPlan('k', [whole(discrete('a', [0, 1], ['3', 3]))], opts);
    expect(plan.entries).toHaveLength(2);
  });

  it('entries with the same count and label keep a fixed order', () => {
    const a = buildColourPlan('k', [whole(discrete('a', [0, 1], ['3', 3]))], opts);
    const b = buildColourPlan('k', [whole(discrete('a', [0, 1], ['3', 3]))], opts);
    expect(a.entries.map((e) => e.color)).toEqual(b.entries.map((e) => e.color));
  });

  it('infinite numbers count as no value', () => {
    const plan = buildColourPlan('k', [whole(numeric('a', [1, 2, Infinity, -Infinity, NaN]))], opts);
    expect(plan.mode).toBe('steps');
    expect(plan.entries.map((e) => [e.label, e.count])).toEqual([
      ['1 mm', 1],
      ['2 mm', 1],
      ['No value', 3],
    ]);
    const big = Array.from({ length: 30 }, (_, i) => i);
    const g = buildColourPlan('k', [whole(numeric('a', [...big, Infinity]))], opts);
    expect(g.range).toMatchObject({ min: 0, max: 29 });
    expect(Number.isFinite(g.models[0].rgba[0])).toBe(true);
  });
});
describe('colour by parameter — values outside the scope', () => {
  it('a value only elements outside the scope have is not listed', () => {
    const column = discrete('a', [0, 1, 2], ['x', 'y', 'z']);
    const plan = buildColourPlan('k', [{ column, rows: Int32Array.from([0, 1]) }], opts);
    expect(plan.entries.map((e) => e.label)).toEqual(['x', 'y']);
  });
});

describe('colours for many values', () => {
  it('hundreds of distinct colours, none of them the selection blue', () => {
    const hex = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const c = categoryColour(i);
      hex.add(rgbToHex(c));
      const selectionLike = nearSelectionBlue(c);
      expect(selectionLike, `colour ${i} ${rgbToHex(c)}`).toBe(false);
    }
    expect(hex.size).toBe(300);
  });

  it('neighbours in the list differ visibly', () => {
    for (let i = 12; i < 200; i++) {
      const a = categoryColour(i);
      const b = categoryColour(i + 1);
      const d = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
      expect(d, `colours ${i} and ${i + 1}`).toBeGreaterThan(0.25);
    }
  });
});
/** A saturated, mid-light blue like the selection colour (#3b82f6, hue 217°). */
function nearSelectionBlue(c: { r: number; g: number; b: number }): boolean {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === c.r ? ((c.g - c.b) / d) % 6 : max === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  h = (h * 60 + 360) % 360;
  return h >= 200 && h <= 235 && s > 0.5 && l > 0.3 && l < 0.7;
}