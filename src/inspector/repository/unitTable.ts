/**
 * Project-level IfcUnitAssignment readers.
 *
 * `computeUnitTable` walks the `IfcProject.UnitsInContext.Units` list and
 * builds the model's effective `UnitTable` (driving the unit-pill suffix
 * in the inspector UI). Pure of orchestration concerns: takes a small
 * `UnitTableApi` so we can call it without depending on the full
 * `PropertyApi` surface.
 *
 * Split out of `WebIfcPropertyRepository.ts` to keep that file focused on
 * memoization + per-element fetch coordination. No behavior change.
 */

import { IFCPROJECT, IFCSIUNIT, IFCCONVERSIONBASEDUNIT } from 'web-ifc';

import {
  buildUnitTable,
  type RawUnitEntry,
  type UnitTable,
} from '../format';
import { isObj, readString } from './propertyNormalizer';

/** Minimal IfcAPI subset needed to read the project unit assignment. */
export interface UnitTableApi {
  GetLineIDsWithType(modelID: number, type: number, includeInherited?: boolean): {
    get(index: number): number;
    size(): number;
  };
  properties: {
    getItemProperties(
      modelID: number,
      id: number,
      recursive?: boolean,
      inverse?: boolean,
    ): Promise<unknown>;
  };
}

/** Read one entry of `IfcProject.UnitsInContext.Units`. */
export function readUnitEntry(u: unknown): RawUnitEntry | null {
  if (!isObj(u)) return null;
  const typeCode = typeof u.type === 'number' ? u.type : undefined;
  const unitType = readString(u.UnitType);
  if (!unitType) return null;

  if (typeCode === IFCSIUNIT) {
    return {
      unitType,
      siPrefix: readString(u.Prefix) ?? null,
      siName: readString(u.Name) ?? null,
    };
  }
  if (typeCode === IFCCONVERSIONBASEDUNIT) {
    return {
      unitType,
      conversionLabel: readString(u.Name) ?? null,
    };
  }
  // Derived units and other variants — skip in Phase 1.
  return null;
}

/**
 * Compute the unit table for a model by walking IfcProject.UnitsInContext.
 * Returns an empty `UnitTable` if the project line cannot be read.
 *
 * `webIfcId` is the internal web-ifc model id (already resolved by the
 * caller via its UUID→numeric map).
 */
export async function computeUnitTable(
  api: UnitTableApi,
  webIfcId: number,
): Promise<UnitTable> {
  // Find the project line. Models always have exactly one IfcProject.
  let projects: { get(i: number): number; size(): number };
  try {
    projects = api.GetLineIDsWithType(webIfcId, IFCPROJECT, false);
  } catch {
    return buildUnitTable([]);
  }
  if (!projects || projects.size() === 0) return buildUnitTable([]);
  const projectId = projects.get(0);

  let project: unknown;
  try {
    project = await api.properties.getItemProperties(webIfcId, projectId, true, false);
  } catch {
    return buildUnitTable([]);
  }

  // Recursive walk down `UnitsInContext.Units` to collect SI / conversion units.
  const entries: RawUnitEntry[] = [];
  if (isObj(project)) {
    const unitsInContext = project.UnitsInContext;
    if (isObj(unitsInContext) && Array.isArray(unitsInContext.Units)) {
      for (const u of unitsInContext.Units) {
        const entry = readUnitEntry(u);
        if (entry) entries.push(entry);
      }
    }
  }
  return buildUnitTable(entries);
}
