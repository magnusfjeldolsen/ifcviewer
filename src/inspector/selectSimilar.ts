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
      ifcTypeCode: number;
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

/** "Select every element of this element's class." */
export function classQuery(identity: ElementIdentity): SimilarQuery {
  return {
    kind: 'class',
    modelId: identity.modelId,
    ifcClass: identity.ifcClass,
    ifcTypeCode: identity.ifcTypeCode,
    label: `all ${identity.ifcClass || 'elements'}`,
  };
}

/**
 * "Select every element whose property at this path holds this value."
 * Returns null when the row can't drive a match, so callers can't
 * accidentally build a query that would select nothing.
 */
export function valueQuery(
  identity: ElementIdentity,
  row: Pick<PropertyFlatRow, 'path' | 'name' | 'rawValue' | 'displayValue'>,
): SimilarQuery | null {
  if (!canSelectSimilar(row)) return null;
  return {
    kind: 'value',
    modelId: identity.modelId,
    ifcClass: identity.ifcClass,
    ifcTypeCode: identity.ifcTypeCode,
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
  return ids.map((expressId) => ({
    modelId: query.modelId,
    expressId,
    ifcClass: query.ifcClass,
    ifcTypeCode: query.ifcTypeCode,
  }));
}

/** Status-line text for a finished run. */
export function describeSimilarResult(query: SimilarQuery, count: number): string {
  if (count === 0) return `No elements match ${query.label}`;
  const noun = count === 1 ? 'element' : 'elements';
  return `Selected ${count} ${noun} — ${query.label}`;
}
