/**
 * "Show only" (#70): the small decisions behind the eye buttons on the
 * Parameters list's values, the colour legend's entries and the Totals
 * tab's group lines. The hiding itself is `AppearanceManager.showOnly`,
 * the same path as Isolate.
 *
 * Pure and DOM-free.
 */

import type { ParameterSummary, ParameterValue } from './types';
import { isNotStated, type UnitRef } from './units';

/**
 * The unit a value picked in one model's list must be in to match it in
 * another model: `undefined` when no unit applies (text, yes/no), the unit
 * key otherwise (3 mm never matches 3 m), and `null` when it can only match
 * in its own model. A unit the model does not state is that model's own
 * (ADR 4), so a value in one never matches another model's.
 */
export function crossModelUnitKey(
  p: Pick<ParameterSummary, 'units'>,
  value: ParameterValue,
  valueUnit?: UnitRef,
): string | undefined | null {
  if (typeof value !== 'number') return undefined;
  const key = valueUnit?.key ?? (p.units?.length === 1 ? p.units[0].key : undefined);
  if (key === undefined || isNotStated(key)) return null;
  return key;
}

/** The status line after a show-only. */
export function showOnlyStatus(label: string, result: { shown: number; fresh: boolean }, additive: boolean): string {
  const n = result.shown.toLocaleString('en-US');
  const noun = result.shown === 1 ? 'element' : 'elements';
  if (result.shown === 0) return `No elements match ${label}`;
  if (additive) return `Also showing ${n} ${noun} — ${label}`;
  if (result.fresh) return `None of the shown elements match ${label}: showing all ${n} that do`;
  return `Showing only ${n} ${noun} — ${label}`;
}

/** A show-only button's tooltip. */
export function showOnlyTitle(what: string): string {
  return `Show only ${what}, hide the rest (Ctrl or Shift: show them as well)`;
}
