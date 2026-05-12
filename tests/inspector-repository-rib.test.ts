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
 * Our `WebIfcPropertyRepository` mitigates this by calling
 * `getPropertySets(.., false)` AND `getTypeProperties(.., false)` and
 * merging the two lists. This test loads the real IFC, picks an element
 * known (via the agent diagnostic) to own `Max_Tension`, and asserts the
 * expected psets and rows are now present.
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
import { IfcAPI } from 'web-ifc';
import { WebIfcPropertyRepository } from '../src/inspector/repository/WebIfcPropertyRepository';

// @ts-expect-error -- `process` is a Node global, no bundled types in this project
const IFC_PATH = path.resolve(process.cwd(), 'assets/ifcs/RIB.ifc');
const MODEL_UUID = 'rib-regression-uuid';
const PRIMARY_EXPRESS_ID = 4682;
const FALLBACK_EXPRESS_ID = 4801;

// This regression test depends on a 20MB IFC kept outside version control.
// If the file is absent we skip rather than fail — the mocked-API tests
// still guard the same code path.
const FILE_PRESENT = existsSync(IFC_PATH);

describe.skipIf(!FILE_PRESENT)('WebIfcPropertyRepository (RIB.ifc regression)', () => {
  it('extracts both instance-level and type-level psets for elements with Max_Tension', async () => {
    const api = new IfcAPI();
    await api.Init();

    const buf = await fs.readFile(IFC_PATH);
    const modelID = api.OpenModel(new Uint8Array(buf));

    try {
      const repo = new WebIfcPropertyRepository(
        api as unknown as ConstructorParameters<typeof WebIfcPropertyRepository>[0],
        (id) => (id === MODEL_UUID ? modelID : undefined),
      );

      // Try primary, fall back to secondary if the file evolved.
      let props = await repo.get(MODEL_UUID, PRIMARY_EXPRESS_ID);
      let pickedId: number = PRIMARY_EXPRESS_ID;
      let structural = props.psets.find((p) => p.name === 'Structural Analysis');
      if (!structural) {
        props = await repo.get(MODEL_UUID, FALLBACK_EXPRESS_ID);
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
