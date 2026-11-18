/**
 * A filterable, sortable list of the parameters in a model (#67).
 *
 * Renders a `ModelParameters`. It knows nothing about panels or models: what
 * it needs from outside (all values of a parameter that has too many to keep,
 * and what to do when a value is picked) comes in through its options. That
 * is what lets the same list become the parameter picker for colouring (#68)
 * and aggregation (#69).
 *
 * Each row says what the parameter is (its path), how many of the scope's
 * elements carry it ("412 of 1,235"), what kind of values it holds, its
 * unit, and either its numeric range or how many distinct values it has.
 * The unit is the one the model states, "unit not stated" when it states
 * none, or "mixed units" when the values are in more than one: an opened
 * row then says which units and that the values are not added up.
 * Opening a row lists its values with element counts, most common first;
 * picking a value hands it to `onPickValue`.
 *
 * Nothing in the list scrolls sideways: long names and values are cut with
 * an ellipsis and carry their full text in a tooltip.
 */

import { formatNumber } from '../inspector/format';
import { canSum, isNotStated, sumVerdictText } from '../inspector/units';
import type { ValueCount } from '../inspector/parameterFold';
import type { ModelParameters, ParameterSummary, ParameterValue } from '../inspector/types';

export type ParameterSort = 'name' | 'count';

/** Values listed at once in an open row; the filter searches all of them. */
export const VALUES_SHOWN = 500;

/** An open row offers a value filter from this many values up. */
const VALUE_FILTER_FROM = 10;

const counts = new Intl.NumberFormat('en-US');

export interface ParameterListOptions {
  /**
   * Every distinct value of a parameter whose description did not keep them
   * (more than the cap, or unique per element). Without it, such a row says
   * its values are not available.
   */
  loadValues?(key: string, onProgress: (done: number, total: number) => void): Promise<ValueCount[]>;
  /** A value was picked. `additive` when Ctrl, Shift or Cmd was held. */
  onPickValue?(parameter: ParameterSummary, value: ParameterValue, additive: boolean): void;
  /**
   * A row was opened: a value is likely to be picked next, so whatever
   * picking needs can start getting ready.
   */
  onOpen?(parameter: ParameterSummary): void;
}

/** "412 of 1,235". */
export function countText(p: ParameterSummary, scopeSize: number): string {
  return `${counts.format(p.count)} of ${counts.format(scopeSize)}`;
}

const KIND_TEXT: Record<ParameterSummary['kind'], string> = {
  numeric: 'number',
  text: 'text',
  boolean: 'yes/no',
  mixed: 'mixed',
};

export function kindText(p: ParameterSummary): string {
  return KIND_TEXT[p.kind];
}

/**
 * The unit of a parameter's numbers: its symbol, "unit not stated" when the
 * model gives none, "mixed units" when they are in more than one, and
 * nothing for text or plain numbers.
 */
export function unitText(p: ParameterSummary): string {
  if (p.unitsDiffer) return 'mixed units';
  const only = p.units?.length === 1 ? p.units[0] : undefined;
  if (only && isNotStated(only.key)) return 'unit not stated';
  return p.unit ?? '';
}

/** A value as the list shows it. */
export function valueText(v: ParameterValue): string {
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v === '' ? '(empty)' : v;
}

/**
 * The spread of values: a numeric range, the one value they all share, how
 * many distinct values there are, or that every element has its own.
 */
export function spreadText(p: ParameterSummary): string {
  if (p.uniquePerElement) return 'unique per element';
  if (p.kind === 'numeric' && p.numeric) {
    const { min, max } = p.numeric;
    return min === max ? `all ${formatNumber(min)}` : `${formatNumber(min)} – ${formatNumber(max)}`;
  }
  if (p.distinct === null) return 'more than 200 values';
  if (p.distinct === 1 && p.values) {
    const v = p.values[0].value;
    return typeof v === 'string' ? `all "${valueText(v)}"` : `all ${valueText(v)}`;
  }
  return `${counts.format(p.distinct)} values`;
}

/** Filter by a case-insensitive substring of the key, then sort. */
export function visibleParameters(
  parameters: readonly ParameterSummary[],
  filter: string,
  sort: ParameterSort,
): ParameterSummary[] {
  const needle = filter.trim().toLowerCase();
  const out = needle ? parameters.filter((p) => p.key.toLowerCase().includes(needle)) : [...parameters];
  const byKey = (a: ParameterSummary, b: ParameterSummary): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  out.sort(sort === 'count' ? (a, b) => b.count - a.count || byKey(a, b) : byKey);
  return out;
}

/** Values whose shown text contains `filter` (case-insensitive), in their given order. */
export function filterValues(values: readonly ValueCount[], filter: string): ValueCount[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...values];
  return values.filter((v) => valueText(v.value).toLowerCase().includes(needle));
}

/** Where an open row's values come from, and how far loading them has got. */
interface ValuesState {
  values: ValueCount[] | null;
  progress: { done: number; total: number } | null;
  error: string | null;
}

let rowSerial = 0;

export class ParameterList {
  private container: HTMLElement;
  private filterInput: HTMLInputElement;
  private sortButtons: Record<ParameterSort, HTMLButtonElement>;
  private summaryEl: HTMLElement;
  private listEl: HTMLElement;
  private data: ModelParameters | null = null;
  private sort: ParameterSort = 'name';
  /** The one open row's key: one at a time keeps a narrow panel readable. */
  private openKey: string | null = null;
  private valueFilter = '';
  /** Values fetched on demand, per key, for the data shown. */
  private fetched = new Map<string, ValuesState>();
  /** Rendered rows by key, so opening one does not rebuild the list. */
  private rowEls = new Map<string, HTMLElement>();
  /** Re-renders the open row's value list (set while a row is open). */
  private refreshOpen: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly options: ParameterListOptions = {},
  ) {
    this.container = document.createElement('div');
    this.container.className = 'param-list';

    const controls = document.createElement('div');
    controls.className = 'param-list-controls';

    this.filterInput = document.createElement('input');
    this.filterInput.type = 'search';
    this.filterInput.className = 'param-list-filter';
    this.filterInput.placeholder = 'Filter parameters';
    this.filterInput.setAttribute('aria-label', 'Filter parameters');
    this.filterInput.addEventListener('input', () => this.render());

    const sortGroup = document.createElement('div');
    sortGroup.className = 'param-list-sort';
    sortGroup.setAttribute('role', 'group');
    sortGroup.setAttribute('aria-label', 'Sort parameters');
    const makeSort = (sort: ParameterSort, label: string, title: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'param-list-sort-btn';
      b.dataset.sort = sort;
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => this.setSort(sort));
      sortGroup.appendChild(b);
      return b;
    };
    this.sortButtons = {
      name: makeSort('name', 'Name', 'Sort by name'),
      count: makeSort('count', 'Count', 'Sort by number of elements, most first'),
    };

    controls.appendChild(this.filterInput);
    controls.appendChild(sortGroup);

    this.summaryEl = document.createElement('div');
    this.summaryEl.className = 'param-list-summary';

    this.listEl = document.createElement('ul');
    this.listEl.className = 'param-list-rows';

    this.container.appendChild(controls);
    this.container.appendChild(this.summaryEl);
    this.container.appendChild(this.listEl);
    parent.appendChild(this.container);
    this.setSort('name');
  }

  /**
   * Show these parameters, or nothing (null). Keeps the filter and sort; an
   * open row stays open while the same model's data is shown.
   */
  setData(data: ModelParameters | null): void {
    if (data?.modelId !== this.data?.modelId || data === null) {
      this.openKey = null;
      this.valueFilter = '';
      this.fetched.clear();
    }
    this.data = data;
    this.render();
  }

  setSort(sort: ParameterSort): void {
    this.sort = sort;
    for (const [key, b] of Object.entries(this.sortButtons)) {
      const on = key === sort;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    this.render();
  }

  setFilter(text: string): void {
    this.filterInput.value = text;
    this.render();
  }

  /** Open one row (or close all with null), as a click on its header does. */
  open(key: string | null): void {
    const previous = this.openKey;
    this.openKey = key;
    this.valueFilter = '';
    this.refreshOpen = null;
    if (previous !== null) this.rebuildRow(previous);
    if (key !== null) {
      this.rebuildRow(key);
      const p = this.data?.parameters.find((x) => x.key === key);
      if (p) this.options.onOpen?.(p);
    }
  }

  openRow(): string | null {
    return this.openKey;
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  dispose(): void {
    this.container.remove();
  }

  private render(): void {
    this.listEl.replaceChildren();
    this.rowEls.clear();
    this.refreshOpen = null;
    const data = this.data;
    this.container.classList.toggle('empty', data === null);
    if (!data) {
      this.summaryEl.textContent = '';
      return;
    }
    const shown = visibleParameters(data.parameters, this.filterInput.value, this.sort);
    const total = data.parameters.length;
    this.summaryEl.textContent =
      shown.length === total
        ? `${counts.format(total)} parameters`
        : `${counts.format(shown.length)} of ${counts.format(total)} parameters`;

    const frag = document.createDocumentFragment();
    for (const p of shown) {
      const li = this.row(p, data.scopeSize);
      this.rowEls.set(p.key, li);
      frag.appendChild(li);
    }
    this.listEl.appendChild(frag);
  }

  /** Replace one rendered row in place (when it opens or closes). */
  private rebuildRow(key: string): void {
    const old = this.rowEls.get(key);
    const p = this.data?.parameters.find((x) => x.key === key);
    if (!old || !p || !this.data) return;
    const li = this.row(p, this.data.scopeSize);
    old.replaceWith(li);
    this.rowEls.set(key, li);
  }

  private row(p: ParameterSummary, scopeSize: number): HTMLElement {
    const open = this.openKey === p.key;
    const li = document.createElement('li');
    li.className = open ? 'param-row open' : 'param-row';
    li.dataset.key = p.key;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'param-head';
    head.setAttribute('aria-expanded', String(open));
    head.addEventListener('click', () => {
      this.open(this.openKey === p.key ? null : p.key);
      this.rowEls.get(p.key)?.querySelector<HTMLButtonElement>('.param-head')?.focus();
    });

    const key = document.createElement('span');
    key.className = 'param-key';
    key.title = p.key;
    const dot = p.key.lastIndexOf('.');
    if (dot > 0) {
      const group = document.createElement('span');
      group.className = 'param-group';
      group.textContent = p.key.slice(0, dot + 1);
      key.appendChild(group);
    }
    const name = document.createElement('span');
    name.className = 'param-name';
    name.textContent = p.key.slice(dot + 1);
    key.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'param-meta';
    const parts: [string, string][] = [
      ['param-count', countText(p, scopeSize)],
      ['param-kind', kindText(p)],
      ['param-unit', unitText(p)],
      ['param-spread', spreadText(p)],
    ];
    for (const [cls, text] of parts) {
      if (!text) continue;
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      span.title = text;
      meta.appendChild(span);
    }

    head.appendChild(key);
    head.appendChild(meta);
    li.appendChild(head);

    if (open) {
      const panel = this.valuesPanel(p, scopeSize);
      panel.id = `param-values-${++rowSerial}`;
      head.setAttribute('aria-controls', panel.id);
      li.appendChild(panel);
    }
    return li;
  }

  /** The open row's body: range, value filter, values, and who lacks it. */
  private valuesPanel(p: ParameterSummary, scopeSize: number): HTMLElement {
    const body = document.createElement('div');
    body.className = 'param-values';

    if (p.numeric && p.kind === 'numeric') {
      const range = document.createElement('div');
      range.className = 'param-range';
      const unit = p.unit && !p.unitsDiffer ? ` ${p.unit}` : '';
      range.textContent = `min ${formatNumber(p.numeric.min)}${unit} · max ${formatNumber(p.numeric.max)}${unit}`;
      body.appendChild(range);
    }

    const unitNote = unitNoteText(p);
    if (unitNote) {
      const note = document.createElement('div');
      note.className = 'param-units-note';
      note.textContent = unitNote;
      body.appendChild(note);
    }

    if (p.uniquePerElement) {
      const note = document.createElement('div');
      note.className = 'param-values-note';
      note.textContent = 'Unique per element: every element has its own value. Type to find one.';
      body.appendChild(note);
    }

    const state = this.valuesFor(p);
    const many = p.uniquePerElement || p.distinct === null || (p.distinct ?? 0) >= VALUE_FILTER_FROM;
    let filter: HTMLInputElement | null = null;
    if (many) {
      filter = document.createElement('input');
      filter.type = 'search';
      filter.className = 'param-value-filter';
      filter.placeholder = 'Filter values';
      filter.setAttribute('aria-label', `Filter values of ${p.key}`);
      filter.value = this.valueFilter;
      filter.addEventListener('input', () => {
        this.valueFilter = filter!.value;
        draw();
      });
      body.appendChild(filter);
    }

    const status = document.createElement('div');
    status.className = 'param-values-status';
    const list = document.createElement('ul');
    list.className = 'param-value-list';
    body.appendChild(status);
    body.appendChild(list);

    const missing = scopeSize - p.count;
    if (missing > 0) {
      const without = document.createElement('div');
      without.className = 'param-values-without';
      without.textContent = `${counts.format(missing)} without this parameter`;
      body.appendChild(without);
    }

    const draw = (): void => {
      list.replaceChildren();
      status.textContent = '';
      if (state.error) {
        status.textContent = `Could not read the values: ${state.error}`;
        return;
      }
      if (!state.values) {
        status.textContent = state.progress
          ? `Reading values… ${counts.format(state.progress.done)} of ${counts.format(state.progress.total)} elements`
          : 'Reading values…';
        return;
      }
      // A unique-per-element parameter lists nothing until asked for something.
      if (p.uniquePerElement && !this.valueFilter.trim()) return;
      const matching = filterValues(state.values, this.valueFilter);
      const shown = matching.slice(0, VALUES_SHOWN);
      if (matching.length > shown.length) {
        status.textContent = this.valueFilter.trim()
          ? `Showing the ${counts.format(shown.length)} most common of ${counts.format(matching.length)} matching values; type more to narrow`
          : `Showing the ${counts.format(shown.length)} most common of ${counts.format(matching.length)}; type to filter`;
      } else if (matching.length === 0) {
        status.textContent = 'No value matches';
      }
      const unit = p.kind === 'numeric' && p.unit && !p.unitsDiffer ? ` ${p.unit}` : '';
      const frag = document.createDocumentFragment();
      for (const v of shown) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'param-value';
        const text = `${valueText(v.value)}${typeof v.value === 'number' ? unit : ''}`;
        b.title = this.options.onPickValue
          ? `${text}: select the ${counts.format(v.count)} element${v.count === 1 ? '' : 's'} (Ctrl or Shift adds to the selection)`
          : text;
        const label = document.createElement('span');
        label.className = 'param-value-text';
        label.textContent = text;
        const count = document.createElement('span');
        count.className = 'param-value-count';
        count.textContent = counts.format(v.count);
        b.appendChild(label);
        b.appendChild(count);
        if (this.options.onPickValue) {
          b.addEventListener('click', (e) => {
            this.options.onPickValue?.(p, v.value, e.ctrlKey || e.shiftKey || e.metaKey);
          });
        } else {
          b.disabled = true;
        }
        li.appendChild(b);
        frag.appendChild(li);
      }
      list.appendChild(frag);
    };
    this.refreshOpen = draw;
    draw();
    return body;
  }

  /**
   * The values of `p`: kept in the description when there were few enough,
   * otherwise fetched once through `loadValues` (and redrawn as it reports).
   */
  private valuesFor(p: ParameterSummary): ValuesState {
    if (p.values) return { values: p.values, progress: null, error: null };
    let state = this.fetched.get(p.key);
    if (state) return state;
    state = { values: null, progress: null, error: null };
    this.fetched.set(p.key, state);
    const s = state;
    const data = this.data;
    const redraw = (): void => {
      if (this.data === data && this.openKey === p.key) this.refreshOpen?.();
    };
    if (!this.options.loadValues) {
      s.error = 'not available here';
      return s;
    }
    this.options
      .loadValues(p.key, (done, total) => {
        s.progress = { done, total };
        redraw();
      })
      .then(
        (values) => {
          s.values = values;
          redraw();
        },
        (err: unknown) => {
          s.error = err instanceof Error ? err.message : String(err);
          // A failed fetch is not kept: opening the row again retries.
          if (this.fetched.get(p.key) === s) this.fetched.delete(p.key);
          redraw();
        },
      );
    return s;
  }
}

/**
 * What an opened numeric row says about its unit, when there is something
 * to say: that the values are in different units and are not added up
 * (with which units), or that the model does not state their unit.
 */
export function unitNoteText(p: ParameterSummary): string {
  if (!p.units || p.units.length === 0) return '';
  const verdict = canSum(p);
  if (!verdict.ok && verdict.reason === 'mixed-units') return sumVerdictText(verdict);
  if (verdict.ok && !verdict.unitStated) return 'The model does not state the unit of these values';
  return '';
}
