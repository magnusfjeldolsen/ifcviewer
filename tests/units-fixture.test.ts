/**
 * Units and value kinds through real web-ifc, on a small invented model
 * (`fixtures/unitsIfc.ts`): per-property units, derived units, unstated
 * units, enumerated / list / bounded / table values, quantities with their
 * own unit, and a parameter whose values are in two units.
 *
 * Both read paths are checked: the uncached one an inspector click takes,
 * and the cached one discovery and columns take. On the cached path a
 * property's `Unit` arrives as a bare reference, on the uncached path as the
 * unit line itself — the same unit must come out of both.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IfcAPI } from 'web-ifc';
import { fetchElementProperties, type PropertyApi } from '../src/inspector/repository/fetchElementProperties';
import { ModelPropertyCache, type CacheableApi } from '../src/inspector/repository/modelPropertyCache';
import { readModelUnits } from '../src/inspector/repository/unitTable';
import { firstRowPerPath } from '../src/inspector/repository/flatRows';
import { ParameterFold } from '../src/inspector/parameterFold';
import { canSum, sumVerdictText, type ModelUnits } from '../src/inspector/units';
import { ColumnBuilder, columnIdsWithValue, columnValueCounts, type ParameterColumn } from '../src/inspector/parameterColumn';
import { elementMatches } from '../src/inspector/matchValue';
import { valueQuery } from '../src/inspector/selectSimilar';
import { intersectProperties } from '../src/inspector/intersection';
import type { ElementProperties, PropertyFlatRow } from '../src/inspector/types';
import { NO_UNITS_IFC, UNITS_IFC, WALL_A, WALL_B, WALL_C } from './fixtures/unitsIfc';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('units and value kinds on a fixture model', () => {
  let api: IfcAPI;
  let modelID: number;
  let units: ModelUnits;
  let cache: ModelPropertyCache;

  const read = (expressId: number, cached: boolean): Promise<ElementProperties> =>
    fetchElementProperties(api as unknown as PropertyApi, modelID, 'fx', expressId, units, cached ? cache : undefined);

  const rows = async (expressId: number, cached = true): Promise<Map<string, PropertyFlatRow>> =>
    firstRowPerPath((await read(expressId, cached)).flat);

  beforeAll(async () => {
    api = new IfcAPI();
    await api.Init();
    modelID = api.OpenModel(encode(UNITS_IFC));
    units = await readModelUnits(api as unknown as Parameters<typeof readModelUnits>[0], modelID);
    cache = new ModelPropertyCache(api as unknown as CacheableApi, modelID);
  });

  afterAll(() => api.CloseModel(modelID));

  it('the cached and uncached reads agree on every row, units included', async () => {
    // Otherwise the "cached" read would quietly be the uncached one.
    expect(cache.usable()).toBe(true);
    const line = api.GetLine(modelID, 210, false) as { Unit: unknown };
    expect(line.Unit).toEqual({ type: 5, value: 23 });
    for (const id of [WALL_A, WALL_B, WALL_C]) {
      const strip = (p: ElementProperties) => p.flat.map(({ path, displayValue, unit, unitKey, rawValue }) => ({ path, displayValue, unit, unitKey, rawValue }));
      expect(strip(await read(id, true)), String(id)).toEqual(strip(await read(id, false)));
    }
  });

  it('uses the project unit, with short symbols', async () => {
    const r = await rows(WALL_A);
    expect(r.get('Pset_Fixture.Width')).toMatchObject({ displayValue: '200', unit: 'mm', unitKey: 'si:mm' });
    expect(r.get('Pset_Fixture.Slope')).toMatchObject({ unit: '°' });
    expect(r.get('Qto_Fixture.Length')).toMatchObject({ displayValue: '4500', unit: 'mm', unitKey: 'si:mm' });
    expect(r.get('Qto_Fixture.NetArea')).toMatchObject({ unit: 'm²' });
  });

  it('a unit set on a property or quantity wins over the project unit', async () => {
    const a = await rows(WALL_A);
    expect(a.get('Pset_Fixture.Spacing')).toMatchObject({ unit: 'in' });
    expect(a.get('Qto_Fixture.NetVolume')).toMatchObject({ unit: 'dm³', unitKey: 'si:dm³' });
    expect((await rows(WALL_B)).get('Pset_Fixture.Width')).toMatchObject({ displayValue: '0.3', unit: 'm', unitKey: 'si:m' });
    // The same on the uncached path, where the unit line comes already read.
    expect((await rows(WALL_B, false)).get('Pset_Fixture.Width')).toMatchObject({ unit: 'm', unitKey: 'si:m' });
  });

  it('reads a derived unit from the project', async () => {
    expect((await rows(WALL_A)).get('Pset_Fixture.Load')).toMatchObject({ displayValue: '5', unit: 'kN/m²' });
  });

  it('says a unit is not stated rather than inventing one', async () => {
    const duration = (await rows(WALL_A)).get('Pset_Fixture.Duration')!;
    expect(duration.displayValue).toBe('3');
    expect(duration.unit).toBeUndefined();
    expect(duration.unitKey).toBe('?TIMEUNIT');
  });

  it('gives text no unit', async () => {
    const mark = (await rows(WALL_A)).get('Pset_Fixture.Mark')!;
    expect(mark.unit).toBeUndefined();
    expect(mark.unitKey).toBeUndefined();
  });

  it('shows enumerated, list, bounded and table values', async () => {
    const r = await rows(WALL_A);
    expect(r.get('Pset_Fixture.Status')).toMatchObject({ displayValue: 'NEW', rawValue: { kind: 'enumerated', values: ['NEW'] } });
    expect(r.get('Pset_Fixture.Points')).toMatchObject({ displayValue: '1, 2', unit: 'mm' });
    expect(r.get('Pset_Fixture.Range')).toMatchObject({ displayValue: '1 – 10', unit: 'mm' });
    expect(r.get('Pset_Fixture.Table')).toMatchObject({ displayValue: '1 → 10; 2 → 20' });
  });

  it('discovery flags a parameter whose values are in two units, and refuses to add it up', async () => {
    const fold = new ParameterFold();
    for (const id of [WALL_A, WALL_B, WALL_C]) fold.add(await read(id, true));
    const params = new Map(fold.result('fx', 3).parameters.map((p) => [p.key, p]));

    const width = params.get('Pset_Fixture.Width')!;
    expect(width.unitsDiffer).toBe(true);
    expect(width.units).toEqual([
      { key: 'si:mm', symbol: 'mm', count: 2 },
      { key: 'si:m', symbol: 'm', count: 1 },
    ]);
    const verdict = canSum(width);
    expect(verdict.ok).toBe(false);
    expect(sumVerdictText(verdict)).toBe('Values are in different units (mm on 2, m on 1), so they are not added up');

    const length = params.get('Qto_Fixture.Length')!;
    expect(length.unit).toBe('mm');
    expect(canSum(length)).toEqual({ ok: true, unit: { key: 'si:mm', symbol: 'mm' }, unitStated: true });

    const status = params.get('Pset_Fixture.Status')!;
    expect(status.kind).toBe('text');
    expect(status.values).toEqual([
      { value: 'EXISTING', count: 1 },
      { value: 'NEW', count: 1 },
    ]);

    expect(canSum(params.get('Pset_Fixture.Duration')!)).toMatchObject({ ok: true, unitStated: false });
  });
});

describe('the same number in two units, on a fixture model', () => {
  let api: IfcAPI;
  let modelID: number;
  let elements: ElementProperties[];
  const ids = [WALL_A, WALL_B, WALL_C];

  beforeAll(async () => {
    api = new IfcAPI();
    await api.Init();
    modelID = api.OpenModel(encode(UNITS_IFC));
    const units = await readModelUnits(api as unknown as Parameters<typeof readModelUnits>[0], modelID);
    const cache = new ModelPropertyCache(api as unknown as CacheableApi, modelID);
    elements = [];
    for (const id of ids) elements.push(await fetchElementProperties(api as unknown as PropertyApi, modelID, 'fx', id, units, cache));
  });

  afterAll(() => api.CloseModel(modelID));

  const column = (): ParameterColumn => {
    const b = new ColumnBuilder('Pset_Fixture.Depth', ids.length);
    elements.forEach((e, i) => b.add(i, e));
    return { ...b.finish(), modelId: 'fx', ids: Int32Array.from(ids) };
  };

  it('lists 3 mm and 3 m as two values, each with its unit', () => {
    expect(columnValueCounts(column())).toEqual([
      { value: 3, count: 1, unit: { key: 'si:m', symbol: 'm' } },
      { value: 3, count: 1, unit: { key: 'si:mm', symbol: 'mm' } },
    ]);
  });

  it('picking 3 m selects only the element whose 3 is in metres', () => {
    const c = column();
    expect(columnIdsWithValue(c, 3, 'si:m')).toEqual([WALL_B]);
    expect(columnIdsWithValue(c, 3, 'si:mm')).toEqual([WALL_A]);
    expect(columnIdsWithValue(c, 3, 'si:km')).toEqual([]);
  });

  it('select-similar from 3 mm does not find 3 m', () => {
    const rowA = firstRowPerPath(elements[0].flat).get('Pset_Fixture.Depth')!;
    const query = valueQuery(elements[0].identity, rowA)!;
    if (query.kind !== 'value') throw new Error('expected a value query');
    const matched = elements.filter((e) => elementMatches(e, query.selector, query.value)).map((e) => e.identity.expressId);
    expect(matched).toEqual([WALL_A]);
  });

  it('the inspector says 3 mm and 3 m vary, rather than showing one value', () => {
    const both = intersectProperties([elements[0], elements[1]]);
    const depth = both.flat.find((r) => r.path === 'Pset_Fixture.Depth')!;
    expect(depth.rawValue.kind).toBe('varies');
  });
});

describe('a model that states no units', () => {
  it('reads its lengths as "unit not stated" and its enumerations in full', async () => {
    const api = new IfcAPI();
    await api.Init();
    const modelID = api.OpenModel(encode(NO_UNITS_IFC));
    try {
      const units = await readModelUnits(api as unknown as Parameters<typeof readModelUnits>[0], modelID);
      const props = await fetchElementProperties(api as unknown as PropertyApi, modelID, 'nu', WALL_A, units);
      const r = firstRowPerPath(props.flat);
      expect(r.get('Pset_Fixture.Width')).toMatchObject({ displayValue: '200', unitKey: '?LENGTHUNIT' });
      expect(r.get('Pset_Fixture.Width')!.unit).toBeUndefined();
      expect(r.get('Pset_Fixture.Status')).toMatchObject({ displayValue: 'NEW, TEMPORARY' });
    } finally {
      api.CloseModel(modelID);
    }
  });
});
