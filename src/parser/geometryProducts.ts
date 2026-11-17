/**
 * The elements a model's geometry is streamed for, listed up front.
 *
 * web-ifc's `StreamAllMeshes` streams every element except openings and
 * spaces, but only says how many there are by visiting them all — which
 * generates every element's geometry. The viewer used to run it twice, once
 * just to count (4 s of a 13 s load on a 357 MB model, 18 s on a geometry-
 * heavy 48 MB one).
 *
 * This list is the same set, read from the type index in milliseconds, and
 * built the way web-ifc builds its own: every type of the model's schema that
 * web-ifc itself calls an element (`IsIfcElement` — its generated per-schema
 * list, so a new schema or web-ifc version brings its own), less the types
 * `StreamAllMeshes` skips. Only that skip list is ours; tests stream real
 * IFC2X3 files and synthetic IFC4 and IFC4X3 ones (annotations, voiding
 * features, spatial zones, external spatial elements, geographic and virtual
 * elements, alignments, referents, courses, bridges, sites, storeys) and
 * check both give exactly the same elements. Only the order differs:
 * expressID order here, by type there.
 *
 * Its length is an upper bound on the progress total: elements without a
 * body (a storey, a grid) are listed but stream nothing — 0.3 % to 12 % of
 * the list on the models measured.
 *
 * Having the list is also what lets the work be split between workers.
 */

import * as WebIFC from 'web-ifc';

/** What this module needs of `IfcAPI` (lets tests pass a fake). */
export interface ProductIndex {
  GetIfcEntityList(modelID: number): number[];
  IsIfcElement(type: number): boolean;
  GetLineIDsWithType(modelID: number, type: number, includeInherited?: boolean): WebIFC.Vector<number>;
}

/** Element types `StreamAllMeshes` skips (as web-ifc 0.0.77 does; exact types, not subtypes). */
export const NOT_STREAMED_TYPES: ReadonlySet<number> = new Set([
  WebIFC.IFCOPENINGELEMENT,
  WebIFC.IFCOPENINGSTANDARDCASE,
  WebIFC.IFCSPACE,
]);

/** expressIDs of the elements whose geometry a full stream would deliver, ascending. */
export function geometryProductIds(ifc: ProductIndex, modelID: number): number[] {
  const ids: number[] = [];
  for (const type of ifc.GetIfcEntityList(modelID)) {
    if (NOT_STREAMED_TYPES.has(type) || !ifc.IsIfcElement(type)) continue;
    const v = ifc.GetLineIDsWithType(modelID, type, false);
    for (let i = 0; i < v.size(); i++) ids.push(v.get(i));
  }
  ids.sort((a, b) => a - b);
  return ids;
}
