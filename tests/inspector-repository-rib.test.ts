/**
 * End-to-end regressions against `assets/ifcs/RIB.ifc` — a real Revit export.
 *
 * Two bugs reached manual testing because the unit tests mock web-ifc:
 * `getPropertySets(.., true, true)` is destructive (with
 * `includeTypeProperties` it returns ONLY type-level psets and silently drops
 * every instance-level one attached via `IfcRelDefinesByProperties`), and
 * `GetTypeCodeFromName` hashes rather than looks up. Both are invisible to a
 * mock and obvious against an actual model.
 *
 * The fixture is NOT version-controlled — it is whatever export currently
 * sits in `assets/ifcs/`, and it has already been swapped once mid-review,
 * which broke every hard-coded expressId and element count in here. So these
 * tests derive their targets from the file: they ask it which class to use,
 * and assert INVARIANTS that must hold of any export (both pset origins
 * survive the merge; type is strictly narrower than category) rather than
 * counts that belong to one particular file. Absolute numbers live in the
 * Snowdon describe below, whose fixture IS tracked.
 */

// Node builtins. `@types/node` is not installed in this project, so we
// suppress the missing-module typecheck on each import. Vitest's bundler
// handles these fine at run time.
// @ts-expect-error -- node:fs has no bundled types here
import { promises as fs, existsSync } from 'node:fs';
// @ts-expect-error -- node:path has no bundled types here
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { IfcAPI, IFCCOLUMN, IFCPRODUCT } from 'web-ifc';
import {
  fetchElementProperties,
  type PropertyApi,
} from '../src/inspector/repository/fetchElementProperties';
import type { ElementProperties } from '../src/inspector/types';
import { computeUnitTable } from '../src/inspector/repository/unitTable';
import { elementMatches } from '../src/inspector/matchValue';
import { typeQuery } from '../src/inspector/selectSimilar';

// @ts-expect-error -- `process` is a Node global, no bundled types in this project
const IFC_PATH = path.resolve(process.cwd(), 'assets/ifcs/RIB.ifc');
const MODEL_UUID = 'rib-regression-uuid';

// The fixture is kept outside version control. If it is absent we skip
// rather than fail — the mocked-API tests still guard the same code path.
const FILE_PRESENT = existsSync(IFC_PATH);

describe.skipIf(!FILE_PRESENT)('RIB.ifc end-to-end', () => {
  let api: IfcAPI;
  let modelID: number;
  /** Every product in the file, read through the real fetch path, once. */
  let all: ElementProperties[] = [];

  beforeAll(async () => {
    api = new IfcAPI();
    await api.Init();
    const buf = await fs.readFile(IFC_PATH);
    modelID = api.OpenModel(new Uint8Array(buf));
    const propApi = api as unknown as PropertyApi;
    const unitTable = await computeUnitTable(
      api as unknown as Parameters<typeof computeUnitTable>[0],
      modelID,
    );
    const vec = api.GetLineIDsWithType(modelID, IFCPRODUCT, true);
    const ids: number[] = [];
    for (let i = 0; i < vec.size(); i++) ids.push(vec.get(i));
    all = [];
    for (const id of ids) {
      all.push(await fetchElementProperties(propApi, modelID, MODEL_UUID, id, unitTable));
    }
  }, 180_000);

  afterAll(() => {
    if (api && modelID !== undefined) api.CloseModel(modelID);
  });

  /** The file's elements grouped by class, largest class first. */
  function byClass(): ElementProperties[][] {
    const map = new Map<string, ElementProperties[]>();
    for (const p of all) {
      const list = map.get(p.identity.ifcClass) ?? [];
      list.push(p);
      map.set(p.identity.ifcClass, list);
    }
    return [...map.values()].sort((a, b) => b.length - a.length);
  }

  it('reads the file at all — a fixture with no products makes every other assertion vacuous', () => {
    expect(all.length).toBeGreaterThan(0);
    expect(api.GetLineIDsWithType(modelID, IFCCOLUMN, false).size()).toBeGreaterThan(0);
  });

  it('keeps BOTH instance-level and type-level psets on elements that have both', () => {
    // The destructive-call bug: with includeTypeProperties the instance psets
    // vanish and an element ends up with type groups ONLY. Any element
    // carrying both proves the two-call merge is still in place.
    const withBoth = all.filter((p) => {
      const groups = [...p.psets, ...p.qtos];
      return (
        groups.some((g) => g.inheritedFromType === true) &&
        groups.some((g) => g.inheritedFromType !== true)
      );
    });
    expect(
      withBoth.length,
      'no element in this export carries both instance- and type-level psets, ' +
        'so this regression is untestable against the current fixture',
    ).toBeGreaterThan(0);

    // Every group must also reach the flat rows the inspector renders —
    // a group that survives the merge but not the flattening is still lost.
    const sample = withBoth[0];
    for (const group of [...sample.psets, ...sample.qtos]) {
      expect(sample.flat.some((r) => r.path.startsWith(`${group.name}.`))).toBe(true);
    }
  });

  it('matches by type without matching the whole category', () => {
    // The point of having two grains: type is strictly narrower than
    // category. If they ever converge, the type option is pointless.
    const list = byClass().find(
      (c) => c.length > 1 && new Set(c.map((p) => p.identity.typeName).filter(Boolean)).size > 1,
    );
    expect(
      list,
      'no class in this export has two distinct type objects — select-similar is untestable here',
    ).toBeDefined();

    const source = list!.find((p) => !!p.identity.typeName)!;
    const q = typeQuery(source.identity)!;
    expect(q).not.toBeNull();
    // The type came from the linked type object, the only discriminator
    // present in every model measured.
    expect(q.kind === 'value' && q.selector.path).toBe('Identity.Type');

    const matches = list!.filter((p) =>
      elementMatches(
        p,
        q.kind === 'value' ? q.selector : { path: '' },
        q.kind === 'value' ? q.value : { kind: 'varies' },
      ),
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((p) => p.identity.typeName === source.identity.typeName)).toBe(true);
    expect(matches.length).toBeLessThan(list!.length);
  });

  it('strips the authoring-tool id out of Name, so names still group', () => {
    // Revit writes "Family:Type:123456" with the id repeated in Tag. Left in,
    // every element is unique and matching by Name finds only its own source.
    const list = byClass().find(
      (c) =>
        c.length > 2 &&
        new Set(c.map((p) => p.identity.typeName).filter(Boolean)).size < c.length,
    );
    expect(list).toBeDefined();
    const names = new Set(list!.map((p) => p.identity.name));
    expect(
      names.size,
      `Name should group elements by type, got ${names.size} distinct across ${list!.length}`,
    ).toBeLessThan(list!.length);

    for (const p of list!) {
      if (p.identity.tag && p.identity.name) {
        expect(p.identity.name.endsWith(`:${p.identity.tag}`)).toBe(false);
      }
    }
  });
});

/**
 * The same end-to-end path on a model that carries NO ObjectType.
 *
 * Snowdon Towers has a type object on all 54 columns and all 917 beams but
 * ObjectType on none of them — the shape that broke select-similar on the
 * user's 5265.ifc. RIB.ifc alone would not have caught it, which is the whole
 * reason this second fixture is here.
 */
// @ts-expect-error -- `process` is a Node global, no bundled types in this project
const SNOWDON_PATH = path.resolve(process.cwd(), 'assets/ifcs/Snowdon Towers Sample Structural.ifc');
const SNOWDON_PRESENT = existsSync(SNOWDON_PATH);

describe.skipIf(!SNOWDON_PRESENT)('select similar (Snowdon Towers — no ObjectType)', () => {
  it('resolves the type from the type object when ObjectType is absent', async () => {
    const api = new IfcAPI();
    await api.Init();
    const buf = await fs.readFile(SNOWDON_PATH);
    const modelID = api.OpenModel(new Uint8Array(buf));

    try {
      const propApi = api as unknown as PropertyApi;
      const unitTable = await computeUnitTable(
        api as unknown as Parameters<typeof computeUnitTable>[0],
        modelID,
      );

      const vec = api.GetLineIDsWithType(modelID, IFCCOLUMN, false);
      const ids: number[] = [];
      for (let i = 0; i < vec.size(); i++) ids.push(vec.get(i));
      expect(ids.length).toBeGreaterThan(0);

      const all = [];
      for (const id of ids) {
        all.push(await fetchElementProperties(propApi, modelID, MODEL_UUID, id, unitTable));
      }

      // The premise: this export really does omit ObjectType.
      expect(all.every((p) => !p.identity.objectType)).toBe(true);
      // ...and the type object really does fill the gap.
      expect(all.every((p) => !!p.identity.typeName)).toBe(true);

      const source = all[0];
      const q = typeQuery(source.identity)!;
      expect(q, 'a type query despite no ObjectType').not.toBeNull();
      expect(q.kind === 'value' && q.selector.path).toBe('Identity.Type');

      const matches = all.filter((p) =>
        elementMatches(p, q.kind === 'value' ? q.selector : { path: '' },
          q.kind === 'value' ? q.value : { kind: 'varies' }),
      );
      // Every match shares the source's type, and the source matches itself.
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((p) => p.identity.typeName === source.identity.typeName)).toBe(true);
      // Types partition the columns — matching all of them would mean the
      // discriminator isn't discriminating.
      const distinctTypes = new Set(all.map((p) => p.identity.typeName));
      expect(distinctTypes.size).toBeGreaterThan(1);
      expect(matches.length).toBeLessThan(all.length);
    } finally {
      api.CloseModel(modelID);
    }
  }, 180_000);
});
