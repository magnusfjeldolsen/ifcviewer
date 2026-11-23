/**
 * Colour by parameter (#68): from value columns to a legend and a colour for
 * every element. Pure and DOM-free.
 *
 * Given one parameter's value column for each model in the scope, decide
 * how to colour it and produce:
 *
 *  - the **legend**: a short list of entries (a value, a range of values,
 *    "other values", or "no value"), each with its colour and how many
 *    elements it covers;
 *  - per model, the elements in scope as a typed array, which legend entry
 *    each is in, and the linear RGB to paint it — what the renderer takes in
 *    one call (`ModelManager.setDataColors`).
 *
 * How it colours:
 *
 *  - **gradient**: numbers in one unit with more than `maxSteps` distinct
 *    values. Each element's colour is its place between the lowest and
 *    highest value; the legend splits that range into `gradientBins` equal
 *    ranges, so a range can be ticked off. A range runs from its lower
 *    edge up to, not including, its upper edge ("1.2 to <1.4 mm"); the
 *    last includes the highest value. Ranges no element is in are left out.
 *  - **steps**: numbers in one unit with few distinct values. One entry per
 *    value, lowest first, spread evenly along the scale so neighbours differ.
 *  - **categories**: text, yes/no, enumerations, and numbers in more than one
 *    unit (which do not belong on one scale: 3 mm is not near 3 m). The most
 *    common `maxCategories` values get a distinct colour each; the rest share
 *    one "other values" entry, so the legend never grows past a screenful.
 *
 * Numbers are compared as the legend shows them (six significant figures),
 * so 3000 and 3000.0000001 are one value, not two entries both reading
 * "3000 mm". Infinite numbers count as no value.
 *
 * Units are compared by key (see `units.ts`). A unit the model does not
 * state is only known to match within that model, so across models it
 * counts as a different unit.
 */

import { formatNumber } from './format';
import type { ParameterColumn } from './parameterColumn';
import { shownNumber } from './parameterFold';
import { isNotStated, type UnitRef } from './units';
import type { ParameterValue } from './types';
import {
  CATEGORY_COLOURS,
  categoryColour,
  NO_VALUE_COLOUR,
  NO_VALUE_OPACITY,
  OTHER_COLOUR,
  GRADIENT_LUT_SIZE,
  gradientLut,
  hexToRgb,
  sampleGradient,
  toLinear,
  type GradientPalette,
  type Rgb,
} from '../viewer/colourPalettes';

export type ColourMode = 'gradient' | 'steps' | 'categories';

export interface LegendEntry {
  /** As the legend shows it, with the unit: "3.2 – 4.1 m", "EI 60", "No value". */
  label: string;
  /** sRGB, for the swatch. */
  color: Rgb;
  /** Elements in the scope this entry covers. */
  count: number;
  kind: 'value' | 'range' | 'other' | 'none';
}

/** What to paint in one model. Row i of each array is one element. */
export interface ModelPaint {
  modelId: string;
  ids: Int32Array;
  /** Index into `ColourPlan.entries`. */
  entry: Uint32Array;
  /** Linear RGBA, four per element (alpha below 1 would ghost it; see NO_VALUE_OPACITY). */
  rgba: Float32Array;
}

export interface ColourPlan {
  key: string;
  mode: ColourMode;
  entries: LegendEntry[];
  models: ModelPaint[];
  /** Elements in the scope, with or without a value. */
  scopeSize: number;
  /** For a gradient: the lowest and highest value, and their unit symbol. */
  range?: { min: number; max: number; unit: string };
  /** What the legend should say about how it coloured, when it is not obvious. */
  note?: string;
}

export interface PlanModelInput {
  column: ParameterColumn;
  /** The column's rows in the scope; null for every row (the whole model). */
  rows: Int32Array | null;
}

export interface PlanOptions {
  palette: GradientPalette;
  /** Numbers with at most this many distinct values are coloured value by value. */
  maxSteps?: number;
  /** Distinct values that get a colour of their own; the rest share one. */
  maxCategories?: number;
  /** Ranges a gradient's legend is split into. */
  gradientBins?: number;
}

export const DEFAULT_MAX_STEPS = 12;
export const DEFAULT_GRADIENT_BINS = 6;
/** One per palette colour. */
export const DEFAULT_MAX_CATEGORIES = CATEGORY_COLOURS.length;

/** The rows of `ids` whose element is in `wanted`, in row order. */
export function rowsInScope(ids: Int32Array, wanted: ReadonlySet<number>): Int32Array {
  const rows = new Int32Array(Math.min(ids.length, wanted.size));
  let n = 0;
  for (let i = 0; i < ids.length && n < rows.length; i++) if (wanted.has(ids[i])) rows[n++] = i;
  return n === rows.length ? rows : rows.slice(0, n);
}

/** A value as the legend shows it (the unit is added by the caller). */
export function legendValueText(v: ParameterValue): string {
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v === '' ? '(empty)' : v;
}

/** " mm", or "" for no unit. */
function unitSuffix(symbol: string): string {
  return symbol ? ` ${symbol}` : '';
}

const NO_VALUE: Rgb = hexToRgb(NO_VALUE_COLOUR);
const OTHER: Rgb = hexToRgb(OTHER_COLOUR);

/** Visit every row of an input in the scope. */
function forEachRow(input: PlanModelInput, visit: (row: number, i: number) => void): void {
  const { rows } = input;
  if (rows) for (let i = 0; i < rows.length; i++) visit(rows[i], i);
  else for (let i = 0; i < input.column.ids.length; i++) visit(i, i);
}

function scopeCount(input: PlanModelInput): number {
  return input.rows ? input.rows.length : input.column.ids.length;
}

/** The unit key of a numeric row, made model-specific when the unit is not stated. */
function globalUnitKey(modelId: string, unit: UnitRef): string {
  return isNotStated(unit.key) ? `${modelId}\u0000${unit.key}` : unit.key;
}

/** A number that can be coloured: not NaN (no value) and not infinite. */
function hasNumber(v: number): boolean {
  return Number.isFinite(v);
}

/** Decide how to colour `inputs` and what every element gets. */
export function buildColourPlan(key: string, inputs: readonly PlanModelInput[], options: PlanOptions): ColourPlan {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxCategories = options.maxCategories ?? DEFAULT_MAX_CATEGORIES;
  const bins = options.gradientBins ?? DEFAULT_GRADIENT_BINS;

  // Numbers only, and in which units? A discrete column with no value in the
  // scope says nothing either way (the parameter is missing in that model).
  let numeric = true;
  const units = new Map<string, string>(); // global key → symbol
  for (const input of inputs) {
    const c = input.column;
    if (c.type === 'discrete') {
      let any = false;
      forEachRow(input, (row) => {
        if (c.codes[row] >= 0) any = true;
      });
      if (any) numeric = false;
      continue;
    }
    forEachRow(input, (row) => {
      if (!hasNumber(c.values[row])) return;
      const u = c.units[c.unitIndex ? c.unitIndex[row] : 0];
      const k = globalUnitKey(c.modelId, u);
      if (!units.has(k)) units.set(k, u.symbol);
    });
  }

  if (numeric && units.size === 1) {
    const unit = [...units.values()][0];
    // Distinct values as shown, up to one past the step limit.
    const distinct = new Set<number>();
    let min = Infinity;
    let max = -Infinity;
    for (const input of inputs) {
      const c = input.column;
      if (c.type !== 'numeric') continue;
      forEachRow(input, (row) => {
        const v = c.values[row];
        if (!hasNumber(v)) return;
        const s = shownNumber(v);
        if (distinct.size <= maxSteps) distinct.add(s);
        if (s < min) min = s;
        if (s > max) max = s;
      });
    }
    return distinct.size <= maxSteps
      ? stepsPlan(key, inputs, [...distinct].sort((a, b) => a - b), unit, options.palette)
      : gradientPlan(key, inputs, min, max, unit, bins, options.palette);
  }

  const plan = categoriesPlan(key, inputs, maxCategories, units);
  if (numeric && units.size > 1) {
    const symbols = [...new Set(units.values())].map((s) => s || 'no unit');
    plan.note =
      `The values are in ${units.size} different units (${symbols.join(', ')}), ` +
      'so each value is coloured on its own, not on one scale.';
  }
  return plan;
}

/** Allocate the per-model output arrays. */
function paintsFor(inputs: readonly PlanModelInput[]): ModelPaint[] {
  return inputs.map((input) => {
    const n = scopeCount(input);
    const ids = new Int32Array(n);
    const { rows, column } = input;
    if (rows) for (let i = 0; i < n; i++) ids[i] = column.ids[rows[i]];
    else ids.set(column.ids);
    return { modelId: column.modelId, ids, entry: new Uint32Array(n), rgba: new Float32Array(n * 4) };
  });
}

function paint(p: ModelPaint, i: number, entry: number, c: Rgb, alpha = 1): void {
  p.entry[i] = entry;
  p.rgba[i * 4] = c.r;
  p.rgba[i * 4 + 1] = c.g;
  p.rgba[i * 4 + 2] = c.b;
  p.rgba[i * 4 + 3] = alpha;
}

/** Append the "no value" entry when some element lacks one, and paint those. */
function finishNoValue(
  entries: LegendEntry[],
  paints: ModelPaint[],
  hasValue: (m: number, i: number) => boolean,
): void {
  let count = 0;
  for (let m = 0; m < paints.length; m++) {
    for (let i = 0; i < paints[m].ids.length; i++) if (!hasValue(m, i)) count++;
  }
  if (count === 0) return;
  const index = entries.length;
  entries.push({ label: 'No value', color: NO_VALUE, count, kind: 'none' });
  const linear = toLinear(NO_VALUE);
  for (let m = 0; m < paints.length; m++) {
    for (let i = 0; i < paints[m].ids.length; i++) if (!hasValue(m, i)) paint(paints[m], i, index, linear, NO_VALUE_OPACITY);
  }
}

function stepsPlan(
  key: string,
  inputs: readonly PlanModelInput[],
  values: number[],
  unit: string,
  palette: GradientPalette,
): ColourPlan {
  const n = values.length;
  const entries: LegendEntry[] = values.map((v, k) => ({
    label: `${formatNumber(v)}${unitSuffix(unit)}`,
    color: sampleGradient(palette, n === 1 ? 1 : k / (n - 1)),
    count: 0,
    kind: 'value',
  }));
  const linear = entries.map((e) => toLinear(e.color));
  const indexOf = new Map(values.map((v, k) => [v, k]));
  const paints = paintsFor(inputs);
  const valued = paints.map((p) => new Uint8Array(p.ids.length));
  inputs.forEach((input, m) => {
    const c = input.column;
    if (c.type !== 'numeric') return;
    forEachRow(input, (row, i) => {
      const v = c.values[row];
      if (!hasNumber(v)) return;
      const k = indexOf.get(shownNumber(v))!;
      entries[k].count++;
      paint(paints[m], i, k, linear[k]);
      valued[m][i] = 1;
    });
  });
  finishNoValue(entries, paints, (m, i) => valued[m][i] === 1);
  return { key, mode: 'steps', entries, models: paints, scopeSize: total(paints) };
}

/**
 * The edges of `bins` equal ranges from `min` to `max`. The inner edges are
 * rounded to two significant figures of a range's width, and those rounded
 * numbers are the edges: what the legend says is what decides the range.
 */
export function rangeEdges(min: number, max: number, bins: number): number[] {
  const width = (max - min) / bins;
  const decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(width)) + 1));
  const edges = [min];
  for (let b = 1; b < bins; b++) edges.push(Number((min + width * b).toFixed(decimals)));
  edges.push(max);
  return edges;
}

/**
 * Which range a value is in: from its lower edge up to, not including, its
 * upper edge; the last range includes the highest value.
 */
export function rangeOf(v: number, edges: readonly number[]): number {
  let b = edges.length - 2;
  while (b > 0 && v < edges[b]) b--;
  return b;
}

function gradientPlan(
  key: string,
  inputs: readonly PlanModelInput[],
  min: number,
  max: number,
  unit: string,
  bins: number,
  palette: GradientPalette,
): ColourPlan {
  const span = max - min;
  const edges = rangeEdges(min, max, bins);
  const lut = gradientLut(palette);
  const last = GRADIENT_LUT_SIZE - 1;
  const paints = paintsFor(inputs);
  const valued = paints.map((p) => new Uint8Array(p.ids.length));
  // First pass: each element's range and colour; ranges are counted.
  const counts = new Array<number>(bins).fill(0);
  inputs.forEach((input, m) => {
    const c = input.column;
    if (c.type !== 'numeric') return;
    const p = paints[m];
    forEachRow(input, (row, i) => {
      const v = c.values[row];
      if (!hasNumber(v)) return;
      const s = shownNumber(v);
      const b = rangeOf(s, edges);
      counts[b]++;
      p.entry[i] = b;
      const l = Math.round(((s - min) / span) * last) * 3;
      p.rgba[i * 4] = lut[l];
      p.rgba[i * 4 + 1] = lut[l + 1];
      p.rgba[i * 4 + 2] = lut[l + 2];
      p.rgba[i * 4 + 3] = 1;
      valued[m][i] = 1;
    });
  });
  // Ranges no element falls in are left out of the legend; the scale bar
  // still runs from the lowest value to the highest.
  const entryOf = new Array<number>(bins).fill(-1);
  const entries: LegendEntry[] = [];
  for (let b = 0; b < bins; b++) {
    if (counts[b] === 0) continue;
    entryOf[b] = entries.length;
    const lo = formatNumber(edges[b]);
    const hi = formatNumber(edges[b + 1]);
    entries.push({
      label: b === bins - 1 ? `${lo} to ${hi}${unitSuffix(unit)}` : `${lo} to <${hi}${unitSuffix(unit)}`,
      color: sampleGradient(palette, (b + 0.5) / bins),
      count: counts[b],
      kind: 'range',
    });
  }
  paints.forEach((p, m) => {
    for (let i = 0; i < p.entry.length; i++) if (valued[m][i]) p.entry[i] = entryOf[p.entry[i]];
  });
  finishNoValue(entries, paints, (m, i) => valued[m][i] === 1);
  return { key, mode: 'gradient', entries, models: paints, scopeSize: total(paints), range: { min, max, unit } };
}

function categoriesPlan(
  key: string,
  inputs: readonly PlanModelInput[],
  maxCategories: number,
  units: Map<string, string>,
): ColourPlan {
  // Every distinct value as shown (with its unit, for numbers) gets a
  // category index; each row is first given that, then mapped to a legend
  // entry. Text "3" and the number 3 stay apart: a model that wrote text
  // where another wrote a number may not mean the same thing.
  const categoryOf = new Map<string, number>();
  const labels: string[] = [];
  const counts: number[] = [];
  const category = (id: string, label: string): number => {
    let c = categoryOf.get(id);
    if (c === undefined) {
      c = labels.length;
      categoryOf.set(id, c);
      labels.push(label);
      counts.push(0);
    }
    return c;
  };
  const showUnits = units.size > 0;
  const perRow = inputs.map((input) => {
    const out = new Int32Array(scopeCount(input)).fill(-1);
    const c = input.column;
    if (c.type === 'discrete') {
      const local = c.dictionary.map((v) =>
        typeof v === 'number'
          ? Number.isFinite(v)
            ? category(`number:${formatNumber(shownNumber(v))}\u0000`, formatNumber(shownNumber(v)))
            : -1
          : category(`${typeof v}:${String(v)}`, legendValueText(v)),
      );
      forEachRow(input, (row, i) => {
        const code = c.codes[row];
        if (code < 0 || local[code] < 0) return;
        out[i] = local[code];
        counts[local[code]]++;
      });
    } else {
      forEachRow(input, (row, i) => {
        const v = c.values[row];
        if (!hasNumber(v)) return;
        const u = c.units[c.unitIndex ? c.unitIndex[row] : 0];
        const unitKey = globalUnitKey(c.modelId, u);
        const text = formatNumber(shownNumber(v));
        const k = category(`number:${text}\u0000${unitKey}`, `${text}${showUnits ? unitSuffix(u.symbol) : ''}`);
        out[i] = k;
        counts[k]++;
      });
    }
    return out;
  });

  // Most common first; then by label; then by first appearance, so the
  // order is the same every time.
  const order = labels
    .map((_, i) => i)
    // A dictionary value no element in the scope has is not a value here.
    .filter((i) => counts[i] > 0)
    .sort((a, b) => counts[b] - counts[a] || (labels[a] < labels[b] ? -1 : labels[a] > labels[b] ? 1 : a - b));
  const coloured = order.length > maxCategories ? order.slice(0, maxCategories) : order;
  const entryOf = new Int32Array(labels.length).fill(-1);
  const entries: LegendEntry[] = coloured.map((cat, i) => {
    entryOf[cat] = i;
    return { label: labels[cat], color: categoryColour(i), count: counts[cat], kind: 'value' };
  });
  let note: string | undefined;
  if (order.length > coloured.length) {
    const rest = order.length - coloured.length;
    let restCount = 0;
    for (const cat of order.slice(coloured.length)) {
      entryOf[cat] = entries.length;
      restCount += counts[cat];
    }
    entries.push({
      label: `${rest.toLocaleString('en-US')} other value${rest === 1 ? '' : 's'}`,
      color: OTHER,
      count: restCount,
      kind: 'other',
    });
    note = `${order.length.toLocaleString('en-US')} values: the ${coloured.length} most common have a colour each, the rest share one.`;
  }
  const linear = entries.map((e) => toLinear(e.color));
  const paints = paintsFor(inputs);
  paints.forEach((p, m) => {
    const cats = perRow[m];
    for (let i = 0; i < cats.length; i++) {
      if (cats[i] < 0) continue;
      const e = entryOf[cats[i]];
      paint(p, i, e, linear[e]);
    }
  });
  finishNoValue(entries, paints, (m, i) => perRow[m][i] >= 0);
  return { key, mode: 'categories', entries, models: paints, scopeSize: total(paints), ...(note ? { note } : {}) };
}

function total(paints: ModelPaint[]): number {
  let n = 0;
  for (const p of paints) n += p.ids.length;
  return n;
}

/**
 * The colours to draw with some entries ticked off: `rgba` where an
 * element's entry is ticked, NaN (its own colour) where not. Written into
 * `out`, which must be as long as `paint.rgba`, so nothing is allocated.
 */
export function tickedColours(paint: ModelPaint, ticked: readonly boolean[], out: Float32Array): Float32Array {
  const { entry, rgba } = paint;
  for (let i = 0; i < entry.length; i++) {
    const o = i * 4;
    if (ticked[entry[i]]) {
      out[o] = rgba[o];
      out[o + 1] = rgba[o + 1];
      out[o + 2] = rgba[o + 2];
      out[o + 3] = rgba[o + 3];
    } else {
      out[o] = NaN;
    }
  }
  return out;
}

/** The elements of one legend entry, per model. */
export function entryElements(plan: ColourPlan, entry: number): { modelId: string; expressId: number }[] {
  const out: { modelId: string; expressId: number }[] = [];
  for (const p of plan.models) {
    for (let i = 0; i < p.entry.length; i++) if (p.entry[i] === entry) out.push({ modelId: p.modelId, expressId: p.ids[i] });
  }
  return out;
}
