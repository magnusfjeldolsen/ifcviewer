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
 * Two grains of "like this one", because they answer different questions:
 *
 *  - **category** — every beam in the model (IfcBeam, 121 of them in
 *    RIB.ifc). The IFC class, narrowed by `PredefinedType` where the element
 *    has one, since class alone is coarser than a Revit category: a floor and
 *    a structural foundation are BOTH IfcSlab, split only by FLOOR vs
 *    BASESLAB.
 *  - **type** — every beam of this section (SHS100x6.3, 30 of them). The
 *    authoring-tool family type, from the linked `IfcTypeObject`.
 *
 * Measured across the sample models: RIB.ifc carries both `ObjectType` and a
 * type object on all 121 beams, grouping them identically into 8 buckets;
 * Snowdon Towers carries a type object on all 54 columns and all 917 beams
 * and `ObjectType` on NONE of them. So the type object is the discriminator
 * and `ObjectType` is the fallback — see `typeSelector`.
 */

/** Longest property value shown inline in a menu label before eliding. */
const MENU_VALUE_MAX = 40;

function elide(s: string): string {
  return s.length <= MENU_VALUE_MAX ? s : `${s.slice(0, MENU_VALUE_MAX - 1)}…`;
}

/** "IfcSlab · BASESLAB", or just "IfcBeam" when there's no PredefinedType. */
export function categoryLabel(identity: ElementIdentity): string {
  const cls = identity.ifcClass || 'elements';
  return identity.predefinedType ? `${cls} · ${identity.predefinedType}` : cls;
}

/**
 * How to match "the same type", resolved against what this element actually
 * carries. Null when it carries neither.
 *
 * The linked `IfcTypeObject` is preferred because it is the only
 * discriminator present in every model measured: Snowdon Towers has a type
 * object on all 54 columns and all 917 beams but `ObjectType` on none of
 * them, while RIB.ifc has both (agreeing exactly). `ObjectType` remains as a
 * fallback for exports that carry it without a type object.
 */
export function typeSelector(
  identity: ElementIdentity,
): { path: string; value: string } | null {
  if (identity.typeName) return { path: 'Identity.Type', value: identity.typeName };
  if (identity.objectType) return { path: 'Identity.ObjectType', value: identity.objectType };
  return null;
}

/** The element's authoring-tool type, or null when it doesn't declare one. */
export function typeLabel(identity: ElementIdentity): string | null {
  return typeSelector(identity)?.value ?? null;
}

/** Menu row text for the category option. */
export function categoryMenuLabel(identity: ElementIdentity): string {
  return `Select all of this category · ${elide(categoryLabel(identity))}`;
}

/** Menu row text for the type option, or null when there's no type to offer. */
export function typeMenuLabel(identity: ElementIdentity): string | null {
  const label = typeLabel(identity);
  return label === null ? null : `Select all of this type · ${elide(label)}`;
}

/**
 * "Select every element of this element's category." With a PredefinedType
 * this is a value match on `Identity.PredefinedType` scoped to the class, so
 * the extra precision reuses the existing predicate rather than adding a
 * second mechanism; without one, the plain class enumeration stands.
 */
export function categoryQuery(identity: ElementIdentity): SimilarQuery {
  const predefined = identity.predefinedType;
  if (predefined) {
    return {
      kind: 'value',
      modelId: identity.modelId,
      ifcClass: identity.ifcClass,
      ifcTypeCode: identity.ifcTypeCode,
      selector: { path: 'Identity.PredefinedType' },
      value: { kind: 'single', value: predefined, raw: { typeCode: 0, value: predefined } },
      label: `all ${categoryLabel(identity)}`,
    };
  }
  return {
    kind: 'class',
    modelId: identity.modelId,
    ifcClass: identity.ifcClass,
    ifcTypeCode: identity.ifcTypeCode,
    label: `all ${categoryLabel(identity)}`,
  };
}

/**
 * "Select every element of this element's authoring-tool type." Null when the
 * element declares no `ObjectType` — there is nothing to match on, and an
 * option that always finds nothing is worse than no option.
 *
 * Scoped to the element's own class: two different classes sharing an
 * ObjectType string would otherwise be conflated, and the class scope also
 * keeps the candidate set small.
 */
export function typeQuery(identity: ElementIdentity): SimilarQuery | null {
  const sel = typeSelector(identity);
  if (!sel) return null;
  return {
    kind: 'value',
    modelId: identity.modelId,
    ifcClass: identity.ifcClass,
    ifcTypeCode: identity.ifcTypeCode,
    selector: { path: sel.path },
    value: { kind: 'single', value: sel.value, raw: { typeCode: 0, value: sel.value } },
    label: `all ${sel.value}`,
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
