/**
 * A filterable, sortable list of the parameters in a model (#67).
 *
 * Renders a `ModelParameters` and nothing else: it does not fetch, and it
 * knows nothing about panels or models. That is what lets the same list
 * become the parameter picker for colouring (#68) and aggregation (#69).
 *
 * Each row says what the parameter is (its path), how many of the scope's
 * elements carry it ("412 of 1,235"), what kind of values it holds, its
 * unit, and either its numeric range or how many distinct values it has.
 */

import { formatNumber } from '../inspector/format';
import type { ModelParameters, ParameterSummary, ParameterValue } from '../inspector/types';

export type ParameterSort = 'name' | 'count';

const counts = new Intl.NumberFormat('en-US');

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

/** The unit as the inspector shows it, or "mixed units" when elements differ. */
export function unitText(p: ParameterSummary): string {
  if (p.unitsDiffer) return 'mixed units';
  return p.unit ?? '';
}

function valueText(v: ParameterValue): string {
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

export class ParameterList {
  private container: HTMLElement;
  private filterInput: HTMLInputElement;
  private sortButtons: Record<ParameterSort, HTMLButtonElement>;
  private summaryEl: HTMLElement;
  private listEl: HTMLElement;
  private data: ModelParameters | null = null;
  private sort: ParameterSort = 'name';

  constructor(parent: HTMLElement) {
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

  /** Show these parameters, or nothing (null). Keeps the filter and sort. */
  setData(data: ModelParameters | null): void {
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

  getContainer(): HTMLElement {
    return this.container;
  }

  dispose(): void {
    this.container.remove();
  }

  private render(): void {
    this.listEl.replaceChildren();
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
    for (const p of shown) frag.appendChild(this.row(p, data.scopeSize));
    this.listEl.appendChild(frag);
  }

  private row(p: ParameterSummary, scopeSize: number): HTMLElement {
    const li = document.createElement('li');
    li.className = 'param-row';
    li.dataset.key = p.key;

    const key = document.createElement('div');
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

    const meta = document.createElement('div');
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
      meta.appendChild(span);
    }

    li.appendChild(key);
    li.appendChild(meta);
    return li;
  }
}
