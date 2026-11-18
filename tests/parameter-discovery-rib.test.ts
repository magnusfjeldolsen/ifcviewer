/**
 * Parameter discovery against `assets/ifcs/RIB.ifc`, a real Revit export:
 * what discovery says an element's parameter is must be what the inspector
 * shows for that element.
 *
 * Discovery reads through the cached per-element path (the worker's
 * `ModelPropertyCache`); a first inspector click reads uncached. Both are
 * compared here, and both go through `firstRowPerPath`, so this also holds
 * discovery to the instance-wins rule on paths shared with the type.
 *
 * The fixture is not version-controlled; without it the test is skipped.
 */

// @ts-expect-error -- node:fs has no bundled types here
import { promises as fs, existsSync } from 'node:fs';
// @ts-expect-error -- node:path has no bundled types here
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IfcAPI } from 'web-ifc';
import {
  fetchElementProperties,
  type PropertyApi,
} from '../src/inspector/repository/fetchElementProperties';
import { ModelPropertyCache, type CacheableApi } from '../src/inspector/repository/modelPropertyCache';
import { readModelUnits } from '../src/inspector/repository/unitTable';
import { firstRowPerPath } from '../src/inspector/repository/flatRows';
import { parameterValueOf, type ValueCount } from '../src/inspector/parameterFold';
import { elementMatches } from '../src/inspector/matchValue';
import type { ModelUnits } from '../src/inspector/units';
import type { ModelParameters, ParameterValue } from '../src/inspector/types';
import { createIfcClassNamer } from '../src/parser/ifcClassNames';
import { geometryProductIds } from '../src/parser/geometryProducts';
import { SerialQueue } from '../src/parser/serialQueue';
import { ParameterDiscoveries } from '../src/parser/parameterDiscovery';
import type { FromWorker } from '../src/parser/ifcMessages';

// @ts-expect-error -- `process` is a Node global, no bundled types in this project
const IFC_PATH = path.resolve(process.cwd(), 'assets/ifcs/RIB.ifc');
const MODEL = 'rib-discovery';
const FILE_PRESENT = existsSync(IFC_PATH);

describe.skipIf(!FILE_PRESENT)('parameter discovery on RIB.ifc', () => {
  let api: IfcAPI;
  let modelID: number;
  let unitTable: ModelUnits;
  let className: (code: number) => string;
  /** The elements the viewer draws: those that stream geometry. */
  let scope: number[];
  let discoveries: ParameterDiscoveries;
  const posted: FromWorker[] = [];

  /** The inspector's read of one element: uncached, as a first click is. */
  const inspect = (expressId: number) =>
    fetchElementProperties(api as unknown as PropertyApi, modelID, MODEL, expressId, unitTable, undefined, className);

  /** Discovery over `ids`, through the worker's cached read path. */
  let nextReq = 1;
  async function discover(ids: number[]): Promise<ModelParameters> {
    const reqId = nextReq++;
    discoveries.request(reqId, MODEL, ids);
    for (;;) {
      const r = posted.find((m) => (m.type === 'parameters' || m.type === 'error') && m.reqId === reqId);
      if (r?.type === 'parameters') return r.result;
      if (r?.type === 'error') throw new Error(r.message);
      await new Promise((res) => setTimeout(res, 0));
    }
  }

  beforeAll(async () => {
    api = new IfcAPI();
    await api.Init();
    modelID = api.OpenModel(new Uint8Array(await fs.readFile(IFC_PATH)));
    unitTable = await readModelUnits(api as unknown as Parameters<typeof readModelUnits>[0], modelID);
    className = createIfcClassNamer(api);
    const drawn = new Set<number>();
    api.StreamMeshes(modelID, geometryProductIds(api, modelID), (m) => {
      drawn.add(m.expressID);
    });
    scope = [...drawn];
    const cache = new ModelPropertyCache(api as unknown as CacheableApi, modelID);
    discoveries = new ParameterDiscoveries({
      queue: new SerialQueue(),
      openId: () => modelID,
      read: (_id, webIfcId, expressId) =>
        fetchElementProperties(api as unknown as PropertyApi, webIfcId, MODEL, expressId, unitTable, cache, className),
      post: (msg) => posted.push(msg),
    });
  }, 120_000);

  afterAll(() => {
    if (api && modelID !== undefined) api.CloseModel(modelID);
  });

  /** Every eighth drawn element: a spread of classes without reading the model twice over. */
  const sample = (): number[] => scope.filter((_, i) => i % 8 === 0);

  it('has drawn elements to describe', () => {
    expect(scope.length).toBeGreaterThan(20);
  });

  it('for one element, every discovered value is the value the inspector shows', async () => {
    for (const expressId of sample()) {
      const shown = new Map<string, ParameterValue>();
      for (const [p, row] of firstRowPerPath((await inspect(expressId)).flat)) {
        const v = parameterValueOf(row.rawValue, row.displayValue);
        if (v !== null) shown.set(p, v);
      }
      const found = await discover([expressId]);
      expect(found.parameters.map((p) => p.key)).toEqual([...shown.keys()].sort((a, b) => (a < b ? -1 : 1)));
      for (const p of found.parameters) {
        expect(p.count).toBe(1);
        expect(p.values).toEqual([{ value: shown.get(p.key), count: 1 }]);
      }
    }
  });

  it('over the whole model, each sampled element is counted under every parameter it shows', async () => {
    const all = await discover(scope);
    expect(all.scopeSize).toBe(scope.length);
    const byKey = new Map(all.parameters.map((p) => [p.key, p]));
    for (const expressId of sample()) {
      for (const [p, row] of firstRowPerPath((await inspect(expressId)).flat)) {
        const v = parameterValueOf(row.rawValue, row.displayValue);
        if (v === null) continue;
        const param = byKey.get(p);
        expect(param, p).toBeDefined();
        if (param!.values) expect(param!.values.some((x) => x.value === v), `${p} = ${String(v)}`).toBe(true);
      }
    }
    // Counts are out of the scope, and identity is unique per element.
    for (const p of all.parameters) expect(p.count).toBeLessThanOrEqual(scope.length);
    expect(byKey.get('Identity.GlobalId')).toMatchObject({ count: scope.length, uniquePerElement: true });
  });

  it('the count next to every value is the number of elements picking it selects', async () => {
    const all = await discover(scope);
    // What the worker's findMatching does with the drawn elements as
    // candidates: read each (as a click would) and run the same predicate.
    const elements = await Promise.all(scope.map((id) => inspect(id)));
    let checked = 0;
    for (const p of all.parameters) {
      const values = p.values ?? (await discoverValues(p.key));
      for (const { value, count } of values) {
        const selected = elements.filter((e) =>
          elementMatches(e, { path: p.key }, { kind: 'parameter-value', value }),
        ).length;
        expect(selected, `${p.key} = ${String(value)}`).toBe(count);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('values fetched on demand agree with the description, and sum to its count', async () => {
    const all = await discover(scope);
    for (const p of all.parameters) {
      const fetched = await discoverValues(p.key);
      if (p.values) expect(fetched).toEqual(p.values);
      expect(fetched.reduce((n, v) => n + v.count, 0)).toBe(p.count);
    }
  });

  async function discoverValues(path: string): Promise<ValueCount[]> {
    const reqId = nextReq++;
    discoveries.requestValues(reqId, MODEL, scope, path);
    for (;;) {
      const r = posted.find((m) => (m.type === 'parameterValues' || m.type === 'error') && m.reqId === reqId);
      if (r?.type === 'parameterValues') return r.values;
      if (r?.type === 'error') throw new Error(r.message);
      await new Promise((res) => setTimeout(res, 0));
    }
  }
});
