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

export type ColourByState =
  | { phase: 'off' }
  | { phase: 'reading'; key: string; scope: ColourScope; done: number; total: number }
  | { phase: 'shown'; key: string; scope: ColourScope; plan: ColourPlan; ticked: boolean[]; palette: GradientPalette }
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
}

/** Timings of the last apply and clear, in ms, for the benchmark. */
export interface ColourByTimings {
  planMs: number;
  paintMs: number;
  clearMs: number;
}

export class ColourByController {
  private state: ColourByState = { phase: 'off' };
  private inputs: PlanModelInput[] = [];
  private palette: GradientPalette = DEFAULT_GRADIENT;
  /** Bumped by every start and clear: replies for an earlier colouring are dropped. */
  private generation = 0;
  private listeners: Array<() => void> = [];
  /** Reused per model, so ticking an entry allocates nothing. */
  private scratch = new Map<string, Float32Array>();
  readonly timings: ColourByTimings = { planMs: 0, paintMs: 0, clearMs: 0 };

  constructor(private readonly deps: ColourByDeps) {}

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

  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Colour by `key` over `scope`, ending any colouring shown now. Resolves
   * once the colours are on screen, or the reading failed or was overtaken.
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
    if (this.state.phase !== 'shown') return;
    const { key, scope, ticked } = this.state;
    this.show(key, scope, ticked);
  }

  /** Select the elements of one legend entry. */
  selectEntry(entry: number): void {
    if (this.state.phase !== 'shown' || !this.deps.select) return;
    const elements = entryElements(this.state.plan, entry);
    if (elements.length > 0) this.deps.select(elements);
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
    this.show(s.key, { kind: 'selection', elements }, null);
  }

  // ── internals ──────────────────────────────────────────────

  /** Build the plan for the current inputs and paint it. */
  private show(key: string, scope: ColourScope, ticked: boolean[] | null): void {
    const t0 = performance.now();
    const plan = buildColourPlan(key, this.inputs, { palette: this.palette });
    const t1 = performance.now();
    this.timings.planMs = t1 - t0;
    const keep = ticked && ticked.length === plan.entries.length ? ticked : plan.entries.map(() => true);
    this.state = { phase: 'shown', key, scope, plan, ticked: keep, palette: this.palette };
    this.repaint();
  }

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
    this.timings.paintMs = performance.now() - t0;
    this.emit();
  }

  /** Take the shown colours off the models. */
  private unpaint(): void {
    if (this.state.phase !== 'shown') return;
    const t0 = performance.now();
    for (const p of this.state.plan.models) this.deps.paint.clearDataColors(p.modelId);
    this.scratch.clear();
    this.timings.clearMs = performance.now() - t0;
  }

  private set(state: ColourByState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
