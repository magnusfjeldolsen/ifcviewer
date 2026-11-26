/**
 * Keeps the Parameters list's counts in step with what can be seen (#115).
 *
 * Uses the rule the Totals tab uses (`visibility` in `TotalsController`: the
 * model switched on, the element not hidden, not cut away). Counts come from
 * the value columns that are already built, so a recount is a few passes over
 * typed arrays; it never asks for a column. Changes are debounced like the
 * Totals', and nothing runs while the list is not on screen: a change only
 * marks the counts out of date.
 */

import type { ParameterColumn } from './parameterColumn';
import { countVisibleColumns, visibleRows, type OpenDetail, type VisibleView } from './visibleCounts';

export const VISIBLE_COUNTS_DEBOUNCE_MS = 80;

export interface VisibleCountsDeps {
  /** The elements a model's columns are rows of; undefined before it is described. */
  scopeIds(modelId: string): Int32Array | undefined;
  /** Which of a model's elements can be seen now (the Totals tab's rule). */
  visibility(modelId: string): ((expressId: number) => boolean) | null;
  /** The columns of a model that are built now. */
  builtColumns(modelId: string): readonly ParameterColumn[];
  /** Whether a model is switched on; a model switched off is reported as such. */
  isShown?(modelId: string): boolean;
  /** The parameter whose values are listed now: only it is counted per value. */
  openParameter?(): OpenDetail | null;
  /** The counts changed: a view, or null when everything can be seen. */
  onView(view: VisibleView | null): void;
  debounceMs?: number;
}

export class VisibleCountsController {
  private modelId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** How long the last recount took, ms (for the benchmark). */
  lastMs = 0;

  constructor(private readonly deps: VisibleCountsDeps) {}

  /**
   * The model whose list is on screen; null when none is (nothing is
   * counted). Counts at once, so asking again after the model was described
   * picks up its scope.
   */
  watch(modelId: string | null): void {
    this.modelId = modelId;
    this.cancelTimer();
    if (modelId !== null) this.refresh();
  }

  /** What can be seen changed, or a column was built: recount shortly. */
  invalidate(): void {
    if (this.modelId === null) return;
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, this.deps.debounceMs ?? VISIBLE_COUNTS_DEBOUNCE_MS);
  }

  refresh(): void {
    this.cancelTimer();
    const modelId = this.modelId;
    if (modelId === null) return;
    const t0 = performance.now();
    const view = this.compute(modelId);
    this.lastMs = performance.now() - t0;
    try {
      performance.measure('parameters: visible recount', { start: t0, end: t0 + this.lastMs });
    } catch {
      // Older engines: the time is still in `lastMs`.
    }
    this.deps.onView(view);
  }

  dispose(): void {
    this.cancelTimer();
    this.modelId = null;
  }

  private compute(modelId: string): VisibleView | null {
    const ids = this.deps.scopeIds(modelId);
    if (!ids) return null;
    // A model switched off: say so, and count nothing.
    if (this.deps.isShown && !this.deps.isShown(modelId)) {
      return { modelId, off: true, elements: 0, total: ids.length, parameters: new Map() };
    }
    const visible = this.deps.visibility(modelId);
    if (!visible) return null;
    const rows = visibleRows(ids, visible);
    if (!rows) return null;
    const parameters = countVisibleColumns(this.deps.builtColumns(modelId), rows, this.deps.openParameter?.() ?? null);
    return { modelId, elements: rows.length, total: ids.length, parameters };
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** The things that change what can be seen, as subscriptions. */
export interface VisibilitySources {
  /** Hide, show, show only, transparency: any change of how elements look. */
  appearanceChanged(cb: () => void): unknown;
  /** A model switched on or off. */
  modelToggled(cb: () => void): unknown;
  /** The section plane was created or removed. */
  clipStateChanged(cb: () => void): unknown;
  /** The section plane's handle drag ended. */
  clipPlaneMoved(cb: () => void): unknown;
  /** No model is loading any more. */
  loadIdle(cb: () => void): unknown;
}

/** Recount `controller` whenever any of `sources` says what can be seen may have changed. */
export function followVisibility(sources: VisibilitySources, controller: Pick<VisibleCountsController, 'invalidate'>): void {
  const recount = (): void => controller.invalidate();
  sources.appearanceChanged(recount);
  sources.modelToggled(recount);
  sources.clipStateChanged(recount);
  sources.clipPlaneMoved(recount);
  sources.loadIdle(recount);
}
