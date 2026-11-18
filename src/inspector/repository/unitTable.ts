/**
 * Reads a model's units from web-ifc: the project's unit assignment
 * (`IfcProject.UnitsInContext.Units`) into a `ModelUnits`, which also reads
 * the units set on single properties and quantities as they come up.
 *
 * Only the web-ifc glue lives here; what a unit is, and how it is shown and
 * compared, is `../units.ts`.
 */

import { IFCPROJECT } from '../ifcTypeCodes';
import { ModelUnits } from '../units';
import { isObj } from './propertyNormalizer';

/** Minimal IfcAPI subset needed to read a model's units. */
export interface UnitTableApi {
  GetLineIDsWithType(modelID: number, type: number, includeInherited?: boolean): {
    get(index: number): number;
    size(): number;
  };
  /** Reads a unit line set on a property (`flatten` resolves its references). */
  GetLine?(modelID: number, expressID: number, flatten?: boolean): unknown;
  properties: {
    getItemProperties(
      modelID: number,
      id: number,
      recursive?: boolean,
      inverse?: boolean,
    ): Promise<unknown>;
  };
}

/**
 * The model's units. A model whose project cannot be read states no units:
 * its measures read as "unit not stated" rather than as metres.
 *
 * `webIfcId` is the internal web-ifc model id (already resolved by the
 * caller via its UUID→numeric map).
 */
export async function readModelUnits(api: UnitTableApi, webIfcId: number): Promise<ModelUnits> {
  const readLine = api.GetLine
    ? (id: number): unknown => api.GetLine!(webIfcId, id, true)
    : undefined;

  let projects: { get(i: number): number; size(): number };
  try {
    projects = api.GetLineIDsWithType(webIfcId, IFCPROJECT, false);
  } catch {
    return ModelUnits.none(readLine);
  }
  if (!projects || projects.size() === 0) return ModelUnits.none(readLine);

  let project: unknown;
  try {
    project = await api.properties.getItemProperties(webIfcId, projects.get(0), true, false);
  } catch {
    return ModelUnits.none(readLine);
  }

  const units = isObj(project) && isObj(project.UnitsInContext) ? project.UnitsInContext.Units : undefined;
  return ModelUnits.fromAssignment(Array.isArray(units) ? units : [], readLine);
}
