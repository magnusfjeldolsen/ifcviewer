/**
 * `geometryProductIds` must name exactly the elements `StreamAllMeshes`
 * streams — it replaced a counting pass and is what the stream now walks.
 * Checked against real IFC2X3 files when they are present, and always against
 * synthetic IFC4 and IFC4X3 files covering the product types easy to get
 * wrong. A fake index can only check the filtering.
 */

// @ts-expect-error -- node:fs has no bundled types here
import { promises as fs, existsSync } from 'node:fs';
// @ts-expect-error -- node:path has no bundled types here
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IfcAPI, LogLevel, IFCSPACE, IFCOPENINGELEMENT, IFCOPENINGSTANDARDCASE, IFCWALL, IFCANNOTATION } from 'web-ifc';
import type * as WebIFC from 'web-ifc';
import { geometryProductIds, type ProductIndex } from '../src/parser/geometryProducts';
import { syntheticIfc, IFC4_PRODUCTS, IFC4X3_PRODUCTS, type SyntheticProduct } from './fixtures/syntheticIfc';

function vec(ids: number[]): WebIFC.Vector<number> {
  return { get: (i: number) => ids[i], size: () => ids.length, [Symbol.iterator]: () => ids[Symbol.iterator]() };
}

describe('geometryProductIds (fake index)', () => {
  it('lists the elements of every element type but openings and spaces, ascending', () => {
    const NOT_AN_ELEMENT = 42;
    const byType = new Map<number, number[]>([
      [IFCWALL, [9, 3]],
      [IFCANNOTATION, [7]],
      [IFCOPENINGELEMENT, [5]],
      [IFCOPENINGSTANDARDCASE, [4]],
      [IFCSPACE, [6]],
      [NOT_AN_ELEMENT, [1]],
    ]);
    const index: ProductIndex = {
      GetIfcEntityList: () => [...byType.keys()],
      IsIfcElement: (t) => t !== NOT_AN_ELEMENT,
      GetLineIDsWithType: (_m, type, inherited) => {
        // Exact types only: subtypes are visited as types of their own.
        expect(inherited).toBe(false);
        return vec(byType.get(type) ?? []);
      },
    };
    expect(geometryProductIds(index, 0)).toEqual([3, 7, 9]);
  });
});

/** Both ways of streaming a model, as sorted expressID lists. */
function bothWays(api: IfcAPI, modelID: number): { all: number[]; listed: number[]; viaList: number[] } {
  const all: number[] = [];
  api.StreamAllMeshes(modelID, (m) => {
    all.push(m.expressID);
    (m.geometries as unknown as { delete(): void }).delete();
  });
  const listed = geometryProductIds(api, modelID);
  const viaList: number[] = [];
  api.StreamMeshes(modelID, listed, (m) => {
    viaList.push(m.expressID);
    (m.geometries as unknown as { delete(): void }).delete();
  });
  const sort = (a: number[]) => [...a].sort((x, y) => x - y);
  return { all: sort(all), listed, viaList: sort(viaList) };
}

describe('geometryProductIds against web-ifc', () => {
  let api: IfcAPI;

  beforeAll(async () => {
    api = new IfcAPI();
    await api.Init();
    api.SetLogLevel(LogLevel.LOG_LEVEL_OFF); // samples have a few breps web-ifc complains about
  });

  for (const [schema, products] of [
    ['IFC4', IFC4_PRODUCTS],
    ['IFC4X3_ADD2', IFC4X3_PRODUCTS],
  ] as Array<['IFC4' | 'IFC4X3_ADD2', SyntheticProduct[]]>) {
    describe(`a synthetic ${schema} file`, () => {
      let modelID: number;
      const name = (id: number): string => products[id - 100].entity + (products[id - 100].body === false ? ' (no body)' : '');

      beforeAll(() => {
        modelID = api.OpenModel(new TextEncoder().encode(syntheticIfc(schema, products)));
      });
      afterAll(() => api.CloseModel(modelID));

      it('is read as that schema, every product as its own type', () => {
        expect(api.GetModelSchema(modelID)).toBe(schema);
        products.forEach((p, i) => expect(api.GetLineType(modelID, 100 + i)).toBeGreaterThan(0));
      });

      it('streams exactly the elements StreamAllMeshes streams', () => {
        const { all, viaList } = bothWays(api, modelID);
        expect(viaList.map(name)).toEqual(all.map(name));
      });

      it('keeps what a full stream keeps and leaves out what it leaves out', () => {
        const { all, listed } = bothWays(api, modelID);
        const streamed = all.map(name);
        // The ones easy to get wrong, one way or the other:
        for (const kept of ['IFCANNOTATION', 'IFCVOIDINGFEATURE', 'IFCSPATIALZONE', 'IFCEXTERNALSPATIALELEMENT', 'IFCGEOGRAPHICELEMENT', 'IFCSITE']) {
          expect(streamed).toContain(kept);
        }
        for (const dropped of ['IFCOPENINGELEMENT', 'IFCSPACE']) expect(streamed).not.toContain(dropped);
        if (schema === 'IFC4X3_ADD2') {
          for (const kept of ['IFCALIGNMENT', 'IFCREFERENT', 'IFCCOURSE', 'IFCBRIDGE']) expect(streamed).toContain(kept);
        }
        // Listed but bodiless: counted in the total, streams nothing.
        expect(listed.map(name)).toContain('IFCWALL (no body)');
        expect(streamed).not.toContain('IFCWALL (no body)');
      });
    });
  }

  const root = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
  const FILES = ['assets/ifcs/RIB.ifc', 'assets/ifcs/Snowdon Towers Sample Structural.ifc'].map((f) =>
    path.resolve(root, f),
  );

  for (const file of FILES) {
    describe.skipIf(!existsSync(file))(`${path.basename(file)} (IFC2X3)`, () => {
      let modelID: number;

      beforeAll(async () => {
        modelID = api.OpenModel(new Uint8Array(await fs.readFile(file)));
      });
      afterAll(() => api.CloseModel(modelID));

      it('streams exactly the elements StreamAllMeshes streams, and lists no fewer', () => {
        const { all, listed, viaList } = bothWays(api, modelID);
        expect(api.GetModelSchema(modelID)).toBe('IFC2X3');
        expect(viaList).toEqual(all);
        expect(listed.length).toBeGreaterThanOrEqual(all.length);
      });
    });
  }
});
