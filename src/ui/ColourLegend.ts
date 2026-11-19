/**
 * The legend of a colouring by parameter (#68).
 *
 * Shown while a colouring is on; it says what is coloured by what, and
 * every colour in use with its value (and unit) and how many elements have
 * it. Each entry can be ticked off — its elements go back to their own
 * colours — with All / None above the list. Clicking an entry's text
 * selects its elements. Clear ends the colouring.
 *
 * Sits at the top right, under the memory toggle, and moves left of the
 * Parameters panel while that is open (in CSS), so it covers neither the
 * panel nor the inspector. The list is never longer than the plan's
 * entries, which the plan caps (see `colourByPlan.ts`), so nothing here
 * grows with the number of elements.
 */

import type { ColourByController, ColourByState, ColourScope } from '../inspector/ColourByController';
import { GRADIENTS, gradientCss, rgbToHex } from '../viewer/colourPalettes';
import { formatNumber } from '../inspector/format';

export interface ColourLegendDeps {
  controller: ColourByController;
  /** A model's name, as the Models panel shows it. */
  modelName(modelId: string): string;
}

const counts = new Intl.NumberFormat('en-US');

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
    // The legend is rebuilt on every change; keep the keyboard where it was.
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && this.container.contains(active) ? active.dataset.focus : undefined;
    this.build();
    if (focusKey) this.container.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`)?.focus();
  }

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
    scopeEl.textContent += ` · ${counts.format(plan.scopeSize)} element${plan.scopeSize === 1 ? '' : 's'}`;

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
      select.addEventListener('change', () => controller.setPalette(select.value));
      controls.appendChild(select);
    }
    this.body.appendChild(controls);

    const list = document.createElement('ul');
    list.className = 'colour-legend-entries';
    plan.entries.forEach((entry, i) => {
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
    });
    this.body.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'colour-legend-footer';
    footer.appendChild(this.button('Clear colours', 'Every element back to its own colour', () => controller.clear()));
    this.body.appendChild(footer);
  }

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
