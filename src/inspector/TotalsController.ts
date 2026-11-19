/**
 * Totals (#69): what the Totals tab shows, kept up to date while it is open.
 *
 * The rows are parameters the user added; each shows the totals of that
 * parameter (`aggregate.ts`) over the scope: the selection when anything is
 * selected, otherwise everything that can be seen. One optional group-by
 * parameter splits every row into a table.
 *
 * Values come from the value columns the Parameters list and the colouring
 * use (built once per parameter in the worker, then kept), so following the
 * selection is a pass over typed arrays: a few milliseconds. A column not
 * built yet is asked for and its row shows progress; several asked for at
 * once are built in one read of the model (see `parameterDiscovery.ts`).
 *
 * Nothing runs while the tab is closed: changes only mark it out of date,
 * and builds it started are given up when it closes.
 *
 * The rows and the group-by are remembered by parameter key in this browser
 * (`totalsSettings.ts`), so the next visit is "select, read the number".
 */

import { aggregate, lineElements, type Totals, type TotalsInput } from './aggregate';
import { rowsInScope } from './colourByPlan';
import type { ColumnData, ParameterColumn } from './parameterColumn';
import { ColumnBuildCancelled } from './repository/ElementPropertyRepository';
import {
  loadTotalsSettings,
  MAX_TOTALS_ROWS,
  saveTotalsSettings,
  type SettingsStorage,
  type TotalsSettings,
} from './totalsSettings';
import type { ModelParameters, ParameterKind } from './types';
import type { UnitCount } from './units';

/** What the totals cover now. */
export type TotalsScope =
  | { kind: 'selection'; elements: ReadonlyMap<string, readonly number[]> }
  | { kind: 'visible' };

export interface TotalsDeps {
  /** The loaded models, in the Models panel's order. */
  models(): string[];
  /** Whether a model is switched on; a model switched off is not in "all visible". */
  isShown?(modelId: string): boolean;
  /** The selection, or "visible" when nothing is selected. */
  scope(): TotalsScope;
  /** Which of a model's elements can be seen now; null for all. */
  visibility?(modelId: string): ((expressId: number) => boolean) | null;
  /** The model's parameters (described once, then kept). */
  describe(modelId: string, onProgress?: (done: number, total: number) => void): Promise<ModelParameters>;
  /** The elements a model's columns are rows of, once it is described. */
  scopeIds(modelId: string): Int32Array | undefined;
  /** One parameter's value column (built once, then kept). */
  loadColumn(modelId: string, key: string, onProgress: (done: number, total: number) => void): Promise<ParameterColumn>;
  /** A build asked for is no longer needed. */
  releaseColumn(modelId: string, key: string): void;
  /** Select exactly these elements. */
  select?(elements: { modelId: string; expressId: number }[]): void;
  /** Where the rows are remembered; `localStorage` when left out. */
  storage?: SettingsStorage | null;
  /** How long to wait after a selection change before counting again (ms). */
  debounceMs?: number;
}

export interface TotalsRow {
  key: string;
  chart: 'bars' | 'pie';
  phase: 'reading' | 'ready' | 'failed';
  /** While reading: elements read so far, of `total`. */
  done: number;
  total: number;
  totals: Totals | null;
  message?: string;
}

export interface TotalsState {
  /** The tab is open. */
  active: boolean;
  /** What is counted: selected elements or all visible ones, how many, in how many models. */
  scope: { kind: 'selection' | 'visible'; elements: number; models: number } | null;
  /** Describing the models' parameters (first use only). */
  describing: { done: number; total: number } | null;
  /** Why the totals could not be worked out at all. */
  message: string | null;
  rows: TotalsRow[];
  groupBy: string | null;
  /** The group-by parameter's columns are being read. */
  groupReading: { done: number; total: number } | null;
}

/** One parameter as the add and group-by pickers list it, across models. */
export interface TotalsChoice {
  key: string;
  kind: ParameterKind;
  /** Elements with a value, across the models. */
  count: number;
  /** Units of the numbers (all models); empty for text. */
  units: UnitCount[];
  distinct: number | null;
}

export const TOTALS_DEBOUNCE_MS = 80;

/** What the timings of the last count were, for the benchmark. */
export interface TotalsTimings {
  /** From the start of a count until every row was worked out, ms (columns already read). */
  recomputeMs: number;
}

interface ModelScope {
  modelId: string;
  ids: Int32Array;
  rows: Int32Array | null;
  keys: ReadonlySet<string>;
}

export class TotalsController {
  private settings: TotalsSettings;
  private state: TotalsState;
  private listeners: Array<() => void> = [];
  /** Bumped by every count: replies for an earlier one are dropped. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The tab was closed while something changed: count again when it opens. */
  private dirty = true;
  /** Builds this asked for that have not finished: "model\nkey". */
  private inflight = new Set<string>();
  /** The scope of the last count, per model. */
  private scopes: ModelScope[] = [];
  /** The inputs each row was last counted from, for selecting a line's elements. */
  private inputs = new Map<string, TotalsInput[]>();
  private emitQueued = false;
  readonly timings: TotalsTimings = { recomputeMs: 0 };

  constructor(private readonly deps: TotalsDeps) {
    this.settings = loadTotalsSettings(deps.storage === undefined ? undefined : deps.storage);
    this.state = {
      active: false,
      scope: null,
      describing: null,
      message: null,
      rows: this.settings.rows.map((r) => newRow(r.key, r.chart === 'pie' ? 'pie' : 'bars')),
      groupBy: this.settings.groupBy,
      groupReading: null,
    };
  }

  getState(): TotalsState {
    return this.state;
  }

  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** The tab opened (true) or closed (false). Closed, nothing is counted or built. */
  setActive(on: boolean): void {
    if (this.state.active === on) return;
    this.state = { ...this.state, active: on };
    if (on) {
      if (this.dirty) void this.refresh();
      else this.emit();
      return;
    }
    this.cancelTimer();
    this.generation++;
    this.releaseAll();
    this.dirty = true;
    this.emit();
  }

  /**
   * The selection or what can be seen changed: count again shortly (the
   * changes of one gesture come together), or when the tab next opens.
   */
  invalidate(): void {
    this.dirty = true;
    if (!this.state.active) return;
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.deps.debounceMs ?? TOTALS_DEBOUNCE_MS);
  }

  /** A model is being closed: its columns go with it, so count again without it. */
  onModelRemoved(modelId: string): void {
    this.generation++;
    for (const k of [...this.inflight]) if (k.startsWith(`${modelId}\n`)) this.inflight.delete(k);
    this.scopes = this.scopes.filter((s) => s.modelId !== modelId);
    this.invalidate();
  }

  /** Add a parameter as a row (at the end), or leave it where it is when already there. */
  addRow(key: string): void {
    if (this.state.rows.some((r) => r.key === key)) return;
    if (this.state.rows.length >= MAX_TOTALS_ROWS) return;
    this.state = { ...this.state, rows: [...this.state.rows, newRow(key, 'bars')] };
    this.save();
    this.emit();
    if (this.state.active) void this.refresh();
    else this.dirty = true;
  }

  removeRow(key: string): void {
    if (!this.state.rows.some((r) => r.key === key)) return;
    this.state = { ...this.state, rows: this.state.rows.filter((r) => r.key !== key) };
    this.inputs.delete(key);
    this.save();
    this.releaseUnneeded();
    this.emit();
  }

  hasRow(key: string): boolean {
    return this.state.rows.some((r) => r.key === key);
  }

  /** Group every row by this parameter; null for no grouping. */
  setGroupBy(key: string | null): void {
    if (this.state.groupBy === key) return;
    this.state = { ...this.state, groupBy: key };
    this.save();
    if (this.state.active) void this.refresh();
    else {
      this.dirty = true;
      this.emit();
    }
  }

  /** Show a row's groups as bars or as a share chart. */
  setChart(key: string, chart: 'bars' | 'pie'): void {
    const rows = this.state.rows.map((r) => (r.key === key && r.chart !== chart ? { ...r, chart } : r));
    if (rows.every((r, i) => r === this.state.rows[i])) return;
    this.state = { ...this.state, rows };
    this.save();
    this.emit();
  }

  /**
   * Select the elements behind one line: those of row `key` with a value,
   * in the unit `unitKey` and group `groupKey` when given.
   */
  selectLine(key: string, line: { unitKey?: string; groupKey?: string }): number {
    const inputs = this.inputs.get(key);
    if (!inputs || !this.deps.select) return 0;
    const elements = lineElements(inputs, line);
    if (elements.length > 0) this.deps.select(elements);
    return elements.length;
  }

  /**
   * Every parameter of the loaded models, for the add and group-by pickers.
   * Describes the models that have not been (the first time only).
   */
  async choices(onProgress?: (done: number, total: number) => void): Promise<TotalsChoice[]> {
    const models = this.deps.models();
    const progress = models.map(() => ({ done: 0, total: 0 }));
    const described = await Promise.all(
      models.map((m, i) =>
        this.deps.describe(m, (done, total) => {
          progress[i] = { done, total };
          onProgress?.(
            progress.reduce((n, p) => n + p.done, 0),
            progress.reduce((n, p) => n + p.total, 0),
          );
        }),
      ),
    );
    const byKey = new Map<string, TotalsChoice>();
    for (const d of described) {
      for (const p of d.parameters) {
        const c = byKey.get(p.key);
        if (!c) {
          byKey.set(p.key, { key: p.key, kind: p.kind, count: p.count, units: [...(p.units ?? [])], distinct: p.distinct });
          continue;
        }
        c.count += p.count;
        if (c.kind !== p.kind) c.kind = 'mixed';
        for (const u of p.units ?? []) {
          const same = c.units.find((x) => x.key === u.key && !u.key.startsWith('?'));
          if (same) same.count += u.count;
          else c.units.push({ ...u });
        }
        c.distinct = c.distinct === null || p.distinct === null ? null : Math.max(c.distinct, p.distinct);
      }
    }
    return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  dispose(): void {
    this.cancelTimer();
    this.generation++;
    this.releaseAll();
    this.listeners = [];
  }

  // ── counting ───────────────────────────────────────────────

  /** Work every row out again over the scope as it is now. */
  async refresh(): Promise<void> {
    if (!this.state.active) {
      this.dirty = true;
      return;
    }
    this.cancelTimer();
    this.dirty = false;
    const gen = ++this.generation;
    const t0 = performance.now();
    const scope = this.deps.scope();
    const loaded = this.deps.models();
    const models =
      scope.kind === 'selection'
        ? loaded.filter((m) => scope.elements.has(m))
        : loaded.filter((m) => this.deps.isShown?.(m) ?? true);

    // Describe the models first (their scope is the columns' rows). Kept
    // after the first time, so this is normally immediate.
    const progress = models.map(() => ({ done: 0, total: 0 }));
    let describedNow = false;
    let described: ModelParameters[];
    try {
      described = await Promise.all(
        models.map((m, i) =>
          this.deps.describe(m, (done, total) => {
            if (gen !== this.generation) return;
            describedNow = true;
            progress[i] = { done, total };
            this.state = {
              ...this.state,
              describing: { done: progress.reduce((n, p) => n + p.done, 0), total: progress.reduce((n, p) => n + p.total, 0) },
            };
            this.emit();
          }),
        ),
      );
    } catch (err) {
      if (gen !== this.generation) return;
      this.state = { ...this.state, describing: null, message: `Could not read the parameters: ${errorText(err)}` };
      this.emit();
      return;
    }
    if (gen !== this.generation) return;

    this.scopes = models.flatMap((modelId, i) => {
      const ids = this.deps.scopeIds(modelId);
      if (!ids) return [];
      return [{ modelId, ids, rows: this.rowsOf(modelId, ids, scope), keys: new Set(described[i].parameters.map((p) => p.key)) }];
    });
    const elements =
      scope.kind === 'selection'
        ? [...scope.elements.values()].reduce((n, ids) => n + ids.length, 0)
        : this.scopes.reduce((n, s) => n + (s.rows ? s.rows.length : s.ids.length), 0);
    this.state = {
      ...this.state,
      scope: { kind: scope.kind, elements, models: models.length },
      describing: null,
      message: null,
    };
    this.releaseUnneeded();

    const groupBy = this.state.groupBy;
    const groupColumns = groupBy ? this.columnsFor(groupBy, gen, 'group') : Promise.resolve(new Map<string, ColumnData>());
    // Every row reports a failure of the group-by; with no rows nobody would.
    groupColumns.catch(() => {});
    const rowsDone = this.state.rows.map((row) => this.countRow(row.key, groupColumns, gen));
    this.emit();
    await Promise.all(rowsDone);
    if (gen !== this.generation) return;
    const t1 = performance.now();
    // Only a count that read nothing new says how quick following the selection is.
    if (!describedNow) {
      this.timings.recomputeMs = t1 - t0;
      try {
        performance.measure('totals: recompute', { start: t0, end: t1 });
      } catch {
        // Older engines: the timing is still in `timings`.
      }
    }
  }

  /** One row: its columns (and the group-by's), then the totals. */
  private async countRow(key: string, groupColumns: Promise<Map<string, ColumnData>>, gen: number): Promise<void> {
    let columns: Map<string, ColumnData>;
    let groups: Map<string, ColumnData>;
    try {
      [columns, groups] = await Promise.all([this.columnsFor(key, gen, key), groupColumns]);
    } catch (err) {
      if (gen !== this.generation) return;
      if (err instanceof ColumnBuildCancelled) {
        // Given up by someone else (the Parameters list closed the same
        // parameter) while this still wants it: ask again.
        this.invalidate();
        return;
      }
      this.updateRow(key, { phase: 'failed', totals: null, message: errorText(err) });
      return;
    }
    if (gen !== this.generation) return;
    const grouped = this.state.groupBy !== null;
    const inputs: TotalsInput[] = this.scopes.map((s) => {
      const input: TotalsInput = { modelId: s.modelId, ids: s.ids, rows: s.rows, column: columns.get(s.modelId) ?? null };
      if (grouped) input.group = groups.get(s.modelId) ?? null;
      return input;
    });
    this.inputs.set(key, inputs);
    this.updateRow(key, { phase: 'ready', totals: aggregate(inputs), done: 0, total: 0, message: undefined });
  }

  /**
   * The columns of `key` in every model of the scope that has it. `progressFor`
   * is the row to report reading progress on ('group': the group-by).
   */
  private async columnsFor(key: string, gen: number, progressFor: string): Promise<Map<string, ColumnData>> {
    const wanted = this.scopes.filter((s) => s.keys.has(key));
    const progress = wanted.map(() => ({ done: 0, total: 0 }));
    const report = (): void => {
      if (gen !== this.generation) return;
      const done = progress.reduce((n, p) => n + p.done, 0);
      const total = progress.reduce((n, p) => n + p.total, 0);
      if (progressFor === 'group') this.state = { ...this.state, groupReading: { done, total } };
      else this.updateRow(progressFor, { phase: 'reading', done, total });
    };
    let reading = false;
    const columns = await Promise.all(
      wanted.map(async (s, i) => {
        const id = `${s.modelId}\n${key}`;
        this.inflight.add(id);
        const p = this.deps.loadColumn(s.modelId, key, (done, total) => {
          reading = true;
          progress[i] = { done, total };
          report();
        });
        try {
          return await p;
        } finally {
          this.inflight.delete(id);
        }
      }),
    );
    if (reading && progressFor === 'group' && gen === this.generation) {
      this.state = { ...this.state, groupReading: null };
      this.emit();
    }
    const out = new Map<string, ColumnData>();
    wanted.forEach((s, i) => out.set(s.modelId, columns[i]));
    return out;
  }

  /** The rows of a model's scope that are in `scope`; null for all of them. */
  private rowsOf(modelId: string, ids: Int32Array, scope: TotalsScope): Int32Array | null {
    if (scope.kind === 'selection') return rowsInScope(ids, new Set(scope.elements.get(modelId) ?? []));
    const visible = this.deps.visibility?.(modelId);
    if (!visible) return null;
    const out = new Int32Array(ids.length);
    let k = 0;
    for (let i = 0; i < ids.length; i++) if (visible(ids[i])) out[k++] = i;
    return k === ids.length ? null : out.slice(0, k);
  }

  // ── internals ──────────────────────────────────────────────

  /** Give up builds asked for that no row (or the group-by) needs now. */
  private releaseUnneeded(): void {
    const needed = new Set(this.state.rows.map((r) => r.key));
    if (this.state.groupBy) needed.add(this.state.groupBy);
    const models = new Set(this.scopes.map((s) => s.modelId));
    for (const id of [...this.inflight]) {
      const [modelId, key] = splitId(id);
      if (needed.has(key) && models.has(modelId)) continue;
      this.inflight.delete(id);
      this.deps.releaseColumn(modelId, key);
    }
  }

  private releaseAll(): void {
    for (const id of [...this.inflight]) {
      const [modelId, key] = splitId(id);
      this.deps.releaseColumn(modelId, key);
    }
    this.inflight.clear();
    // Rows left reading show as such until the tab opens again.
  }

  private updateRow(key: string, patch: Partial<TotalsRow>): void {
    let changed = false;
    const rows = this.state.rows.map((r) => {
      if (r.key !== key) return r;
      changed = true;
      return { ...r, ...patch };
    });
    if (!changed) return;
    this.state = { ...this.state, rows };
    this.emit();
  }

  private save(): void {
    const settings: TotalsSettings = {
      rows: this.state.rows.map((r) => (r.chart === 'pie' ? { key: r.key, chart: 'pie' } : { key: r.key })),
      groupBy: this.state.groupBy,
    };
    this.settings = settings;
    saveTotalsSettings(settings, this.deps.storage === undefined ? undefined : this.deps.storage);
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Listeners hear once per turn, however many rows finished in it. */
  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      for (const l of this.listeners) l();
    });
  }
}

function newRow(key: string, chart: 'bars' | 'pie'): TotalsRow {
  return { key, chart, phase: 'reading', done: 0, total: 0, totals: null };
}

function splitId(id: string): [string, string] {
  const i = id.indexOf('\n');
  return [id.slice(0, i), id.slice(i + 1)];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
