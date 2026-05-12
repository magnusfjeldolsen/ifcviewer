/**
 * Header rendering for the InspectorPanel.
 *
 * Two entry points, both pure (no panel-instance closure):
 *   - `renderHeader` — single-element selection. Populates title + subhead
 *     (class · tag, GUID, optional model name) and the count pill.
 *   - `renderMultiHeader` — multi-element selection. Title "N elements
 *     selected", subhead is the class mix, model row when all elements
 *     share one model, count pill is "X common properties" once the
 *     intersection result has arrived.
 *
 * Both write into panel-owned DOM slots passed in via the context object.
 * Refreshing the lock-row visibility happens via `ctx.refreshLockRow` —
 * the panel owns that DOM and its sync logic.
 *
 * Split out of `InspectorPanel.ts` to keep the panel file focused on
 * lifecycle + state-machine plumbing. No behavior change.
 */

import type { ElementIdentity, ElementProperties } from '../types';

/** Truncate the GUID at this many chars in the header. */
const GUID_TRUNCATE_AT = 20;

/** Truncate `s` to `n` chars with an ellipsis. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

/** Display title for an element. Prefers name; falls back to "<class> #<id>". */
function titleForIdentity(identity: ElementIdentity): string {
  if (identity.name && identity.name.trim() !== '') return identity.name;
  const cls = identity.ifcClass && identity.ifcClass !== '' ? identity.ifcClass : 'Element';
  return `${cls} #${identity.expressId}`;
}

/** Total leaf-row count (used for the header pill). */
function totalPropertyCount(props: ElementProperties): number {
  return props.flat.length;
}

/**
 * Summarize the ifcClass mix of a multi-selection for the subhead.
 *
 *   - All same class → "N IfcWall".
 *   - Mixed → "2 IfcWall · 1 IfcDoor" (sorted desc by count, then asc by name).
 */
function summarizeClassMix(identities: readonly ElementIdentity[]): string {
  const counts = new Map<string, number>();
  for (const id of identities) {
    const c = id.ifcClass && id.ifcClass !== '' ? id.ifcClass : 'Element';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  return entries.map(([cls, n]) => `${n} ${cls}`).join(' · ');
}

/**
 * Dependencies / DOM slots the header renderers need. Owned by the panel;
 * the renderer is given references rather than reaching back into the
 * panel instance.
 */
export interface HeaderRenderContext {
  titleEl: HTMLElement;
  subhead: HTMLElement;
  countPill: HTMLElement;
  getModelCount: () => number;
  getModelInfo: (modelId: string) => { name: string } | undefined;
  /** Copy `text` to clipboard, then briefly flash `el`. */
  copyWithFlash: (el: HTMLElement, text: string) => void;
  /** Re-evaluate the lock-row visibility (panel-owned). */
  refreshLockRow: (hasSelection: boolean) => void;
}

/**
 * Render the single-element header into the panel's header DOM slots.
 * `props` is null while the fetch is in flight — in that case the count
 * pill is cleared, identity rows still render.
 */
export function renderHeader(
  identity: ElementIdentity,
  props: ElementProperties | null,
  ctx: HeaderRenderContext,
): void {
  ctx.titleEl.textContent = titleForIdentity(identity);
  ctx.titleEl.title = titleForIdentity(identity);
  ctx.subhead.textContent = '';

  // Class · Tag row
  const classRow = document.createElement('div');
  classRow.className = 'inspector-class-row';
  const classSpan = document.createElement('span');
  classSpan.className = 'inspector-class';
  classSpan.textContent = identity.ifcClass && identity.ifcClass !== ''
    ? identity.ifcClass
    : 'Element';
  classRow.appendChild(classSpan);
  if (identity.tag) {
    const sep = document.createElement('span');
    sep.className = 'inspector-sep';
    sep.textContent = ' · ';
    classRow.appendChild(sep);
    const tagSpan = document.createElement('span');
    tagSpan.className = 'inspector-tag';
    tagSpan.textContent = `Tag ${identity.tag}`;
    classRow.appendChild(tagSpan);
  }
  ctx.subhead.appendChild(classRow);

  // GUID row
  if (identity.globalId) {
    const guidRow = document.createElement('div');
    guidRow.className = 'inspector-guid-row';
    const label = document.createElement('span');
    label.className = 'inspector-guid-label';
    label.textContent = 'GUID ';
    const guidBtn = document.createElement('button');
    guidBtn.className = 'inspector-guid-btn';
    guidBtn.type = 'button';
    guidBtn.textContent = truncate(identity.globalId, GUID_TRUNCATE_AT);
    guidBtn.title = `${identity.globalId} (click to copy)`;
    const guidText = identity.globalId;
    guidBtn.addEventListener('click', () => {
      ctx.copyWithFlash(guidBtn, guidText);
    });
    guidRow.appendChild(label);
    guidRow.appendChild(guidBtn);
    ctx.subhead.appendChild(guidRow);
  }

  // Model name row (only if more than one model loaded)
  const modelCount = ctx.getModelCount();
  if (modelCount > 1) {
    const info = ctx.getModelInfo(identity.modelId);
    if (info?.name) {
      const modelRow = document.createElement('div');
      modelRow.className = 'inspector-model-row';
      modelRow.textContent = info.name;
      modelRow.title = info.name;
      ctx.subhead.appendChild(modelRow);
    }
  }

  if (props) {
    const count = totalPropertyCount(props);
    ctx.countPill.textContent = `${count} ${count === 1 ? 'property' : 'properties'}`;
  } else {
    ctx.countPill.textContent = '';
  }

  ctx.refreshLockRow(/* hasSelection */ true);
}

/**
 * Render the multi-select header summary:
 *   - Title: "N elements selected".
 *   - Subhead: ifcClass mix (e.g. "2 IfcWall · 1 IfcDoor", or "3 IfcWall").
 *   - Single-model name row if all elements share one model and more
 *     than one model is loaded.
 *   - Count pill: "X common properties" (only once `synthetic` is supplied).
 *
 * `synthetic` is the intersection result; null while the fetch is in
 * flight or when over the soft cap (in which case the pill stays empty).
 */
export function renderMultiHeader(
  identities: readonly ElementIdentity[],
  synthetic: ElementProperties | null,
  ctx: HeaderRenderContext,
): void {
  const n = identities.length;
  ctx.titleEl.textContent = `${n} elements selected`;
  ctx.titleEl.title = `${n} elements selected`;
  ctx.subhead.textContent = '';

  // Class mix subhead.
  const classMix = summarizeClassMix(identities);
  const mixRow = document.createElement('div');
  mixRow.className = 'inspector-class-row inspector-multi-mix';
  const mixSpan = document.createElement('span');
  mixSpan.className = 'inspector-class';
  mixSpan.textContent = classMix;
  mixRow.appendChild(mixSpan);
  ctx.subhead.appendChild(mixRow);

  // Single-model row only when all share one model AND >1 models loaded.
  const firstModel = identities[0].modelId;
  const sharedModel = identities.every((i) => i.modelId === firstModel)
    ? firstModel
    : null;
  const modelCount = ctx.getModelCount();
  if (sharedModel && modelCount > 1) {
    const info = ctx.getModelInfo(sharedModel);
    if (info?.name) {
      const modelRow = document.createElement('div');
      modelRow.className = 'inspector-model-row';
      modelRow.textContent = info.name;
      modelRow.title = info.name;
      ctx.subhead.appendChild(modelRow);
    }
  }

  if (synthetic) {
    const count = totalPropertyCount(synthetic);
    ctx.countPill.textContent = `${count} common ${count === 1 ? 'property' : 'properties'}`;
  } else {
    ctx.countPill.textContent = '';
  }

  // Always re-evaluate the lock row visibility on every multi header pass.
  ctx.refreshLockRow(/* hasSelection */ true);
}
