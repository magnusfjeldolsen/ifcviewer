/**
 * The elements a model's geometry is streamed for, listed up front.
 *
 * web-ifc's `StreamAllMeshes` streams every product except openings and
 * spaces, but only says how many there are by visiting them all — which
 * generates every element's geometry. The viewer used to run it twice, once
 * just to count (4 s of a 13 s load on a 357 MB model, 18 s on a geometry-
 * heavy 48 MB one).
 *
 * This list is the same set, read from the type index in milliseconds:
 * every `IfcProduct`, without the opening and space subtrees. Streaming it
 * with `StreamMeshes` yields exactly the elements `StreamAllMeshes` does
 * (checked on five real models), only in expressID order rather than grouped
 * by type. Its length is an upper bound on the progress total: products
 * without a body (an `IfcGrid`, a storey) are listed but stream nothing —
 * 0.3 % to 12 % of the list on the models measured.
 *
 * Having the list is also what lets the work be split between workers.
 */

import * as WebIFC from 'web-ifc';

/** What this module needs of `IfcAPI` (lets tests pass a fake). */
export interface ProductIndex {
  GetLineIDsWithType(modelID: number, type: number, includeInherited?: boolean): WebIFC.Vector<number>;
}

/** Products `StreamAllMeshes` leaves out, with their subtypes. */
export const NOT_STREAMED_TYPES: readonly number[] = [
  WebIFC.IFCOPENINGELEMENT,
  WebIFC.IFCOPENINGSTANDARDCASE,
  WebIFC.IFCSPACE,
];

/** expressIDs of the products whose geometry a full stream would deliver, ascending. */
export function geometryProductIds(ifc: ProductIndex, modelID: number): number[] {
  const skip = new Set<number>();
  for (const type of NOT_STREAMED_TYPES) {
    const v = ifc.GetLineIDsWithType(modelID, type, true);
    for (let i = 0; i < v.size(); i++) skip.add(v.get(i));
  }
  const all = ifc.GetLineIDsWithType(modelID, WebIFC.IFCPRODUCT, true);
  const ids: number[] = [];
  for (let i = 0; i < all.size(); i++) {
    const id = all.get(i);
    if (!skip.has(id)) ids.push(id);
  }
  ids.sort((a, b) => a - b);
  return ids;
}
