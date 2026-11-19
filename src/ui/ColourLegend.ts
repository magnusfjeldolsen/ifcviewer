/**
 * The legend of a colouring by parameter (#68).
 *
 * Shown while a colouring is on; it says what is coloured by what, and
 * every colour in use with its value (and unit) and how many elements have
 * it. Each entry can be ticked off — its elements go back to their own
 * colours — with All / None above the list. Clicking an entry's text
 * selects its elements. Clear ends the colouring.
 *
 * Below the list: Refresh, which works the colours out again over what is
 * visible now (marked when what can be seen has changed), and Clear. For
 * text, a choice of how many of the most common values get a colour of
 * their own, up to every value; for numbers, a choice of colour scale.
 *
 * Sits at the top right, under the memory toggle, and moves left of the
 * Parameters panel while that is open (in CSS), so it covers neither the
 * panel nor the inspector. However many values there are, at most
 * `ENTRIES_SHOWN` rows are drawn; past `FILTER_FROM` a filter finds the
 * rest, so nothing here grows with the number of elements.
 */

import { DEFAULT_MAX_VALUES, type ColourByController, type ColourByState, type ColourScope } from '../inspector/ColourByController';
import { GRADIENTS, gradientCss, rgbToHex } from '../viewer/colourPalettes';
import { formatNumber } from '../inspector/format';

export interface ColourLegendDeps {
  controller: ColourByController;
  /** A model's name, as the Models panel shows it. */
  modelName(modelId: string): string;
}

const counts = new Intl.NumberFormat('en-US');

/** Where the keyboard goes when the control it was on is disabled. */
const FOCUS_NEIGHBOUR: Record<string, string[]> = {
  all: ['none', 'box-0'],
  none: ['all', 'box-0'],
};

/** The choices for how many values get a colour of their own. */
export const VALUE_COUNT_CHOICES: readonly number[] = [6, 12, 24, 50, 100, Infinity];

/** A legend with more entries than this gets a filter. */
export const FILTER_FROM = 20;

/** Rows drawn at once; the filter finds the rest. */
export const ENTRIES_SHOWN = 200;

const VALUE_COUNT_STORAGE = 'ifcviewer:colourValueCount';

/** The count of values with their own colour chosen last, or the default. */
export function loadColourValueCount(): number {
  try {
    const raw = localStorage.getItem(VALUE_COUNT_STORAGE);
    if (raw === 'all') return Infinity;
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_VALUES;
  } catch {
    return DEFAULT_MAX_VALUES;
  }
}

/** Remember the chosen count for the next colouring (this browser only). */
export function saveColourValueCount(n: number): void {
  try {
    localStorage.setItem(VALUE_COUNT_STORAGE, n === Infinity ? 'all' : String(n));
  } catch {
    // Storage blocked: the choice lasts until the page is reloaded.
  }
}

/** "1,235 elements", or "412 of 1,235 visible" when some could not be seen. */
export function countsText(coloured: number, total: number): string {
  if (coloured === total) return `${counts.format(total)} element${total === 1 ? '' : 's'}`;
  return `${counts.format(coloured)} of ${counts.format(total)} visible`;
}

/** "Whole model · Tower", or "Selection · 2 models". */
export function scopeText(scope: ColourScope, modelName: (id: string) => string): string {
  if (scope.kind === 'model') return `Whole model · ${modelName(scope.modelId)}`;
  const models = [...scope.elements.keys()];
  return models.length === 1 ? `Selection · ${modelName(models[0])}` : `Selection · ${models.length} models`;
}

export class ColourLegend {
  private container: HTMLElement;
  private body: HTMLElement;
  private titleName: HTMLElement;
  private unsubscribe: () => void;
  private clearanceObserver: ResizeObserver | null = null;

  constructor(
    parent: HTMLElement,
    private readonly deps: ColourLegendDeps,
  ) {
    this.container = document.createElement('section');
    this.container.className = 'colour-legend hidden';
    this.container.setAttribute('aria-label', 'Colour legend');

    const header = document.createElement('div');
    header.className = 'colour-legend-header';
    const title = document.createElement('span');
    title.className = 'colour-legend-title';
    title.textContent = 'Colour by';
    this.titleName = document.createElement('span');
    this.titleName.className = 'colour-legend-param';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'colour-legend-close';
    close.title = 'Clear colours';
    close.setAttribute('aria-label', 'Clear colours');
    close.textContent = '×';
    close.dataset.focus = 'close';
    close.addEventListener('click', () => deps.controller.clear());
    header.append(title, this.titleName, close);

    this.body = document.createElement('div');
    this.body.className = 'colour-legend-body';
    this.container.append(header, this.body);
    parent.appendChild(this.container);

    this.unsubscribe = deps.controller.onChange(() => this.render());
    this.render();
  }

  isOpen(): boolean {
    return !this.container.classList.contains('hidden');
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  /** Keep the bottom edge above `el` (the action tray), as the Parameters panel does. */
  keepClearOf(el: HTMLElement): void {
    const update = (): void => {
      this.container.style.setProperty('--legend-clearance', `${el.offsetHeight}px`);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    this.clearanceObserver?.disconnect();
    this.clearanceObserver = new ResizeObserver(update);
    this.clearanceObserver.observe(el);
  }

  dispose(): void {
    this.unsubscribe();
    this.clearanceObserver?.disconnect();
    this.container.remove();
  }

  private render(): void {
    const state = this.deps.controller.getState();
    const active = document.activeElement;
    const inLegend = active instanceof HTMLElement && this.container.contains(active);
    // A colouring starting: remember where it was asked for from, to give
    // the keyboard back there when it is cleared.
    if (state.phase === 'reading' && this.phase !== 'reading' && !inLegend) {
      this.origin = active instanceof HTMLElement && active !== document.body ? active : null;
      this.filter = '';
    }
    this.phase = state.phase;
    // The legend is rebuilt on every change; keep the keyboard where it was.
    const focusKey = inLegend ? (active as HTMLElement).dataset.focus : undefined;
    this.build();
    if (state.phase === 'off') {
      if (inLegend && this.origin?.isConnected) this.origin.focus();
      this.origin = null;
      return;
    }
    if (!focusKey) return;
    // A button that turned itself off (All once all are ticked) hands the
    // keyboard to its neighbour.
    for (const key of [focusKey, ...(FOCUS_NEIGHBOUR[focusKey] ?? [])]) {
      const el = this.container.querySelector<HTMLElement>(`[data-focus="${key}"]`);
      if (el && !(el as HTMLButtonElement).disabled) {
        el.focus();
        // A text box keeps typing at its end.
        if (el instanceof HTMLInputElement && el.type === 'search') el.setSelectionRange(el.value.length, el.value.length);
        return;
      }
    }
  }

  /** The phase last drawn, to tell a colouring starting from one updating. */
  private phase: ColourByState['phase'] = 'off';
  /** What had the keyboard when the colouring was asked for. */
  private origin: HTMLElement | null = null;

  private build(): void {
    const state = this.deps.controller.getState();
    this.container.classList.toggle('hidden', state.phase === 'off');
    this.body.replaceChildren();
    if (state.phase === 'off') return;

    const key = state.key;
    const dot = key.lastIndexOf('.');
    this.titleName.replaceChildren();
    if (dot > 0) {
      const group = document.createElement('span');
      group.className = 'colour-legend-group';
      group.textContent = key.slice(0, dot + 1);
      this.titleName.appendChild(group);
    }
    const name = document.createElement('span');
    name.className = 'colour-legend-name';
    name.textContent = key.slice(dot + 1);
    this.titleName.appendChild(name);
    this.titleName.title = key;

    const scope = document.createElement('div');
    scope.className = 'colour-legend-scope';
    scope.textContent = scopeText(state.scope, this.deps.modelName);
    this.body.appendChild(scope);

    if (state.phase === 'reading') {
      this.body.appendChild(this.status(
        state.total > 0
          ? `Reading values… ${counts.format(state.done)} of ${counts.format(state.total)} elements`
          : 'Reading values…',
      ));
      return;
    }
    if (state.phase === 'failed') {
      const s = this.status(`Could not colour by this parameter: ${state.message}`);
      s.classList.add('error');
      this.body.appendChild(s);
      return;
    }
    this.renderShown(state, scope);
  }

  private status(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'colour-legend-status';
    el.setAttribute('role', 'status');
    el.textContent = text;
    return el;
  }

  private renderShown(state: Extract<ColourByState, { phase: 'shown' }>, scopeEl: HTMLElement): void {
    const { plan, ticked, palette } = state;
    const controller = this.deps.controller;
    scopeEl.textContent += ` · ${countsText(plan.scopeSize, state.total)}`;

    if (plan.mode === 'gradient' && plan.range) {
      const scale = document.createElement('div');
      scale.className = 'colour-legend-scale';
      const bar = document.createElement('div');
      bar.className = 'colour-legend-bar';
      bar.style.background = gradientCss(palette);
      const ends = document.createElement('div');
      ends.className = 'colour-legend-ends';
      const unit = plan.range.unit ? ` ${plan.range.unit}` : '';
      const lo = document.createElement('span');
      lo.textContent = `${formatNumber(plan.range.min)}${unit}`;
      const hi = document.createElement('span');
      hi.textContent = `${formatNumber(plan.range.max)}${unit}`;
      ends.append(lo, hi);
      scale.append(bar, ends);
      this.body.appendChild(scale);
    }

    if (plan.note) {
      const note = document.createElement('div');
      note.className = 'colour-legend-note';
      note.textContent = plan.note;
      this.body.appendChild(note);
    }

    const controls = document.createElement('div');
    controls.className = 'colour-legend-controls';
    const all = this.button('All', 'Colour every entry', () => controller.setAllTicked(true));
    const none = this.button('None', 'Colour no entry: every element in its own colour', () =>
      controller.setAllTicked(false),
    );
    all.dataset.focus = 'all';
    none.dataset.focus = 'none';
    all.disabled = ticked.every(Boolean);
    none.disabled = !ticked.some(Boolean);
    controls.append(all, none);
    if (plan.mode !== 'categories') {
      const select = document.createElement('select');
      select.className = 'colour-legend-palette';
      select.setAttribute('aria-label', 'Colour scale');
      for (const g of GRADIENTS) {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.label;
        select.appendChild(opt);
      }
      select.value = palette.id;
      select.dataset.focus = 'palette';
      select.addEventListener('change', () => controller.setPalette(select.value));
      controls.appendChild(select);
    } else {
      // How many values get a colour of their own; the rest share one.
      const select = document.createElement('select');
      select.className = 'colour-legend-palette colour-legend-count-choice';
      select.setAttribute('aria-label', 'Values with a colour of their own');
      select.title = 'How many of the most common values get a colour of their own; the rest share one';
      for (const n of VALUE_COUNT_CHOICES) {
        const opt = document.createElement('option');
        opt.value = String(n);
        opt.textContent = n === Infinity ? 'All values' : `${n} most common`;
        select.appendChild(opt);
      }
      const current = state.maxValues;
      if (!VALUE_COUNT_CHOICES.includes(current)) {
        const opt = document.createElement('option');
        opt.value = String(current);
        opt.textContent = `${current} most common`;
        select.appendChild(opt);
      }
      select.value = String(current);
      select.dataset.focus = 'values';
      select.addEventListener('change', () => {
        const n = Number(select.value);
        saveColourValueCount(n);
        controller.setMaxValues(n);
      });
      controls.appendChild(select);
    }
    this.body.appendChild(controls);

    // With many entries, a filter, and at most ENTRIES_SHOWN rows drawn.
    let shownIndices = plan.entries.map((_, i) => i);
    if (plan.entries.length > FILTER_FROM) {
      const filter = document.createElement('input');
      filter.type = 'search';
      filter.className = 'colour-legend-filter';
      filter.placeholder = `Find one of ${counts.format(plan.entries.length)} values`;
      filter.setAttribute('aria-label', 'Find a value in the legend');
      filter.value = this.filter;
      filter.dataset.focus = 'filter';
      filter.addEventListener('input', () => {
        this.filter = filter.value;
        this.render();
      });
      this.body.appendChild(filter);
      const needle = this.filter.trim().toLowerCase();
      if (needle) shownIndices = shownIndices.filter((i) => plan.entries[i].label.toLowerCase().includes(needle));
    }
    const matching = shownIndices.length;
    shownIndices = shownIndices.slice(0, ENTRIES_SHOWN);
    if (matching > shownIndices.length || (matching === 0 && plan.entries.length > 0)) {
      this.body.appendChild(
        this.status(
          matching === 0
            ? 'No value matches'
            : `Showing ${counts.format(shownIndices.length)} of ${counts.format(matching)}; type to find the rest`,
        ),
      );
    }

    const list = document.createElement('ul');
    list.className = 'colour-legend-entries';
    for (const i of shownIndices) {
      const entry = plan.entries[i];
      const li = document.createElement('li');
      li.className = ticked[i] ? 'colour-legend-entry' : 'colour-legend-entry off';
      li.dataset.kind = entry.kind;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = ticked[i];
      box.dataset.focus = `box-${i}`;
      box.setAttribute('aria-label', `Colour ${entry.label}`);
      box.addEventListener('change', () => controller.setTicked(i, box.checked));
      const swatch = document.createElement('span');
      swatch.className = 'colour-legend-swatch';
      swatch.style.background = rgbToHex(entry.color);
      const text = document.createElement('button');
      text.type = 'button';
      text.className = 'colour-legend-label';
      text.textContent = entry.label;
      text.dataset.focus = `label-${i}`;
      text.title = `${entry.label}: select the ${counts.format(entry.count)} element${entry.count === 1 ? '' : 's'}`;
      text.addEventListener('click', () => controller.selectEntry(i));
      const count = document.createElement('span');
      count.className = 'colour-legend-count';
      count.textContent = counts.format(entry.count);
      li.append(box, swatch, text, count);
      list.appendChild(li);
    }
    this.body.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'colour-legend-footer';
    const refresh = this.button(
      'Refresh',
      state.stale
        ? 'What can be seen has changed since these colours were worked out: refresh to colour by what is visible now'
        : 'Work the colours out again over what is visible now',
      () => controller.refresh(),
    );
    refresh.dataset.focus = 'refresh';
    refresh.classList.add('colour-legend-refresh');
    if (state.stale) {
      refresh.classList.add('stale');
      refresh.setAttribute('aria-label', 'Refresh (out of date)');
    }
    const clear = this.button('Clear colours', 'Every element back to its own colour', () => controller.clear());
    footer.append(refresh, clear);
    this.body.appendChild(footer);
  }

  /** The legend's value filter, kept while the legend is redrawn. */
  private filter = '';

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'colour-legend-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }
}
