/**
 * "Select similar" — turn one element's property row into a query for every
 * element like it.
 *
 * Pure: builds and describes the query. Running it is the repository's job
 * (`findMatching` / `enumerateExpressIds` in the worker) and applying the
 * result is `SelectionManager.selectExactly`'s. Keeping the decisions here
 * means the gating rules and the labels are testable without a DOM, a
 * worker, or a model.
 *
 * v1 scope, per dev/plans/handoff-select-similar.md:
 *  - **within one model** — the source element's. "Across all loaded models"
 *    is a later toggle.
 *  - **within the source's IFC class** — exact-path matching means a beam's
 *    `Pset_BeamCommon.Reference` and a column's `Pset_ColumnCommon.Reference`
 *    are different paths anyway, so widening the candidate set would only
 *    cost time.
 *  - **one criterion** — multi-criteria, ranges and operators belong to the
 *    heavier filter panel (`filter-by-parameter`).
 *
 * Note on presets: the plan lists "same IFC type" and "same class" as two
 * presets, but `ElementIdentity.ifcTypeCode` is just the numeric form of
 * `ifcClass` — they are one query, not two, so only "same class" is offered.
 * Matching by the *type object* (all instances of "Basic Wall: Generic
 * 200mm") is a different feature: it needs an `IfcRelDefinesByType` lookup we
 * don't have on the identity. In practice a value-match on a type-inherited
 * row (Reference / TypeMark) already expresses it.
 */

import { isMatchable, type PropertySelector } from './matchValue';
import type { ElementIdentity, PropertyFlatRow, PropertyValue } from './types';

/**
 * A resolved "find everything like this" request. `kind` picks the worker
 * primitive: `class` needs only id enumeration, `value` runs the predicate.
 *
 * `ifcTypeCode` scopes the candidate set and is the NUMERIC code off the
 * source element. `null` means "every product" — used when the source is a
 * multi-selection whose members may not share a type.
 */
export type SimilarQuery =
  | {
      kind: 'class';
      modelId: string;
      ifcClass: string;
      ifcTypeCode: number;
      /** Human-readable summary, for the status line and menu labels. */
      label: string;
    }
  | {
      kind: 'value';
      modelId: string;
      ifcClass: string;
      ifcTypeCode: number | null;
      selector: PropertySelector;
      value: PropertyValue;
      label: string;
    };

/**
 * Can this row drive a value-match? Requires a matchable value AND a path —
 * the path is what identifies the property in candidate elements.
 */
export function canSelectSimilar(row: Pick<PropertyFlatRow, 'path' | 'rawValue'>): boolean {
  return row.path.length > 0 && isMatchable(row.rawValue);
}

/**
 * "Select every element like this one, by kind."
 *
 * When the element has a `PredefinedType` this narrows to it, because the
 * IFC class alone is coarser than what people mean by "the same kind of
 * thing": a Revit floor and a Revit structural foundation are BOTH IfcSlab,
 * separated only by PredefinedType (FLOOR vs BASESLAB). Selecting a
 * foundation and getting every floor slab in the model is not the ask. With
 * PredefinedType present this becomes a value match on `Identity.
 * PredefinedType`, still scoped to the class, so the extra precision costs
 * one property read per candidate of that class and nothing more.
 *
 * Without a PredefinedType, the plain class enumeration stands.
 */
export function classQuery(identity: ElementIdentity): SimilarQuery {
  const cls = identity.ifcClass || 'elements';
  const predefined = identity.predefinedType;
  if (predefined) {
    return {
      kind: 'value',
      modelId: identity.modelId,
      ifcClass: identity.ifcClass,
      ifcTypeCode: identity.ifcTypeCode,
      selector: { path: 'Identity.PredefinedType' },
      value: { kind: 'single', value: predefined, raw: { typeCode: 0, value: predefined } },
      label: `all ${cls} · ${predefined}`,
    };
  }
  return {
    kind: 'class',
    modelId: identity.modelId,
    ifcClass: identity.ifcClass,
    ifcTypeCode: identity.ifcTypeCode,
    label: `all ${cls}`,
  };
}

/**
 * "Select every element whose property at this path holds this value."
 * Returns null when the row can't drive a match, so callers can't
 * accidentally build a query that would select nothing.
 *
 * `scope` overrides the candidate set. It exists for the multi-selection
 * case: the rows there come from an intersection whose members may span
 * types, so there is no single type code to scope by and the search widens
 * to every product. The predicate is unchanged — only the candidate set is.
 */
export function valueQuery(
  identity: Pick<ElementIdentity, 'modelId' | 'ifcClass' | 'ifcTypeCode'>,
  row: Pick<PropertyFlatRow, 'path' | 'name' | 'rawValue' | 'displayValue'>,
  scope: { ifcTypeCode: number | null } = { ifcTypeCode: identity.ifcTypeCode },
): SimilarQuery | null {
  if (!canSelectSimilar(row)) return null;
  return {
    kind: 'value',
    modelId: identity.modelId,
    ifcClass: identity.ifcClass,
    ifcTypeCode: scope.ifcTypeCode,
    selector: { path: row.path },
    value: row.rawValue,
    label: `${row.name} = ${row.displayValue || '—'}`,
  };
}

/**
 * Turn the worker's bare expressIds into selection identities.
 *
 * Every match came from the query's own class, so class and type code are
 * known without a second round-trip — unlike the marquee path, which has to
 * leave them blank for the inspector to fill in later.
 */
export function identitiesFromIds(query: SimilarQuery, ids: readonly number[]): ElementIdentity[] {
  // An all-products query (ifcTypeCode null) genuinely doesn't know each
  // match's class, so it leaves the placeholders the marquee path also uses;
  // the inspector fills them in when the element is fetched.
  const typeCode = query.ifcTypeCode;
  return ids.map((expressId) => ({
    modelId: query.modelId,
    expressId,
    ifcClass: typeCode === null ? '' : query.ifcClass,
    ifcTypeCode: typeCode ?? 0,
  }));
}

/** Status-line text for a finished run. */
export function describeSimilarResult(query: SimilarQuery, count: number): string {
  if (count === 0) return `No elements match ${query.label}`;
  const noun = count === 1 ? 'element' : 'elements';
  return `Selected ${count} ${noun} — ${query.label}`;
}
