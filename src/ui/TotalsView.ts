/**
 * The Totals tab (#69): count, sum, min, max and average of the parameters
 * the user added, over the selection or everything visible.
 *
 * Numbers first: each row shows all its statistics at once, with the unit.
 * Grouped by a parameter, each row becomes a small table with a bar behind
 * every line (by the statistic it is sorted by), or a share chart. Clicking
 * a line selects its elements; Copy puts the tables on the clipboard as
 * tab-separated text, which pastes into a spreadsheet.
 *
 * The state lives in `TotalsController`; this only draws it, and only while
 * the tab is shown.
 */

import {
  barFractions,
  mean,
  NO_VALUE_LABEL,
  pieSlices,
  sortLines,
  toTsv,
  type GroupLine,
  type Slice,
  type SortBy,
  type Stats,
  type Totals,
  type UnitTotals,
} from '../inspector/aggregate';
import type { TotalsChoice, TotalsController, TotalsRow, TotalsState } from '../inspector/TotalsController';
import { sumVerdictText, unitLabel } from '../inspector/units';
import { CATEGORY_COLOURS, OTHER_COLOUR } from '../viewer/colourPalettes';
import type { PickerRow } from './ParameterPicker';

/** A table with more lines than this gets a find box. */
export const TOTALS_FILTER_FROM = 20;
/** Lines drawn at once in one table; the find box finds the rest. */
export const TOTALS_LINES_SHOWN = 200;

export interface TotalsViewDeps {
  controller: TotalsController;
  /** The searchable parameter list (shared with "Colour by parameter…"). */
  picker: { open(x: number, y: number, heading: string, rows: readonly PickerRow[], onPick: (key: string) => void): void };
  modelName(modelId: string): string;
  /** Put text on the clipboard; resolves true when it worked. */
  copy?(text: string): Promise<boolean>;
}

const counts = new Intl.NumberFormat('en-US');
const significant = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

/** A statistic as shown: six significant digits, every digit of a large number. */
export function formatStat(n: number): string {
  if (!Number.isFinite(n)) return '–';
  return Math.abs(n) >= 1e6 ? whole.format(n) : significant.format(n);
}

/** "37 selected elements · 2 models", or "All visible: 1,235 elements". */
export function scopeHeading(scope: TotalsState['scope']): string {
  if (!scope) return 'Counting…';
  const n = `${counts.format(scope.elements)} element${scope.elements === 1 ? '' : 's'}`;
  const models = scope.models > 1 ? ` · ${scope.models} models` : '';
  if (scope.kind === 'selection') return `${counts.format(scope.elements)} selected element${scope.elements === 1 ? '' : 's'}${models}`;
  return `All visible: ${n}${models}`;
}

const STAT_COLUMNS: { by: SortBy; label: string; title: string }[] = [
  { by: 'count', label: 'n', title: 'How many elements have a value' },
  { by: 'sum', label: 'Sum', title: 'Sum' },
  { by: 'min', label: 'Min', title: 'Smallest value' },
  { by: 'max', label: 'Max', title: 'Largest value' },
  { by: 'mean', label: 'Avg', title: 'Average' },
];

const TEXT_COLUMNS: { by: SortBy; label: string; title: string }[] = [
  { by: 'count', label: 'n', title: 'How many elements have a value' },
  { by: 'distinct', label: 'Distinct', title: 'How many different values' },
];

/** The text of a choice in the pickers: kind, unit and how many have it. */
export function choiceText(c: TotalsChoice): string {
  const parts: string[] = [];
  if (c.kind === 'numeric') {
    parts.push('number');
    const units = c.units.filter((u) => u.count > 0);
    if (units.length === 1 && unitLabel(units[0])) parts.push(unitLabel(units[0]));
    else if (units.length > 1) parts.push(`${units.length} units`);
  } else if (c.kind === 'boolean') parts.push('yes/no');
  else if (c.kind === 'text') parts.push(c.distinct === null ? 'text' : `text · ${counts.format(c.distinct)} values`);
  else parts.push('mixed');
  parts.push(`${counts.format(c.count)} el.`);
  return parts.join(' · ');
}

/** Identifiers: one per element, so neither added up nor grouped by. */
const NOT_TOTALLED = new Set(['Identity.GlobalId', 'Identity.ExpressId']);

/** Group-by choices, most useful first: class and type, then text, then numbers. */
export function groupChoices(choices: readonly TotalsChoice[]): TotalsChoice[] {
  const first = ['Identity.IfcClass', 'Identity.Type', 'Identity.ObjectType', 'Identity.PredefinedType'];
  const rank = (c: TotalsChoice): number => {
    const i = first.indexOf(c.key);
    if (i >= 0) return i;
    return c.kind === 'numeric' ? 20 : 10;
  };
  return choices
    .filter((c) => !NOT_TOTALLED.has(c.key))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}

function shortKey(key: string): { group: string; name: string } {
  const dot = key.lastIndexOf('.');
  return dot > 0 ? { group: key.slice(0, dot + 1), name: key.slice(dot + 1) } : { group: '', name: key };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls: string, text: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

const SVG = 'http://www.w3.org/2000/svg';

function sliceColour(s: Slice): string {
  return s.colour < 0 ? OTHER_COLOUR : CATEGORY_COLOURS[s.colour % CATEGORY_COLOURS.length];
}

/** A donut of shares, each slice titled with its value and share (shown on hover). */
export function donut(slices: readonly Slice[], unit: string, size = 96): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'totals-donut');
  svg.setAttribute('viewBox', '-1 -1 2 2');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Share of the whole');
  let angle = -Math.PI / 2;
  const r = 0.95;
  const inner = 0.55;
  for (const s of slices) {
    if (s.share <= 0) continue;
    const sweep = Math.min(s.share, 0.99999) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (rad: number, a: number): string => `${(rad * Math.cos(a)).toFixed(5)} ${(rad * Math.sin(a)).toFixed(5)}`;
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute(
      'd',
      `M ${p(r, a0)} A ${r} ${r} 0 ${large} 1 ${p(r, a1)} L ${p(inner, a1)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, a0)} Z`,
    );
    path.setAttribute('fill', sliceColour(s));
    path.setAttribute('stroke', '#fff');
    path.setAttribute('stroke-width', '0.02');
    const title = document.createElementNS(SVG, 'title');
    title.textContent = `${s.label}: ${formatStat(s.value)}${unit ? ` ${unit}` : ''} (${percent.format(s.share)})`;
    path.appendChild(title);
    svg.appendChild(path);
  }
  return svg;
}

interface SortState {
  by: SortBy;
  descending: boolean;
}

export class TotalsView {
  private root: HTMLElement;
  private scopeEl: HTMLElement;
  private statusEl: HTMLElement;
  private progressEl: HTMLElement;
  private progressFill: HTMLElement;
  private groupBtn: HTMLButtonElement;
  private groupClear: HTMLButtonElement;
  private copyBtn: HTMLButtonElement;
  private rowsEl: HTMLElement;
  private shown = false;
  private unsubscribe: () => void;
  /** Per table ("row key|unit key"): how it is sorted. */
  private sorts = new Map<string, SortState>();
  /** Per table: the text in its find box. */
  private filters = new Map<string, string>();
  /** What Copy puts on the clipboard: built with the tables, in their order. */
  private copyRows: (string | number)[][] = [];
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: TotalsViewDeps) {
    this.root = el('div', 'totals');
    this.root.setAttribute('aria-label', 'Totals');

    const head = el('div', 'totals-head');
    this.scopeEl = el('div', 'totals-scope');
    this.scopeEl.setAttribute('role', 'status');
    this.scopeEl.setAttribute('aria-live', 'polite');

    const tools = el('div', 'totals-tools');
    const add = button('totals-add', '+ Add parameter', 'Add a parameter to count and add up', (e) =>
      void this.openAddPicker(e.currentTarget as HTMLElement),
    );
    const groupLabel = el('span', 'totals-group-label', 'Group by');
    this.groupBtn = button('totals-group-btn', 'None', 'Group every row by a parameter', (e) =>
      void this.openGroupPicker(e.currentTarget as HTMLElement),
    );
    this.groupClear = button('totals-group-clear', '×', 'Stop grouping', () => deps.controller.setGroupBy(null));
    this.groupClear.setAttribute('aria-label', 'Stop grouping');
    this.copyBtn = button('totals-copy', 'Copy', 'Copy the tables as text that pastes into a spreadsheet', () => void this.copy());
    const group = el('span', 'totals-group');
    group.append(groupLabel, this.groupBtn, this.groupClear);
    tools.append(add, group, this.copyBtn);

    this.statusEl = el('div', 'totals-status');
    this.progressEl = el('div', 'params-panel-progress hidden');
    this.progressFill = el('div', 'params-panel-progress-fill');
    this.progressEl.appendChild(this.progressFill);

    head.append(this.scopeEl, tools, this.statusEl, this.progressEl);
    this.rowsEl = el('div', 'totals-rows');
    this.root.append(head, this.rowsEl);

    this.unsubscribe = deps.controller.onChange(() => {
      if (this.shown) this.render();
    });
  }

  getElement(): HTMLElement {
    return this.root;
  }

  /** The tab was shown or hidden: the controller counts only while it is shown. */
  setShown(on: boolean): void {
    this.shown = on;
    this.deps.controller.setActive(on);
    if (on) this.render();
  }

  isShown(): boolean {
    return this.shown;
  }

  dispose(): void {
    this.unsubscribe();
    if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
    this.root.remove();
  }

  // ── pickers ────────────────────────────────────────────────

  private async loadChoices(): Promise<TotalsChoice[] | null> {
    this.setStatus('Reading parameters…');
    try {
      const choices = await this.deps.controller.choices((done, total) => {
        this.setStatus(`Reading parameters… ${counts.format(done)} of ${counts.format(total)} elements`);
        this.setProgress(total > 0 ? done / total : null);
      });
      this.setStatus('');
      this.setProgress(null);
      return choices;
    } catch (err) {
      this.setProgress(null);
      this.setStatus(`Could not read the parameters: ${err instanceof Error ? err.message : String(err)}`, true);
      return null;
    }
  }

  private async openAddPicker(anchor: HTMLElement): Promise<void> {
    const choices = await this.loadChoices();
    if (!choices) return;
    const c = this.deps.controller;
    // Numbers first: what is added up is what this tab is for.
    const rows = [...choices]
      .filter((x) => !c.hasRow(x.key) && !NOT_TOTALLED.has(x.key))
      .sort((a, b) => Number(b.kind === 'numeric') - Number(a.kind === 'numeric'))
      .map((x) => ({ key: x.key, value: choiceText(x) }));
    const r = anchor.getBoundingClientRect();
    this.deps.picker.open(r.left, r.bottom + 4, 'Add a parameter', rows, (key) => c.addRow(key));
  }

  private async openGroupPicker(anchor: HTMLElement): Promise<void> {
    const choices = await this.loadChoices();
    if (!choices) return;
    const rows = groupChoices(choices).map((x) => ({ key: x.key, value: choiceText(x) }));
    const r = anchor.getBoundingClientRect();
    this.deps.picker.open(r.left, r.bottom + 4, 'Group by', rows, (key) => this.deps.controller.setGroupBy(key));
  }

  // ── copy ───────────────────────────────────────────────────

  /** The tables as shown (sorted, filtered), as tab-separated text. */
  copyText(): string {
    const s = this.deps.controller.getState();
    const grouped = s.groupBy !== null;
    const header = ['Parameter', ...(grouped ? [shortKey(s.groupBy!).name] : []), 'Unit', 'Count', 'Sum', 'Min', 'Max', 'Average', 'Distinct'];
    return toTsv([[scopeHeading(s.scope)], [], header, ...this.copyRows.map((r) => (grouped ? r : [r[0], ...r.slice(2)]))]);
  }

  private async copy(): Promise<void> {
    if (!this.shown) return;
    this.render();
    const text = this.copyText();
    const ok = await (this.deps.copy ?? copyToClipboard)(text);
    this.copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
    if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => {
      this.copiedTimer = null;
      this.copyBtn.textContent = 'Copy';
    }, 1500);
  }

  // ── drawing ────────────────────────────────────────────────

  private setStatus(text: string, error = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('error', error);
  }

  private setProgress(fraction: number | null): void {
    this.progressEl.classList.toggle('hidden', fraction === null);
    if (fraction !== null) this.progressFill.style.width = `${Math.round(fraction * 100)}%`;
  }

  /** Draw the whole tab from the controller's state. */
  render(): void {
    const s = this.deps.controller.getState();
    this.scopeEl.textContent = scopeHeading(s.scope);

    const g = s.groupBy;
    this.groupBtn.textContent = g ? shortKey(g).name : 'None';
    this.groupBtn.title = g ? `Grouped by ${g}. Click to choose another.` : 'Group every row by a parameter';
    this.groupClear.classList.toggle('hidden', !g);

    if (s.message) this.setStatus(s.message, true);
    else if (s.describing) {
      this.setStatus(`Reading parameters… ${counts.format(s.describing.done)} of ${counts.format(s.describing.total)} elements`);
    } else if (s.groupReading) {
      this.setStatus(`Reading ${g ? shortKey(g).name : ''}… ${counts.format(s.groupReading.done)} of ${counts.format(s.groupReading.total)}`);
    } else if (!this.statusEl.classList.contains('error')) this.setStatus('');
    const p = s.describing ?? s.groupReading;
    this.setProgress(p && p.total > 0 ? p.done / p.total : null);

    // Keep the caret in a find box that is redrawn under it.
    const active = document.activeElement;
    const focusKey = active instanceof HTMLInputElement && this.root.contains(active) ? active.dataset.table : undefined;
    const caret = focusKey !== undefined ? (active as HTMLInputElement).selectionStart : null;

    this.copyRows = [];
    this.rowsEl.replaceChildren();
    if (s.rows.length === 0) {
      const empty = el(
        'div',
        'totals-empty',
        'Add a parameter to see its count, sum, min, max and average for what is selected, or for everything visible when nothing is. Σ on a row of the Parameters list adds it too.',
      );
      this.rowsEl.appendChild(empty);
    }
    for (const row of s.rows) this.rowsEl.appendChild(this.rowEl(row, s));
    this.copyBtn.disabled = s.rows.length === 0;

    if (focusKey !== undefined) {
      const input = this.rowsEl.querySelector<HTMLInputElement>(`input[data-table="${CSS.escape(focusKey)}"]`);
      if (input) {
        input.focus();
        if (caret !== null) input.setSelectionRange(caret, caret);
      }
    }
  }

  private rowEl(row: TotalsRow, s: TotalsState): HTMLElement {
    const section = el('section', 'totals-row');
    section.dataset.key = row.key;

    const head = el('div', 'totals-row-head');
    const name = el('span', 'totals-row-name');
    name.title = row.key;
    const { group, name: short } = shortKey(row.key);
    if (group) name.appendChild(el('span', 'totals-row-group', group));
    name.appendChild(el('span', 'totals-row-param', short));
    head.appendChild(name);

    const t = row.totals;
    if (s.groupBy && t && t.kind !== 'none') {
      const pie = row.chart === 'pie';
      const toggle = button('totals-chart-btn', pie ? '▤' : '◔', pie ? 'Show as a table with bars' : 'Show shares as a chart', () =>
        this.deps.controller.setChart(row.key, pie ? 'bars' : 'pie'),
      );
      toggle.setAttribute('aria-pressed', String(pie));
      toggle.setAttribute('aria-label', pie ? 'Show as a table' : 'Show as a share chart');
      head.appendChild(toggle);
    }
    const remove = button('totals-row-remove', '×', 'Remove this row', () => this.deps.controller.removeRow(row.key));
    remove.setAttribute('aria-label', `Remove ${row.key}`);
    head.appendChild(remove);
    section.appendChild(head);

    const body = el('div', 'totals-row-body');
    section.appendChild(body);

    if (row.phase === 'failed') {
      body.appendChild(el('div', 'totals-note error', `Could not read the values: ${row.message ?? ''}`));
      return section;
    }
    if (row.phase === 'reading' || !t) {
      const text = row.total > 0 ? `Reading values… ${counts.format(row.done)} of ${counts.format(row.total)}` : 'Reading values…';
      body.appendChild(el('div', 'totals-note', text));
      const bar = el('div', 'params-panel-progress');
      const fill = el('div', 'params-panel-progress-fill');
      fill.style.width = `${row.total > 0 ? Math.round((row.done / row.total) * 100) : 0}%`;
      bar.appendChild(fill);
      body.appendChild(bar);
      return section;
    }

    if (t.kind === 'none') {
      section.classList.add('absent');
      body.appendChild(
        el('div', 'totals-note quiet', s.scope?.kind === 'selection' ? 'Not in this selection' : 'Not in what is visible'),
      );
      return section;
    }

    if (t.withValue < t.scopeSize) {
      body.appendChild(
        el('div', 'totals-note', `${counts.format(t.withValue)} of ${counts.format(t.scopeSize)} have a value`),
      );
    }

    if (t.kind === 'numeric') this.numericBody(body, row, t, s);
    else this.textBody(body, row, t, s);
    return section;
  }

  private unitText(u: UnitTotals, several: boolean): string {
    const label = unitLabel(u.unit);
    if (u.modelId && several) return `${label} (${this.deps.modelName(u.modelId)})`;
    return label;
  }

  private numericBody(body: HTMLElement, row: TotalsRow, t: Totals, s: TotalsState): void {
    const several = t.numbers.length > 1;
    if (!t.verdict.ok) body.appendChild(el('div', 'totals-note warn', sumVerdictText(t.verdict)));
    for (const u of t.numbers) {
      const unit = this.unitText(u, several);
      const block = el('div', 'totals-unit');
      block.dataset.unit = u.key;
      block.appendChild(statsLine(u.stats, unit));
      body.appendChild(block);
      this.copyRows.push([row.key, '', unit, u.stats.count, u.stats.sum, u.stats.min, u.stats.max, mean(u.stats), '']);
      if (u.groups && s.groupBy) {
        const tableKey = `${row.key}|${u.key}`;
        if (row.chart === 'pie') block.appendChild(this.pieEl(u.groups, 'sum', unit, (line) => this.select(row.key, u.key, line)));
        block.appendChild(
          this.tableEl(tableKey, u.groups, STAT_COLUMNS, 'sum', row.chart === 'pie', (line) => this.select(row.key, u.key, line), (line) =>
            this.copyRows.push([
              row.key,
              line.label,
              unit,
              line.stats.count,
              line.stats.sum,
              line.stats.min,
              line.stats.max,
              mean(line.stats),
              '',
            ]),
          ),
        );
      }
    }
  }

  private textBody(body: HTMLElement, row: TotalsRow, t: Totals, s: TotalsState): void {
    if (t.kind === 'mixed') body.appendChild(el('div', 'totals-note warn', sumVerdictText(t.verdict)));
    const line = el('div', 'totals-stats');
    line.append(stat('Count', counts.format(t.withValue)), stat('Distinct', counts.format(t.distinct)));
    body.appendChild(line);
    this.copyRows.push([row.key, '', '', t.withValue, '', '', '', '', t.distinct]);
    if (t.groups && s.groupBy) {
      if (row.chart === 'pie') body.appendChild(this.pieEl(t.groups, 'count', '', (l) => this.select(row.key, undefined, l)));
      body.appendChild(
        this.tableEl(`${row.key}|`, t.groups, TEXT_COLUMNS, 'count', row.chart === 'pie', (l) => this.select(row.key, undefined, l), (l) =>
          this.copyRows.push([row.key, l.label, '', l.stats.count, '', '', '', '', l.distinct ?? '']),
        ),
      );
    }
  }

  private select(rowKey: string, unitKey: string | undefined, line: GroupLine): void {
    const n = this.deps.controller.selectLine(rowKey, { ...(unitKey !== undefined ? { unitKey } : {}), groupKey: line.key });
    if (n === 0) this.setStatus(`No element of ${line.label} has a value`);
  }

  /**
   * A grouped table: a header that sorts, one line per group with a bar
   * behind it (by the sorted statistic), capped with a find box.
   * `compact` (beside a share chart) leaves the bars out.
   */
  private tableEl(
    tableKey: string,
    lines: GroupLine[],
    columns: { by: SortBy; label: string; title: string }[],
    defaultSort: SortBy,
    compact: boolean,
    onPick: (line: GroupLine) => void,
    onCopy: (line: GroupLine) => void,
  ): HTMLElement {
    const wrap = el('div', compact ? 'totals-table compact' : 'totals-table');
    wrap.style.setProperty(
      '--totals-grid',
      columns === TEXT_COLUMNS ? 'minmax(60px, 1fr) 56px 64px' : 'minmax(60px, 1fr) 34px 64px 50px 50px 50px',
    );
    const sort = this.sorts.get(tableKey) ?? { by: defaultSort, descending: true };

    let shown = sortLines(lines, sort.by, sort.descending);
    if (lines.length > TOTALS_FILTER_FROM) {
      const find = el('input', 'totals-find');
      find.type = 'search';
      find.placeholder = `Find one of ${counts.format(lines.length)} groups`;
      find.setAttribute('aria-label', 'Find a group');
      find.dataset.table = tableKey;
      find.value = this.filters.get(tableKey) ?? '';
      find.addEventListener('input', () => {
        this.filters.set(tableKey, find.value);
        this.render();
      });
      wrap.appendChild(find);
      const needle = find.value.trim().toLowerCase();
      if (needle) shown = shown.filter((l) => l.label.toLowerCase().includes(needle));
    }
    for (const l of shown) onCopy(l);

    const header = el('div', 'totals-line totals-line-head');
    const groupName = this.deps.controller.getState().groupBy;
    const cols: { by: SortBy; label: string; title: string }[] = [
      { by: 'label', label: groupName ? shortKey(groupName).name : 'Group', title: 'Sort by name' },
      ...columns,
    ];
    for (const c of cols) {
      const active = sort.by === c.by;
      const h = button(
        active ? 'totals-sort active' : 'totals-sort',
        `${c.label}${active ? (sort.descending ? ' ↓' : ' ↑') : ''}`,
        `${c.title}: click to sort`,
        () => {
          const descending = sort.by === c.by ? !sort.descending : c.by !== 'label';
          this.sorts.set(tableKey, { by: c.by, descending });
          this.render();
        },
      );
      h.setAttribute('aria-sort', active ? (sort.descending ? 'descending' : 'ascending') : 'none');
      header.appendChild(h);
    }
    wrap.appendChild(header);

    const drawn = shown.slice(0, TOTALS_LINES_SHOWN);
    const bars = compact ? null : barFractions(drawn, sort.by);
    // Shares of the whole, for the hover text.
    const total = lines.reduce((n, l) => n + (columns === TEXT_COLUMNS ? l.stats.count : l.stats.sum), 0);
    drawn.forEach((line, i) => {
      const lineEl = el('div', line.label === NO_VALUE_LABEL ? 'totals-line none' : 'totals-line');
      lineEl.tabIndex = 0;
      lineEl.setAttribute('role', 'button');
      const value = columns === TEXT_COLUMNS ? line.stats.count : line.stats.sum;
      const share = total > 0 && value >= 0 ? ` (${percent.format(value / total)} of the whole)` : '';
      lineEl.title = `${line.label}: ${columns === TEXT_COLUMNS ? `${counts.format(value)} elements` : formatStat(value)}${share}. Click to select these elements.`;
      if (bars) {
        const bar = el('span', 'totals-bar');
        bar.style.width = `${(bars[i] * 100).toFixed(1)}%`;
        lineEl.appendChild(bar);
      }
      lineEl.appendChild(el('span', 'totals-cell totals-label', line.label));
      for (const c of columns) {
        const v = c.by === 'count' || c.by === 'distinct' ? counts.format(c.by === 'count' ? line.stats.count : (line.distinct ?? 0)) : formatStat(c.by === 'mean' ? mean(line.stats) : line.stats[c.by as keyof Stats]);
        lineEl.appendChild(el('span', 'totals-cell', v));
      }
      lineEl.addEventListener('click', () => onPick(line));
      lineEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick(line);
        }
      });
      wrap.appendChild(lineEl);
    });
    if (shown.length > drawn.length) {
      wrap.appendChild(
        el('div', 'totals-note', `Showing ${counts.format(drawn.length)} of ${counts.format(shown.length)}; type to narrow`),
      );
    } else if (shown.length === 0) wrap.appendChild(el('div', 'totals-note', 'No group matches'));
    return wrap;
  }

  /** A donut of each group's share of the sum (numbers) or count (text), with its key. */
  private pieEl(lines: GroupLine[], by: 'sum' | 'count', unit: string, onPick: (line: GroupLine) => void): HTMLElement {
    const slices = pieSlices(lines, by);
    if (!slices) {
      return el('div', 'totals-note', 'No share chart: some values are negative, or they add up to nothing.');
    }
    const wrap = el('div', 'totals-pie');
    wrap.appendChild(donut(slices, unit));
    const legend = el('ul', 'totals-pie-key');
    const byLabel = new Map(lines.map((l) => [l.label, l]));
    for (const s of slices) {
      const li = el('li', 'totals-pie-entry');
      li.title = `${s.label}: ${formatStat(s.value)}${unit ? ` ${unit}` : ''} (${percent.format(s.share)})`;
      const sw = el('span', 'totals-swatch');
      sw.style.background = sliceColour(s);
      li.append(sw, el('span', 'totals-pie-label', s.label), el('span', 'totals-pie-share', percent.format(s.share)));
      const line = byLabel.get(s.label);
      if (line && s.colour >= 0) {
        li.classList.add('pickable');
        li.addEventListener('click', () => onPick(line));
      }
      legend.appendChild(li);
    }
    wrap.appendChild(legend);
    return wrap;
  }
}

function stat(label: string, value: string, unit = ''): HTMLElement {
  const s = el('span', 'totals-stat');
  s.append(el('span', 'totals-stat-label', label), el('span', 'totals-stat-value', value));
  if (unit) s.appendChild(el('span', 'totals-stat-unit', unit));
  return s;
}

/** Sum first and largest, then count, min, max and average. */
function statsLine(st: Stats, unit: string): HTMLElement {
  const wrap = el('div', 'totals-numbers');
  const sum = el('div', 'totals-sum');
  sum.append(el('span', 'totals-sum-value', formatStat(st.sum)));
  if (unit) sum.append(el('span', 'totals-sum-unit', unit));
  sum.append(el('span', 'totals-sum-label', 'sum'));
  const line = el('div', 'totals-stats');
  line.append(
    stat('n', counts.format(st.count)),
    stat('min', formatStat(st.min)),
    stat('max', formatStat(st.max)),
    stat('avg', formatStat(mean(st))),
  );
  wrap.append(sum, line);
  return wrap;
}

/** Copy text through the Clipboard API, or the old way when that is not allowed. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
