/**
 * The per-model property cache (#66) against the real web-ifc engine.
 *
 * The cache answers relationship lookups from an index, resolves each type
 * object once and reads psets only as deep as the normalizer looks. None of
 * that may change what an element reports, so every test here compares the
 * cached read with the uncached one — which is exactly the code path that ran
 * before the cache existed.
 */

// Node builtins. `@types/node` is not installed in this project, so we
// suppress the missing-module typecheck on each import (as the RIB tests do).
// @ts-expect-error -- node:fs has no bundled types here
import { promises as fs, existsSync } from 'node:fs';
// @ts-expect-error -- node:path has no bundled types here
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IfcAPI, IFCPRODUCT, IFCTYPEOBJECT } from 'web-ifc';
import {
  fetchElementProperties,
  type PropertyApi,
} from '../src/inspector/repository/fetchElementProperties';
import {
  ModelPropertyCache,
  ModelPropertyCaches,
} from '../src/inspector/repository/modelPropertyCache';
import { computeUnitTable } from '../src/inspector/repository/unitTable';
import { intersectSeed, intersectStep } from '../src/inspector/intersection';
import type { ElementProperties } from '../src/inspector/types';
import type { UnitTable } from '../src/inspector/format';
import workerSrc from '../src/parser/ifcWorker.ts?raw';

type Snapshot = Omit<ElementProperties, 'fetchedAt'>;

/** Everything but the fetch timestamp — the only field allowed to differ. */
function snapshot(p: ElementProperties): Snapshot {
  const { fetchedAt, ...rest } = p;
  void fetchedAt;
  return rest;
}

function ids(api: IfcAPI, modelID: number, type: number): number[] {
  const vec = api.GetLineIDsWithType(modelID, type, true);
  const out: number[] = [];
  for (let i = 0; i < vec.size(); i++) out.push(vec.get(i));
  return out;
}

async function unitsOf(api: IfcAPI, modelID: number): Promise<UnitTable> {
  return computeUnitTable(api as unknown as Parameters<typeof computeUnitTable>[0], modelID);
}

/**
 * A small IFC2X3 model shaped like a Revit export: three walls share one
 * type, which carries a pset and a material; instance psets and a quantity
 * set hang off individual elements, and one pset is shared by two elements.
 * `variant` changes every value but no express id, so two variants opened
 * one after the other collide on every id a cache could key by.
 */
function tinyModel(variant: 'A' | 'B'): Uint8Array {
  const v = (a: string, b: string): string => (variant === 'A' ? a : b);
  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('tiny.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#10=IFCWALLSTANDARDCASE('0000000000000000000010',$,'Wall 1',$,$,$,$,'101');
#11=IFCWALLSTANDARDCASE('0000000000000000000011',$,'Wall 2',$,$,$,$,'102');
#12=IFCWALLSTANDARDCASE('0000000000000000000012',$,'Wall 3',$,$,$,$,'103');
#13=IFCBEAM('0000000000000000000013',$,'Beam',$,$,$,$,'104');
#20=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('${v('EI60', 'EI90')}'),$);
#21=IFCPROPERTYSET('0000000000000000000021',$,'Pset_WallCommon',$,(#20));
#22=IFCWALLTYPE('0000000000000000000022',$,'${v('Basic Wall:200', 'Basic Wall:300')}',$,$,(#21),$,$,$,.STANDARD.);
#23=IFCRELDEFINESBYTYPE('0000000000000000000023',$,$,$,(#10,#11,#12),#22);
#30=IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('${v('A-1', 'B-1')}'),$);
#31=IFCPROPERTYSET('0000000000000000000031',$,'Identity Data',$,(#30));
#32=IFCRELDEFINESBYPROPERTIES('0000000000000000000032',$,$,$,(#10,#13),#31);
#33=IFCQUANTITYLENGTH('Length',$,$,${v('5.', '7.')});
#34=IFCELEMENTQUANTITY('0000000000000000000034',$,'Qto_WallBaseQuantities',$,$,(#33));
#35=IFCRELDEFINESBYPROPERTIES('0000000000000000000035',$,$,$,(#11),#34);
#40=IFCMATERIAL('${v('Concrete', 'Brick')}');
#41=IFCRELASSOCIATESMATERIAL('0000000000000000000041',$,$,$,(#22),#40);
ENDSEC;
END-ISO-10303-21;
`;
  return new TextEncoder().encode(text);
}

/** Wrap an api so we can count which lines get read. */
function countingApi(api: IfcAPI): { api: IfcAPI; reads: Map<number, number> } {
  const reads = new Map<number, number>();
  const wrapped = new Proxy(api, {
    get(target, prop, receiver) {
      if (prop === 'GetLine') {
        return (modelID: number, id: number, ...rest: unknown[]) => {
          reads.set(id, (reads.get(id) ?? 0) + 1);
          return (target.GetLine as (...a: unknown[]) => unknown).call(target, modelID, id, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { api: wrapped, reads };
}

describe('ModelPropertyCache — a small Revit-shaped model', () => {
  let api: IfcAPI;
  let modelID: number;
  let units: UnitTable;

  beforeAll(async () => {
    api = new IfcAPI();
    await api.Init();
    modelID = api.OpenModel(tinyModel('A'));
    units = await unitsOf(api, modelID);
  });

  afterAll(() => {
    api.CloseModel(modelID);
  });

  it('reports exactly what the uncached read reports, for every element', async () => {
    const cache = new ModelPropertyCache(api, modelID);
    const elements = ids(api, modelID, IFCPRODUCT);
    expect(elements).toHaveLength(4);
    for (const id of elements) {
      const uncached = await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', id, units);
      const cached = await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', id, units, cache);
      expect(snapshot(cached)).toEqual(snapshot(uncached));
    }
  });

  it('carries the fixture through: type psets, type material, instance psets and quantities', async () => {
    // Guards the test above against comparing two empty results.
    const cache = new ModelPropertyCache(api, modelID);
    const wall1 = await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', 10, units, cache);
    expect(wall1.identity.typeName).toBe('Basic Wall:200');
    expect(wall1.psets.map((g) => [g.name, g.inheritedFromType === true])).toEqual([
      ['Identity Data', false],
      ['Pset_WallCommon', true],
    ]);
    expect(wall1.materials).toEqual([{ kind: 'material-ref', materialName: 'Concrete', expressId: 40 }]);
    const wall2 = await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', 11, units, cache);
    expect(wall2.qtos.map((g) => g.name)).toEqual(['Qto_WallBaseQuantities']);
  });

  it('resolves a shared type once, not once per instance', async () => {
    const counted = countingApi(api);
    const cache = new ModelPropertyCache(counted.api, modelID);
    for (const id of [10, 11, 12]) {
      await fetchElementProperties(counted.api as unknown as PropertyApi, modelID, 'm', id, units, cache);
    }
    // The type line, its pset and its material: read once for three walls.
    expect(counted.reads.get(22)).toBe(1);
    expect(counted.reads.get(21)).toBe(1);
    expect(counted.reads.get(40)).toBe(1);
    expect(cache.resolvedTypeCount).toBe(1);
  });

  it('is not contaminated when a caller mutates what it was given', async () => {
    // Raw lines are shared between the elements of a type; built groups must
    // not be. Vandalise every result as the intersection fold or a caller
    // might, then read the type's other instances again.
    const cache = new ModelPropertyCache(api, modelID);
    const reference = new Map<number, Snapshot>();
    for (const id of [10, 11, 12]) {
      reference.set(id, snapshot(await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', id, units)));
    }
    for (const id of [10, 11, 12]) {
      const p = await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', id, units, cache);
      for (const g of [...p.psets, ...p.qtos]) {
        g.name = 'vandalised';
        g.inheritedFromType = false;
        for (const node of g.properties) node.key = 'vandalised';
        g.properties.length = 0;
      }
      p.materials.length = 0;
      p.flat.length = 0;
      p.identity.typeName = 'vandalised';
    }
    let running = intersectSeed(await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', 10, units, cache));
    running = intersectStep(running, await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', 11, units, cache));
    void running;
    for (const id of [10, 11, 12]) {
      const again = await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', id, units, cache);
      expect(snapshot(again)).toEqual(reference.get(id));
    }
  });
});

/**
 * An IFC4 model with two types on one element, a relationship whose id is
 * lower than one declared before it (ids out of order), and type materials.
 */
function ifc4Model(): Uint8Array {
  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('ifc4.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#10=IFCWALL('0000000000000000000010',$,'Wall 1',$,$,$,$,'101',.STANDARD.);
#11=IFCWALL('0000000000000000000011',$,'Wall 2',$,$,$,$,'102',.STANDARD.);
#12=IFCBEAM('0000000000000000000012',$,'Beam',$,$,$,$,'103',.BEAM.);
#20=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI60'),$);
#21=IFCPROPERTYSET('0000000000000000000021',$,'Pset_WallCommon',$,(#20));
#22=IFCWALLTYPE('0000000000000000000022',$,'Type One',$,$,(#21),$,$,$,.STANDARD.);
#24=IFCPROPERTYSINGLEVALUE('Load',$,IFCLABEL('Heavy'),$);
#25=IFCPROPERTYSET('0000000000000000000025',$,'Pset_Second',$,(#24));
#26=IFCWALLTYPE('0000000000000000000026',$,'Type Two',$,$,(#25),$,$,$,.SOLIDWALL.);
#60=IFCRELDEFINESBYTYPE('0000000000000000000060',$,$,$,(#10,#11),#22);
#50=IFCRELDEFINESBYTYPE('0000000000000000000050',$,$,$,(#10),#26);
#30=IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('A-1'),$);
#31=IFCPROPERTYSET('0000000000000000000031',$,'Identity Data',$,(#30));
#32=IFCRELDEFINESBYPROPERTIES('0000000000000000000032',$,$,$,(#10,#12),#31);
#40=IFCMATERIAL('Concrete',$,$);
#41=IFCMATERIAL('Steel',$,$);
#42=IFCRELASSOCIATESMATERIAL('0000000000000000000042',$,$,$,(#22),#40);
#43=IFCRELASSOCIATESMATERIAL('0000000000000000000043',$,$,$,(#26),#41);
ENDSEC;
END-ISO-10303-21;
`;
  return new TextEncoder().encode(text);
}

/**
 * A relationship may list the same object twice. web-ifc's inverse lookup
 * returns that relationship twice; the cache must too.
 */
function duplicateRefModel(schema: 'IFC2X3' | 'IFC4'): Uint8Array {
  const wall =
    schema === 'IFC4'
      ? (n: number, name: string): string =>
          `#${n}=IFCWALL('00000000000000000000${n}',$,'${name}',$,$,$,$,'${n}',.STANDARD.);`
      : (n: number, name: string): string =>
          `#${n}=IFCWALLSTANDARDCASE('00000000000000000000${n}',$,'${name}',$,$,$,$,'${n}');`;
  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('dup.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
${wall(10, 'Wall 1')}
${wall(11, 'Wall 2')}
#20=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('EI60'),$);
#21=IFCPROPERTYSET('0000000000000000000021',$,'Pset_WallCommon',$,(#20));
#22=IFCWALLTYPE('0000000000000000000022',$,'Basic Wall',$,$,(#21),$,$,$,.STANDARD.);
#23=IFCRELDEFINESBYTYPE('0000000000000000000023',$,$,$,(#10,#10,#11),#22);
#30=IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('A-1'),$);
#31=IFCPROPERTYSET('0000000000000000000031',$,'Identity Data',$,(#30));
#70=IFCRELDEFINESBYPROPERTIES('0000000000000000000070',$,$,$,(#10,#10,#11),#31);
#40=IFCMATERIAL('Concrete'${schema === 'IFC4' ? ",$,$" : ''});
#41=IFCRELASSOCIATESMATERIAL('0000000000000000000041',$,$,$,(#22,#22),#40);
ENDSEC;
END-ISO-10303-21;
`;
  return new TextEncoder().encode(text);
}

/** Every product reads the same cached as uncached; returns the cached reads. */
async function expectCachedEqualsUncached(
  data: Uint8Array,
  expectedProducts: number,
): Promise<Map<number, ElementProperties>> {
  const api = new IfcAPI();
  await api.Init();
  const modelID = api.OpenModel(data);
  const out = new Map<number, ElementProperties>();
  try {
    const units = await unitsOf(api, modelID);
    const cache = new ModelPropertyCache(api, modelID);
    const elements = ids(api, modelID, IFCPRODUCT);
    expect(elements).toHaveLength(expectedProducts);
    for (const id of elements) {
      const uncached = await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', id, units);
      const cached = await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', id, units, cache);
      expect(snapshot(cached)).toEqual(snapshot(uncached));
      out.set(id, cached);
    }
  } finally {
    api.CloseModel(modelID);
  }
  return out;
}

describe('ModelPropertyCache — IFC4, two types, out-of-order ids', () => {
  it('reports exactly what the uncached read reports, for every element', async () => {
    const reads = await expectCachedEqualsUncached(ifc4Model(), 3);
    // Guard against comparing two empty results.
    const wall1 = reads.get(10)!;
    expect(wall1.psets.map((g) => g.name)).toContain('Pset_WallCommon');
    expect(wall1.psets.map((g) => g.name)).toContain('Pset_Second');
    expect(wall1.materials.length).toBeGreaterThan(0);
  });
});

describe('ModelPropertyCache — a relationship listing an object twice', () => {
  for (const schema of ['IFC2X3', 'IFC4'] as const) {
    it(`reads like the uncached path, ${schema}`, async () => {
      const reads = await expectCachedEqualsUncached(duplicateRefModel(schema), 2);
      // The fixture really duplicates: the pset is reported more than once.
      const identity = reads.get(10)!.psets.filter((g) => g.name === 'Identity Data');
      expect(identity.length).toBeGreaterThan(1);
    });
  }
});

describe('ModelPropertyCaches — lifetime', () => {
  it('drops a model\'s cache when the model is closed, so the next model starts empty', async () => {
    const api = new IfcAPI();
    await api.Init();
    const caches = new ModelPropertyCaches();

    const idA = api.OpenModel(tinyModel('A'));
    const unitsA = await unitsOf(api, idA);
    const cacheA = caches.for('model-a', api, idA);
    const a = await fetchElementProperties(api as unknown as PropertyApi, idA, 'model-a', 10, unitsA, cacheA);
    expect(a.identity.typeName).toBe('Basic Wall:200');
    expect(caches.peek('model-a')).toBe(cacheA);

    // Close A the way the worker does: close in web-ifc, drop the cache.
    api.CloseModel(idA);
    caches.drop('model-a');
    expect(caches.peek('model-a')).toBeUndefined();
    expect(caches.size).toBe(0);

    // B reuses every express id A had — and possibly A's web-ifc id too.
    const idB = api.OpenModel(tinyModel('B'));
    const unitsB = await unitsOf(api, idB);
    const cacheB = caches.for('model-b', api, idB);
    expect(cacheB).not.toBe(cacheA);
    for (const id of ids(api, idB, IFCPRODUCT)) {
      const cached = await fetchElementProperties(api as unknown as PropertyApi, idB, 'model-b', id, unitsB, cacheB);
      const uncached = await fetchElementProperties(api as unknown as PropertyApi, idB, 'model-b', id, unitsB);
      expect(snapshot(cached)).toEqual(snapshot(uncached));
    }
    const b = await fetchElementProperties(api as unknown as PropertyApi, idB, 'model-b', 10, unitsB, cacheB);
    expect(b.identity.typeName).toBe('Basic Wall:300');
    expect(b.materials[0]).toMatchObject({ materialName: 'Brick' });

    api.CloseModel(idB);
  });

  it('keeps two open models apart', async () => {
    const api = new IfcAPI();
    await api.Init();
    const caches = new ModelPropertyCaches();
    const idA = api.OpenModel(tinyModel('A'));
    const idB = api.OpenModel(tinyModel('B'));
    try {
      const cacheA = caches.for('model-a', api, idA);
      const cacheB = caches.for('model-b', api, idB);
      expect(cacheA).not.toBe(cacheB);
      const units = await unitsOf(api, idA);
      const a = await fetchElementProperties(api as unknown as PropertyApi, idA, 'model-a', 10, units, cacheA);
      const b = await fetchElementProperties(api as unknown as PropertyApi, idB, 'model-b', 10, units, cacheB);
      expect(a.identity.typeName).toBe('Basic Wall:200');
      expect(b.identity.typeName).toBe('Basic Wall:300');
    } finally {
      api.CloseModel(idA);
      api.CloseModel(idB);
    }
  });

  it('never hands out a cache bound to a different web-ifc id under the same model id', async () => {
    const api = new IfcAPI();
    await api.Init();
    const caches = new ModelPropertyCaches();
    const first = caches.for('model', api, 0);
    expect(caches.for('model', api, 0)).toBe(first);
    expect(caches.for('model', api, 1)).not.toBe(first);
  });

  it('forgets every cache on clear', async () => {
    const api = new IfcAPI();
    await api.Init();
    const caches = new ModelPropertyCaches();
    caches.for('a', api, 0);
    caches.for('b', api, 1);
    caches.clear();
    expect(caches.size).toBe(0);
  });

  it('a fetch ignores a cache that belongs to another web-ifc model', async () => {
    const api = new IfcAPI();
    await api.Init();
    const idA = api.OpenModel(tinyModel('A'));
    const idB = api.OpenModel(tinyModel('B'));
    try {
      const units = await unitsOf(api, idB);
      const wrong = new ModelPropertyCache(api, idA);
      const b = await fetchElementProperties(api as unknown as PropertyApi, idB, 'model-b', 10, units, wrong);
      expect(b.identity.typeName).toBe('Basic Wall:300');
    } finally {
      api.CloseModel(idA);
      api.CloseModel(idB);
    }
  });
});

describe('ifcWorker property-cache wiring', () => {
  const fn = (signature: RegExp): string => {
    const m = workerSrc.match(signature);
    expect(m, `worker function ${signature} not found`).not.toBeNull();
    return m![0];
  };

  it('drops the cache when a model is closed', () => {
    expect(fn(/function handleDisposeModel\([\s\S]*?\n\}/)).toMatch(/propertyCaches\.drop\(id\)/);
  });

  it('drops every cache when web-ifc is torn down', () => {
    expect(fn(/function handleDispose\(\)[\s\S]*?\n\}/)).toMatch(/propertyCaches\.clear\(\)/);
  });

  it('bulk reads build the cache; single reads only use one that exists', () => {
    expect(fn(/async function readProps\([\s\S]*?\n\}/)).toMatch(/propertyCaches\.for\(id, ifc, modelID\)/);
    const single = fn(/async function handleGetProps\([\s\S]*?\n\}/);
    expect(single).toMatch(/propertyCaches\.peek\(id\)/);
    expect(single).not.toMatch(/propertyCaches\.for\(/);
  });
});

/**
 * Every product of real exports, cached against uncached. Snowdon Towers is
 * tracked in the repo; RIB.ifc is not, and is compared when present.
 */
const FIXTURES = [
  'assets/ifcs/Snowdon Towers Sample Structural.ifc',
  'assets/ifcs/RIB.ifc',
];

for (const rel of FIXTURES) {
  // @ts-expect-error -- `process` is a Node global, no bundled types in this project
  const file = path.resolve(process.cwd(), rel);
  describe.skipIf(!existsSync(file))(`ModelPropertyCache — ${path.basename(file)}`, () => {
    it('every product reads identically with and without the cache', async () => {
      const api = new IfcAPI();
      await api.Init();
      const modelID = api.OpenModel(new Uint8Array(await fs.readFile(file)));
      try {
        const units = await unitsOf(api, modelID);
        const cache = new ModelPropertyCache(api, modelID);
        const products = ids(api, modelID, IFCPRODUCT);
        expect(products.length).toBeGreaterThan(0);
        let withTypeData = 0;
        for (const id of products) {
          const uncached = await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', id, units);
          const cached = await fetchElementProperties(api as unknown as PropertyApi, modelID, 'm', id, units, cache);
          expect(snapshot(cached)).toEqual(snapshot(uncached));
          if (cached.psets.some((g) => g.inheritedFromType) || cached.materials.length > 0) withTypeData++;
        }
        // The comparison exercised the type side, and types were shared.
        expect(withTypeData).toBeGreaterThan(0);
        expect(cache.resolvedTypeCount).toBeLessThanOrEqual(ids(api, modelID, IFCTYPEOBJECT).length);
        expect(cache.resolvedTypeCount).toBeLessThan(products.length);
      } finally {
        api.CloseModel(modelID);
      }
    }, 180_000);
  });
}
