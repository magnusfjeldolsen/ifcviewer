/**
 * Regression test for the property-set extraction bug.
 *
 * web-ifc's `properties.getPropertySets(modelID, eid, true, true)` is
 * destructive — when `includeTypeProperties=true` it returns ONLY the
 * type-level psets and silently skips every instance-level pset attached
 * via `IfcRelDefinesByProperties`. On `assets/ifcs/RIB.ifc` this drops
 * ~10 psets per concrete-pile-slab element, including `Structural
 * Analysis` (with `Max_Tension` and `Max_Compression`) and
 * `Pset_SlabCommon`.
 *
 * Our property fetch core mitigates this by calling
 * `getPropertySets(.., false)` AND `getTypeProperties(.., false)` and
 * merging the two lists. This test loads the real IFC, picks an element
 * known (via the agent diagnostic) to own `Max_Tension`, and asserts the
 * expected psets and rows are present.
 *
 * `web-worker-parse` deleted `WebIfcPropertyRepository`; the two-call
 * merge now lives in `fetchElementProperties` (worker-importable). This
 * test is re-pointed at that module directly — it still guards the same
 * code path, just without the memoization/serialization wrapper (which is
 * now the worker queue + `WorkerPropertyRepository`'s main-thread memo).
 *
 * Known target elements with Max_Tension / Max_Compression: expressId
 * 4682 and 4801 (and 31 others — 33 total). We use 4682 as the primary
 * sample; 4801 as a fallback. If neither has the expected pset, the
 * test fails loudly so the diagnostic can be re-run.
 */

// Node builtins. `@types/node` is not installed in this project, so we
// suppress the missing-module typecheck on each import. Vitest's bundler
// handles these fine at run time.
// @ts-expect-error -- node:fs has no bundled types here
import { promises as fs, existsSync } from 'node:fs';
// @ts-expect-error -- node:path has no bundled types here
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { IfcAPI, IFCBEAM, IFCCOLUMN } from 'web-ifc';
import {
  fetchElementProperties,
  type PropertyApi,
} from '../src/inspector/repository/fetchElementProperties';
import { computeUnitTable } from '../src/inspector/repository/unitTable';
import { elementMatches } from '../src/inspector/matchValue';
import { typeQuery } from '../src/inspector/selectSimilar';

// @ts-expect-error -- `process` is a Node global, no bundled types in this project
const IFC_PATH = path.resolve(process.cwd(), 'assets/ifcs/RIB.ifc');
const MODEL_UUID = 'rib-regression-uuid';
const PRIMARY_EXPRESS_ID = 4682;
const FALLBACK_EXPRESS_ID = 4801;

// This regression test depends on a 20MB IFC kept outside version control.
// If the file is absent we skip rather than fail — the mocked-API tests
// still guard the same code path.
const FILE_PRESENT = existsSync(IFC_PATH);

describe.skipIf(!FILE_PRESENT)('fetchElementProperties (RIB.ifc regression)', () => {
  it('extracts both instance-level and type-level psets for elements with Max_Tension', async () => {
    const api = new IfcAPI();
    await api.Init();

    const buf = await fs.readFile(IFC_PATH);
    const modelID = api.OpenModel(new Uint8Array(buf));

    try {
      // PropertyApi is a structural subset of web-ifc's IfcAPI.
      const propApi = api as unknown as PropertyApi;
      const unitTable = await computeUnitTable(
        api as unknown as Parameters<typeof computeUnitTable>[0],
        modelID,
      );

      // Try primary, fall back to secondary if the file evolved.
      let props = await fetchElementProperties(
        propApi, modelID, MODEL_UUID, PRIMARY_EXPRESS_ID, unitTable,
      );
      let pickedId: number = PRIMARY_EXPRESS_ID;
      let structural = props.psets.find((p) => p.name === 'Structural Analysis');
      if (!structural) {
        props = await fetchElementProperties(
          propApi, modelID, MODEL_UUID, FALLBACK_EXPRESS_ID, unitTable,
        );
        pickedId = FALLBACK_EXPRESS_ID;
        structural = props.psets.find((p) => p.name === 'Structural Analysis');
      }

      // --- Structural Analysis pset is present (instance-level — was missing before the fix) ---
      expect(structural, `Structural Analysis pset on eid ${pickedId}`).toBeDefined();
      const structuralProps = structural!.properties.map((p) => p.key);
      expect(structuralProps).toContain('Max_Tension');
      expect(structuralProps).toContain('Max_Compression');

      // --- Flat-row paths include the two structural-analysis properties ---
      const flatPaths = props.flat.map((r) => r.path);
      expect(flatPaths).toContain('Structural Analysis.Max_Tension');
      expect(flatPaths).toContain('Structural Analysis.Max_Compression');

      // --- Force values resolve to "kN" (project declares FORCEUNIT with KILO+NEWTON) ---
      const maxTensionRow = props.flat.find((r) => r.path === 'Structural Analysis.Max_Tension');
      expect(maxTensionRow?.unit, 'Max_Tension unit suffix').toBe('kN');
      const maxCompressionRow = props.flat.find((r) => r.path === 'Structural Analysis.Max_Compression');
      expect(maxCompressionRow?.unit, 'Max_Compression unit suffix').toBe('kN');

      // --- At least one group is tagged inheritedFromType (the type exists on this file) ---
      const allGroups = [...props.psets, ...props.qtos];
      const inheritedGroups = allGroups.filter((g) => g.inheritedFromType === true);
      expect(
        inheritedGroups.length,
        `expected ≥1 type-inherited group on eid ${pickedId}; got ${inheritedGroups.length}`,
      ).toBeGreaterThan(0);

      // --- Total pset count is much higher than the pre-fix ~7 — confirm ≥10 ---
      expect(
        props.psets.length,
        `pre-fix returned ~7 psets; after fix expect ≥10 (got ${props.psets.length})`,
      ).toBeGreaterThanOrEqual(10);
    } finally {
      api.CloseModel(modelID);
    }
  }, 30_000);
});

/**
 * End-to-end regression for select-similar against the real file.
 *
 * The unit tests mock web-ifc, which is exactly why two select-similar bugs
 * reached manual testing: `GetTypeCodeFromName` hashing instead of looking up,
 * and Revit's element id riding along in `Name`. Both were invisible to a mock
 * and obvious against the actual model. This test exercises the real chain —
 * enumerate candidates, normalize each one, run the predicate — and pins the
 * counts measured on RIB.ifc.
 */
describe.skipIf(!FILE_PRESENT)('select similar (RIB.ifc end-to-end)', () => {
  /** Beam counts measured on the file: 121 beams across 8 ObjectTypes. */
  const TOTAL_BEAMS = 121;
  const SAMPLE_TYPE = 'SHS (EN 10210-2):SHS100x6.3';
  const SAMPLE_TYPE_COUNT = 30;

  it('matches by type without matching the whole category', async () => {
    const api = new IfcAPI();
    await api.Init();
    const buf = await fs.readFile(IFC_PATH);
    const modelID = api.OpenModel(new Uint8Array(buf));

    try {
      const propApi = api as unknown as PropertyApi;
      const unitTable = await computeUnitTable(
        api as unknown as Parameters<typeof computeUnitTable>[0],
        modelID,
      );

      // Enumerate exactly as the worker does — by NUMERIC type code. Passing
      // the class name here would silently target the wrong type.
      const vec = api.GetLineIDsWithType(modelID, IFCBEAM, false);
      const beamIds: number[] = [];
      for (let i = 0; i < vec.size(); i++) beamIds.push(vec.get(i));
      expect(beamIds.length).toBe(TOTAL_BEAMS);

      const allProps = [];
      for (const id of beamIds) {
        allProps.push(await fetchElementProperties(propApi, modelID, MODEL_UUID, id, unitTable));
      }

      // A beam of the sample type drives the query, exactly as the UI does.
      const source = allProps.find((p) => p.identity.objectType === SAMPLE_TYPE);
      expect(source, `a beam with ObjectType ${SAMPLE_TYPE}`).toBeDefined();

      const typeQ = typeQuery(source!.identity)!;
      expect(typeQ).not.toBeNull();
      const matches = allProps.filter((p) =>
        elementMatches(p, typeQ.kind === 'value' ? typeQ.selector : { path: '' },
          typeQ.kind === 'value' ? typeQ.value : { kind: 'varies' }),
      );

      // The point of having two grains: type is strictly narrower than
      // category. If these ever converge, the type option is pointless.
      expect(matches.length).toBe(SAMPLE_TYPE_COUNT);
      expect(matches.length).toBeLessThan(TOTAL_BEAMS);

      // The type came from the linked type object, which is the only
      // discriminator present in every sample model.
      expect(source!.identity.typeName).toBe(SAMPLE_TYPE);

      // Revit's element id must not ride along in Name, or every element is
      // unique and matching by Name finds only its own source.
      const names = new Set(allProps.map((p) => p.identity.name));
      expect(
        names.size,
        `Name should group beams by type (~8 distinct), got ${names.size} of ${TOTAL_BEAMS}`,
      ).toBeLessThan(TOTAL_BEAMS);
    } finally {
      api.CloseModel(modelID);
    }
  }, 120_000);
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
