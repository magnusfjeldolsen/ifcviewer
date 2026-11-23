/**
 * Colour by parameter (#68): one colouring at a time, from start to clear.
 *
 * `colourBy(key, scope)` reads the parameter's value column for each model
 * in the scope (built in the worker, see `parameterColumn.ts`), decides the
 * colours (`colourByPlan.ts`) and paints them through the renderer's data
 * colour layer: one call per model, each a single pass over typed arrays.
 *
 * The colouring is temporary and stands apart from everything else:
 *
 *  - it sits in a layer above the elements' own colour, so `clear()` brings
 *    back exactly what was there, whatever else had changed it;
 *  - hiding, transparency and the selection highlight are separate per
 *    element and keep working on coloured elements;
 *  - it is not in the undo history and is not saved with the session.
 *
 * It ends on `clear()`, when another colouring starts, or when the last of
 * its models is closed. A model closed from a colouring of several drops
 * out of it and the legend is recounted.
 *
 * Unticking a legend entry gives its elements back their own colours (they
 * are not hidden): what is left coloured is what is ticked.
 *
 * Only what can be seen when the colouring is worked out is coloured:
 * hidden elements, elements of a hidden model and elements wholly cut away
 * by the section plane are not counted, do not set a scale's ends and do not
 * take one of the colours. Something shown later keeps its own colour.
 * `refresh` works the same colouring out again over what is visible then
 * (for a selection: the same selected elements, those of them visible now);
 * `markStale` only says it may be out of date, so nothing recolours by
 * surprise.
 */

import type { ParameterColumn } from './parameterColumn';
import {
  buildColourPlan,
  entryElements,
  rowsInScope,
  tickedColours,
  type ColourPlan,
  type PlanModelInput,
} from './colourByPlan';
import { DEFAULT_GRADIENT, gradientById, type GradientPalette } from '../viewer/colourPalettes';

/** What to colour: a whole model, or the elements of a selection (any models). */
export type ColourScope =
  | { kind: 'model'; modelId: string }
  | { kind: 'selection'; elements: ReadonlyMap<string, readonly number[]> };

/**
 * What a colouring asked for from `modelId` covers. With two or more
 * elements selected, the selection; otherwise the whole of `modelId`.
 * `onlyThisModel` (the Parameters list, which is one model's list) keeps to
 * the selected elements of `modelId`, and to the whole model when fewer
 * than two of them are selected; from the right-click menu a selection
 * across models is coloured as one.
 */
export function colourScopeFor(
  selected: readonly { modelId: string; expressId: number }[],
  modelId: string,
  onlyThisModel: boolean,
): ColourScope {
  const chosen = onlyThisModel ? selected.filter((e) => e.modelId === modelId) : selected;
  if (chosen.length < 2) return { kind: 'model', modelId };
  const elements = new Map<string, number[]>();
  for (const { modelId: m, expressId } of chosen) {
    let ids = elements.get(m);
    if (!ids) elements.set(m, (ids = []));
    ids.push(expressId);
  }
  return { kind: 'selection', elements };
}

/** True when `state` is a colouring by `key` that covers elements of `modelId`. */
export function isColouringBy(state: ColourByState, key: string, modelId: string): boolean {
  if (state.phase === 'off' || state.key !== key) return false;
  return state.scope.kind === 'model' ? state.scope.modelId === modelId : state.scope.elements.has(modelId);
}

export type ColourByState =
  | { phase: 'off' }
  | { phase: 'reading'; key: string; scope: ColourScope; done: number; total: number }
  | {
      phase: 'shown';
      key: string;
      scope: ColourScope;
      plan: ColourPlan;
      ticked: boolean[];
      palette: GradientPalette;
      /** How many values get a colour of their own (Infinity: all). */
      maxValues: number;
      /** Elements in the scope, visible or not; \plan.scopeSize\ is those coloured. */
      total: number;
      /** What can be seen has changed since the colours were worked out. */
      stale: boolean;
    }
  | { phase: 'failed'; key: string; scope: ColourScope; message: string };

export interface ColourByDeps {
  /**
   * The value column of `key` in `modelId`, over the elements the viewer
   * draws (describing the model's parameters first when needed).
   */
  loadColumn(modelId: string, key: string, onProgress: (done: number, total: number) => void): Promise<ParameterColumn>;
  /** The renderer's data colour layer. */
  paint: {
    setDataColors(modelId: string, expressIds: ArrayLike<number>, rgb: Float32Array): void;
    clearDataColors(modelId: string): void;
  };
  /** Select exactly these elements (one undo step). */
  select?(elements: { modelId: string; expressId: number }[]): void;
  /**
   * Show only these elements, hiding the rest (#70); `additive`: show them
   * as well. `label` names them for the status line.
   */
  showOnly?(elements: { modelId: string; expressId: number }[], label: string, additive: boolean): void;
  /**
   * Which of a model's elements can be seen now; null or absent for all.
   * Only these are coloured, counted, and set a scale's ends.
   */
  visibility?(modelId: string): ((expressId: number) => boolean) | null;
}

/** Values that get a colour of their own, unless told otherwise. */
export const DEFAULT_MAX_VALUES = 12;

/**
 * Ticks carried from one plan to the next (another count of values, another
 * scale, a refresh): an entry keeps its tick when the new plan has an entry
 * with the same text; new entries start ticked.
 */
export function carryTicks(before: ColourPlan, ticked: readonly boolean[], after: ColourPlan): boolean[] {
  const was = new Map<string, boolean>();
  before.entries.forEach((e, i) => was.set(tickKey(e), ticked[i]));
  return after.entries.map((e) => was.get(tickKey(e)) ?? true);
}

function tickKey(e: { kind: string; label: string }): string {
  return e.kind === 'other' || e.kind === 'none' ? e.kind : `value:${e.label}`;
}

/** Timings of the last apply and clear, in ms, for the benchmark. */
export interface ColourByTimings {
  planMs: number;
  paintMs: number;
  clearMs: number;
}

/**
 * Anything that changes what can be seen (hide, isolate, show only, the
 * section plane) leaves the colours out of date: the legend says so, and
 * only Refresh works them out again.
 */
export function staleWhenVisibilityChanges(
  controller: Pick<ColourByController, 'markStale'>,
  sources: {
    appearance: { onChange(listener: () => void): unknown };
    clipping: { onStateChange(listener: () => void): unknown; onPlaneMoved(listener: () => void): unknown };
  },
): void {
  const stale = (): void => controller.markStale();
  sources.appearance.onChange(stale);
  sources.clipping.onStateChange(stale);
  sources.clipping.onPlaneMoved(stale);
}

export class ColourByController {
  private state: ColourByState = { phase: 'off' };
  /** Per model in the scope: its value column, and the scope's rows of it (null: all). */
  private inputs: PlanModelInput[] = [];
  private palette: GradientPalette = DEFAULT_GRADIENT;
  private maxValues: number;
  /** Bumped by every start and clear: replies for an earlier colouring are dropped. */
  private generation = 0;
  private listeners: Array<() => void> = [];
  /** Reused per model, so ticking an entry allocates nothing. */
  private scratch = new Map<string, Float32Array>();
  readonly timings: ColourByTimings = { planMs: 0, paintMs: 0, clearMs: 0 };

  constructor(
    private readonly deps: ColourByDeps,
    options: { maxValues?: number } = {},
  ) {
    this.maxValues = options.maxValues ?? DEFAULT_MAX_VALUES;
  }

  getState(): ColourByState {
    return this.state;
  }

  /** True while a colouring is shown or being read. */
  isActive(): boolean {
    return this.state.phase !== 'off';
  }

  /** The parameter being coloured by, or null. */
  activeKey(): string | null {
    return this.state.phase === 'off' ? null : this.state.key;
  }

  /** How many values get a colour of their own (Infinity: all). */
  getMaxValues(): number {
    return this.maxValues;
  }

  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Colour by `key` over the visible elements of `scope`, ending any
   * colouring shown now. Resolves once the colours are on screen, or the
   * reading failed or was overtaken.
   */
  async colourBy(key: string, scope: ColourScope): Promise<void> {
    this.unpaint();
    const gen = ++this.generation;
    const models = scope.kind === 'model' ? [scope.modelId] : [...scope.elements.keys()];
    const progress = models.map(() => ({ done: 0, total: 0 }));
    const reading = { phase: 'reading' as const, key, scope, done: 0, total: 0 };
    this.set(reading);
    let columns: ParameterColumn[];
    try {
      columns = await Promise.all(
        models.map((modelId, m) =>
          this.deps.loadColumn(modelId, key, (done, total) => {
            if (gen !== this.generation) return;
            progress[m] = { done, total };
            reading.done = progress.reduce((n, p) => n + p.done, 0);
            reading.total = progress.reduce((n, p) => n + p.total, 0);
            this.emit();
          }),
        ),
      );
    } catch (err) {
      if (gen !== this.generation) return;
      this.set({ phase: 'failed', key, scope, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (gen !== this.generation) return;
    this.inputs = columns.map((column) => ({
      column,
      rows:
        scope.kind === 'model'
          ? null
          : rowsInScope(column.ids, new Set(scope.elements.get(column.modelId) ?? [])),
    }));
    this.show(key, scope, null);
  }

  /**
   * Work the same colouring out again over what is visible now: same
   * parameter, same elements, scale and count of values; an entry whose
   * value is still there keeps its tick. The value columns are already
   * read, so this is as quick as the first colouring's last step.
   */
  refresh(): void {
    const s = this.state;
    if (s.phase !== 'shown') return;
    // Elements no longer visible lose their colour; the rest are repainted.
    this.unpaint();
    this.show(s.key, s.scope, s);
  }

  /**
   * What can be seen has changed (hidden, shown, isolated, cut): the colours
   * may be out of date. Only says so; `refresh` recolours.
   */
  markStale(): void {
    const s = this.state;
    if (s.phase !== 'shown' || s.stale) return;
    this.state = { ...s, stale: true };
    this.emit();
  }

  /** Tick or untick one legend entry. */
  setTicked(entry: number, on: boolean): void {
    if (this.state.phase !== 'shown' || this.state.ticked[entry] === on) return;
    this.state.ticked[entry] = on;
    this.repaint();
  }

  /** Tick every entry (true) or none (false). */
  setAllTicked(on: boolean): void {
    if (this.state.phase !== 'shown') return;
    this.state.ticked.fill(on);
    this.repaint();
  }

  /** Change the colour scale of a numeric colouring. */
  setPalette(id: string): void {
    this.palette = gradientById(id);
    const s = this.state;
    if (s.phase === 'shown') this.show(s.key, s.scope, s, false);
  }

  /**
   * How many of the most common values get a colour of their own; the rest
   * share one. Infinity gives every value its own colour.
   */
  setMaxValues(n: number): void {
    this.maxValues = n;
    const s = this.state;
    if (s.phase === 'shown') this.show(s.key, s.scope, s, false);
  }

  /** Select the elements of one legend entry. */
  selectEntry(entry: number): void {
    if (this.state.phase !== 'shown' || !this.deps.select) return;
    const elements = entryElements(this.state.plan, entry);
    if (elements.length > 0) this.deps.select(elements);
  }

  /** Whether legend entries can show only their elements. */
  canShowOnly(): boolean {
    return !!this.deps.showOnly;
  }

  /**
   * Show only the elements of one legend entry (#70): those it counted.
   * Hiding the rest makes the colouring out of date, as any hiding does.
   */
  showOnlyEntry(entry: number, additive: boolean): void {
    const s = this.state;
    if (s.phase !== 'shown' || !this.deps.showOnly) return;
    const e = s.plan.entries[entry];
    if (!e) return;
    const name = s.key.slice(s.key.lastIndexOf('.') + 1);
    this.deps.showOnly(entryElements(s.plan, entry), `${name}: ${e.label}`, additive);
  }

  /** End the colouring: every element is drawn as it was before. */
  clear(): void {
    this.generation++;
    if (this.state.phase === 'off') return;
    this.unpaint();
    this.inputs = [];
    this.set({ phase: 'off' });
  }

  /**
   * A model is being closed. Its elements leave the colouring (the
   * renderer drops their colours with the model); the legend is recounted
   * over what is left, or the colouring ends when nothing is.
   */
  onModelRemoved(modelId: string): void {
    const s = this.state;
    if (s.phase === 'off') return;
    const involved = s.scope.kind === 'model' ? s.scope.modelId === modelId : s.scope.elements.has(modelId);
    if (!involved) return;
    if (s.phase !== 'shown') {
      this.clear();
      return;
    }
    this.scratch.delete(modelId);
    this.inputs = this.inputs.filter((i) => i.column.modelId !== modelId);
    if (this.inputs.length === 0 || s.scope.kind === 'model') {
      this.clear();
      return;
    }
    const elements = new Map(s.scope.elements);
    elements.delete(modelId);
    // Recount without painting the closed model: the others are repainted
    // with the new plan, which may differ (a range can move).
    for (const p of s.plan.models) if (p.modelId !== modelId) this.deps.paint.clearDataColors(p.modelId);
    this.show(s.key, { kind: 'selection', elements }, s);
  }

  // ── internals ──────────────────────────────────────────────

  /** The scope's rows that are visible now, and how many rows the scope has in all. */
  private visibleInputs(): { inputs: PlanModelInput[]; total: number } {
    let total = 0;
    const inputs = this.inputs.map((input) => {
      const { column, rows } = input;
      const n = rows ? rows.length : column.ids.length;
      total += n;
      const visible = this.deps.visibility?.(column.modelId);
      if (!visible) return input;
      const out = new Int32Array(n);
      let k = 0;
      for (let i = 0; i < n; i++) {
        const row = rows ? rows[i] : i;
        if (visible(column.ids[row])) out[k++] = row;
      }
      return k === n ? input : { column, rows: out.slice(0, k) };
    });
    return { inputs, total };
  }

  /**
   * Build the plan over what is visible and paint it. `previous` carries its
   * ticks over; `revisit` false keeps the elements as they are (only the
   * colours change: another scale or count of values).
   */
  private show(
    key: string,
    scope: ColourScope,
    previous: Extract<ColourByState, { phase: 'shown' }> | null,
    revisit = true,
  ): void {
    const t0 = performance.now();
    let inputs: PlanModelInput[];
    let total: number;
    if (revisit || !previous) {
      ({ inputs, total } = this.visibleInputs());
      this.shownInputs = inputs;
    } else {
      inputs = this.shownInputs;
      total = previous.total;
    }
    const plan = buildColourPlan(key, inputs, { palette: this.palette, maxCategories: this.maxValues });
    const t1 = performance.now();
    this.timings.planMs = t1 - t0;
    measure('colour-by: plan', t0, t1);
    const ticked = previous ? carryTicks(previous.plan, previous.ticked, plan) : plan.entries.map(() => true);
    this.state = {
      phase: 'shown',
      key,
      scope,
      plan,
      ticked,
      palette: this.palette,
      maxValues: this.maxValues,
      total,
      stale: revisit ? false : (previous?.stale ?? false),
    };
    this.repaint();
  }

  /** The inputs the shown plan was built from (the visible rows). */
  private shownInputs: PlanModelInput[] = [];

  /** Paint the shown plan, entries that are not ticked in their own colours. */
  private repaint(): void {
    const s = this.state;
    if (s.phase !== 'shown') return;
    const t0 = performance.now();
    for (const p of s.plan.models) {
      let out = this.scratch.get(p.modelId);
      if (!out || out.length !== p.rgba.length) {
        out = new Float32Array(p.rgba.length);
        this.scratch.set(p.modelId, out);
      }
      this.deps.paint.setDataColors(p.modelId, p.ids, tickedColours(p, s.ticked, out));
    }
    const t1 = performance.now();
    this.timings.paintMs = t1 - t0;
    measure('colour-by: paint', t0, t1);
    this.emit();
  }

  /** Take the shown colours off the models. */
  private unpaint(): void {
    if (this.state.phase !== 'shown') return;
    const t0 = performance.now();
    for (const p of this.state.plan.models) this.deps.paint.clearDataColors(p.modelId);
    this.scratch.clear();
    const t1 = performance.now();
    this.timings.clearMs = t1 - t0;
    measure('colour-by: clear', t0, t1);
  }

  private set(state: ColourByState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** Record a span on the page's performance timeline, where the benchmark and DevTools read it. */
function measure(name: string, start: number, end: number): void {
  try {
    performance.measure(name, { start, end });
  } catch {
    // Older engines without the options form: the timing is still in `timings`.
  }
}
