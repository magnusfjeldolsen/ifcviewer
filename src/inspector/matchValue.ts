/**
 * Value-match predicate for `findMatching` (and, through it, "Select
 * similar"). Pure and DOM-free so the worker can import it.
 *
 * The selector names one property by the `PropertyFlatRow.path` the
 * inspector already uses everywhere ("Pset_WallCommon.LoadBearing",
 * "Identity.Tag") — no new identity concept enters the codebase. Matching
 * is **exact-path**: a candidate matches when its flat row at the same path
 * holds an equal value. Cross-class concept matching (a beam's
 * `Pset_BeamCommon.TypeMark` vs a column's `Pset_ColumnCommon.TypeMark`)
 * is deliberately out of scope for v1 — the paths differ.
 *
 * Only two `PropertyValue` kinds are matchable, per the confirmed decisions
 * in dev/plans/handoff-bulk-property-access.md:
 *
 *  - `single`     — strict scalar equality. `null` is excluded: a
 *                   present-but-null value is not a meaningful match target,
 *                   and "everything that also has no value here" is a
 *                   surprising selection.
 *  - `enumerated` — set equality of `values` (order-insensitive; IFC
 *                   enumerated values carry no meaningful order).
 *
 * Everything else is a non-match, by design rather than by omission:
 * `quantity` would need exact float equality (2.3401 ≠ 2.34 — fragile and
 * low-value); `list` / `table` / `complex` / `bounded` / `material-ref`
 * have no cheap, well-defined deep equality; `varies` is an intersection
 * sentinel and never appears on a real element. Callers (the "⌕ Select
 * similar" affordance) hide the entry point for unmatchable kinds rather
 * than offering an action that silently selects nothing.
 */

import type { ElementProperties, PropertyValue } from './types';

/** Identifies one property by its flat-row path. */
export interface PropertySelector {
  /** Dotted `PropertyFlatRow.path`, e.g. "Pset_WallCommon.LoadBearing". */
  path: string;
}

/**
 * True when this value can be used as a match target at all. The UI uses
 * this to decide whether to offer "Select similar" on a row; the worker
 * uses it to short-circuit a request that could never match anything.
 */
export function isMatchable(value: PropertyValue): boolean {
  if (value.kind === 'single') return value.value !== null;
  return value.kind === 'enumerated';
}

/**
 * Equality between a candidate's value and the match target. Non-matchable
 * kinds and kind mismatches are always false.
 */
export function valuesMatch(candidate: PropertyValue, target: PropertyValue): boolean {
  if (!isMatchable(target)) return false;
  if (candidate.kind !== target.kind) return false;

  if (candidate.kind === 'single' && target.kind === 'single') {
    // Strict equality — no coercion. `propertyNormalizer` has already run
    // on both sides (both came through `fetchElementProperties`), so a
    // numeric measure is a number on both sides and a label is a string.
    return candidate.value !== null && candidate.value === target.value;
  }

  if (candidate.kind === 'enumerated' && target.kind === 'enumerated') {
    if (candidate.values.length !== target.values.length) return false;
    const targetSet = new Set(target.values);
    for (const v of candidate.values) {
      if (!targetSet.has(v)) return false;
    }
    return true;
  }

  return false;
}

/**
 * Does this element match `selector == value`?
 *
 * Present-and-equal only: an element with no row at `selector.path` is not
 * a match (rather than matching a "missing" target).
 */
export function elementMatches(
  props: ElementProperties,
  selector: PropertySelector,
  value: PropertyValue,
): boolean {
  const row = props.flat.find((r) => r.path === selector.path);
  if (!row) return false;
  return valuesMatch(row.rawValue, value);
}
