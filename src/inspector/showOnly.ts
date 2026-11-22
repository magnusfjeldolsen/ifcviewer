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

/**
 * The status line after a show-only. `shown` counts what can be seen
 * afterwards; matches in a model switched off or behind the section plane
 * are said apart, since they cannot be.
 */
export function showOnlyStatus(
  label: string,
  result: { shown: number; fresh: boolean; switchedOff?: number; cutAway?: number },
  additive: boolean,
): string {
  const off = result.switchedOff ?? 0;
  const cut = result.cutAway ?? 0;
  const fmt = (k: number): string => k.toLocaleString('en-US');
  const unseen: string[] = [];
  if (off > 0) unseen.push(`${fmt(off)} in a model that is switched off`);
  if (cut > 0) unseen.push(`${fmt(cut)} behind the section cut`);
  if (result.shown === 0) {
    return unseen.length === 0 ? `No elements match ${label}` : `${label}: none can be seen — ${unseen.join(', ')}`;
  }
  const n = fmt(result.shown);
  const noun = result.shown === 1 ? 'element' : 'elements';
  const rest = unseen.length > 0 ? `; ${unseen.join(', ')}` : '';
  if (additive) return `Also showing ${n} ${noun} — ${label}${rest}`;
  if (result.fresh) return `None of the shown elements match ${label}: showing all ${n} that do${rest}`;
  return `Showing only ${n} ${noun} — ${label}${rest}`;
}

/** A show-only button's tooltip. */
export function showOnlyTitle(what: string): string {
  return `Show only ${what}, hide the rest (Ctrl or Shift: show them as well)`;
}
