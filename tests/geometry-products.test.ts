/**
 * `geometryProductIds` must name exactly the elements `StreamAllMeshes`
 * streams — it replaced a counting pass and is what the stream now walks.
 * Checked against real files: a fake index can only check the filtering.
 */

// @ts-expect-error -- node:fs has no bundled types here
import { promises as fs, existsSync } from 'node:fs';
// @ts-expect-error -- node:path has no bundled types here
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IfcAPI, IFCPRODUCT, IFCSPACE, IFCOPENINGELEMENT, IFCOPENINGSTANDARDCASE } from 'web-ifc';
import type * as WebIFC from 'web-ifc';
import { geometryProductIds, type ProductIndex } from '../src/parser/geometryProducts';

function vec(ids: number[]): WebIFC.Vector<number> {
  return { get: (i: number) => ids[i], size: () => ids.length, [Symbol.iterator]: () => ids[Symbol.iterator]() };
}

describe('geometryProductIds (fake index)', () => {
  it('lists every product but openings and spaces, ascending', () => {
    const byType = new Map<number, number[]>([
      [IFCPRODUCT, [9, 3, 7, 5, 1, 4]],
      [IFCOPENINGELEMENT, [5]],
      [IFCOPENINGSTANDARDCASE, [4]],
      [IFCSPACE, [7]],
    ]);
    const index: ProductIndex = { GetLineIDsWithType: (_m, type) => vec(byType.get(type) ?? []) };
    expect(geometryProductIds(index, 0)).toEqual([1, 3, 9]);
  });

  it('asks for subtypes too, so an IfcWallStandardCase counts as a product', () => {
    const inherited: boolean[] = [];
    const index: ProductIndex = {
      GetLineIDsWithType: (_m, _t, includeInherited) => {
        inherited.push(includeInherited === true);
        return vec([]);
      },
    };
    geometryProductIds(index, 0);
    expect(inherited.every(Boolean)).toBe(true);
  });
});

const root = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const FILES = ['assets/ifcs/RIB.ifc', 'assets/ifcs/Snowdon Towers Sample Structural.ifc'].map((f) =>
  path.resolve(root, f),
);

for (const file of FILES) {
  describe.skipIf(!existsSync(file))(`geometryProductIds on ${path.basename(file)}`, () => {
    let api: IfcAPI;
    let modelID: number;

    beforeAll(async () => {
      api = new IfcAPI();
      await api.Init();
      api.SetLogLevel(6); // off: the sample has a few breps web-ifc complains about
      modelID = api.OpenModel(new Uint8Array(await fs.readFile(file)));
    });

    afterAll(() => {
      api.CloseModel(modelID);
    });

    it('streams exactly the elements StreamAllMeshes streams', () => {
      const all: number[] = [];
      api.StreamAllMeshes(modelID, (m) => {
        all.push(m.expressID);
        (m.geometries as unknown as { delete(): void }).delete();
      });
      const listed: number[] = [];
      api.StreamMeshes(modelID, geometryProductIds(api, modelID), (m) => {
        listed.push(m.expressID);
        (m.geometries as unknown as { delete(): void }).delete();
      });
      expect([...listed].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));
    });

    it('is an upper bound on what streams, never below it', () => {
      let streamed = 0;
      api.StreamAllMeshes(modelID, (m) => {
        streamed++;
        (m.geometries as unknown as { delete(): void }).delete();
      });
      expect(geometryProductIds(api, modelID).length).toBeGreaterThanOrEqual(streamed);
    });
  });
}
