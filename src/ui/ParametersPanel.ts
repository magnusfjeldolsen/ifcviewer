/**
 * The "Parameters" panel: what parameters one loaded model has (#67).
 *
 * Opened from a model's row in the Models panel. Shows one model at a time;
 * with several loaded, a picker in the header switches between them. While
 * discovery runs it says how far it has got; the viewer stays usable
 * throughout, since the work happens in the IFC worker in short steps.
 *
 * The list itself is `ParameterList`, which knows nothing about this panel.
 */

import type { ValueCount } from '../inspector/parameterFold';
import type { ModelParameters, ParameterSummary, ParameterValue } from '../inspector/types';
import { ParameterList } from './ParameterList';
import type { UnitRef } from '../inspector/units';

export interface ParametersPanelDeps {
  /** The loaded models, in the order the Models panel shows them. */
  getModels(): { id: string; name: string }[];
  /**
   * Describe one model's parameters, reporting elements read so far.
   * `onStarted` is called once reading begins (after any running load).
   */
  describe(
    modelId: string,
    onProgress: (done: number, total: number) => void,
    onStarted?: () => void,
  ): Promise<ModelParameters>;
  /** Whether a model is loading right now: discovery waits for it. */
  isLoading?(): boolean;
  /** Every distinct value of one parameter, for one that has too many to keep. */
  loadValues?(
    modelId: string,
    key: string,
    onProgress: (done: number, total: number) => void,
  ): Promise<ValueCount[]>;
  /** Select the model's elements that have `value` at this parameter. */
  selectValue?(
    modelId: string,
    parameter: ParameterSummary,
    value: ParameterValue,
    additive: boolean,
    unit?: UnitRef,
  ): void;
  /** Show only the elements with `value` at this parameter, in every loaded model (#70). */
  showOnlyValue?(
    modelId: string,
    parameter: ParameterSummary,
    value: ParameterValue,
    additive: boolean,
    unit?: UnitRef,
  ): void;
  /**
   * A parameter was opened: get ready to list and select its values (the
   * viewer builds its value column in the background).
   */
  prepare?(modelId: string, parameter: ParameterSummary): void;
  /** The parameter was closed again before a value was picked: what `prepare` started can stop. */
  release?(modelId: string, parameter: ParameterSummary): void;
  /** Colour the elements by this parameter (#68). */
  colourBy?(modelId: string, parameter: ParameterSummary): void;
  /**
   * The Totals tab (#69), shown beside the list. Told when it is shown and
   * hidden: it works only while shown.
   */
  totals?: { getElement(): HTMLElement; setShown(on: boolean): void };
  /** Add a parameter as a row of the Totals tab (the list's Σ button). */
  addToTotals?(parameter: ParameterSummary): void;
}

export type ParametersTab = 'parameters' | 'totals';

const counts = new Intl.NumberFormat('en-US');

export class ParametersPanel {
  private container: HTMLElement;
  private modelSelect: HTMLSelectElement;
  private titleModel: HTMLElement;
  private statusEl: HTMLElement;
  private progressEl: HTMLElement;
  private progressFill: HTMLElement;
  private list: ParameterList;
  private modelId: string | null = null;
  /** The parameter elements are coloured by, and the models that colouring covers. */
  private coloured: { key: string; models: ReadonlySet<string> } | null = null;
  /** Bumped on every open: replies for an earlier one are dropped. */
  private generation = 0;
  private clearanceObserver: ResizeObserver | null = null;
  private tab: ParametersTab = 'parameters';
  private tabButtons = new Map<ParametersTab, HTMLButtonElement>();
  private paramsBody: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly deps: ParametersPanelDeps,
  ) {
    this.container = document.createElement('section');
    this.container.className = 'params-panel hidden';
    this.container.setAttribute('aria-label', 'Parameters');

    const header = document.createElement('div');
    header.className = 'params-panel-header';
    let title: HTMLElement;
    if (deps.totals) {
      // Two tabs: the model's parameters, and totals over the selection.
      title = document.createElement('div');
      title.className = 'params-panel-tabs';
      title.setAttribute('role', 'tablist');
      for (const [tab, text] of [
        ['parameters', 'Parameters'],
        ['totals', 'Totals'],
      ] as const) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'params-panel-tab';
        b.dataset.tab = tab;
        b.setAttribute('role', 'tab');
        b.textContent = text;
        b.addEventListener('click', () => this.showTab(tab));
        title.appendChild(b);
        this.tabButtons.set(tab, b);
      }
      // The tabs pattern: one tab is in the Tab order; the arrow keys, Home
      // and End move between tabs and show the one they land on.
      title.addEventListener('keydown', (e) => {
        const order: ParametersTab[] = ['parameters', 'totals'];
        const i = order.indexOf(this.tab);
        let next: ParametersTab | null = null;
        if (e.key === 'ArrowRight') next = order[(i + 1) % order.length];
        else if (e.key === 'ArrowLeft') next = order[(i + order.length - 1) % order.length];
        else if (e.key === 'Home') next = order[0];
        else if (e.key === 'End') next = order[order.length - 1];
        if (next === null) return;
        e.preventDefault();
        this.showTab(next);
        this.tabButtons.get(this.tab)?.focus();
      });
    } else {
      title = document.createElement('span');
      title.className = 'params-panel-title';
      title.textContent = 'Parameters';
    }
    this.titleModel = document.createElement('span');
    this.titleModel.className = 'params-panel-model';

    this.modelSelect = document.createElement('select');
    this.modelSelect.className = 'params-panel-select';
    this.modelSelect.setAttribute('aria-label', 'Model');
    this.modelSelect.addEventListener('change', () => this.open(this.modelSelect.value));

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'params-panel-close';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close parameters');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.close());

    header.appendChild(title);
    header.appendChild(this.titleModel);
    header.appendChild(this.modelSelect);
    header.appendChild(closeBtn);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'params-panel-status';
    this.statusEl.setAttribute('role', 'status');

    this.progressEl = document.createElement('div');
    this.progressEl.className = 'params-panel-progress hidden';
    this.progressFill = document.createElement('div');
    this.progressFill.className = 'params-panel-progress-fill';
    this.progressEl.appendChild(this.progressFill);

    this.container.appendChild(header);
    // The Parameters tab's body; the Totals tab's sits beside it.
    this.paramsBody = document.createElement('div');
    this.paramsBody.className = 'params-panel-body';
    this.paramsBody.setAttribute('role', 'tabpanel');
    this.container.appendChild(this.paramsBody);
    this.paramsBody.appendChild(this.statusEl);
    this.paramsBody.appendChild(this.progressEl);
    if (deps.totals) {
      const totalsEl = deps.totals.getElement();
      totalsEl.classList.add('params-panel-body', 'hidden');
      totalsEl.setAttribute('role', 'tabpanel');
      this.container.appendChild(totalsEl);
    }
    this.list = new ParameterList(this.paramsBody, {
      loadValues: deps.loadValues
        ? (key, onProgress) => {
            const modelId = this.modelId;
            if (modelId === null) return Promise.reject(new Error('No model is shown'));
            return deps.loadValues!(modelId, key, onProgress);
          }
        : undefined,
      onPickValue: deps.selectValue
        ? (parameter, value, additive, unit) => {
            if (this.modelId !== null) deps.selectValue!(this.modelId, parameter, value, additive, unit);
          }
        : undefined,
      onShowOnly: deps.showOnlyValue
        ? (parameter, value, additive, unit) => {
            if (this.modelId !== null) deps.showOnlyValue!(this.modelId, parameter, value, additive, unit);
          }
        : undefined,
      onOpen: deps.prepare
        ? (parameter) => {
            if (this.modelId !== null) deps.prepare!(this.modelId, parameter);
          }
        : undefined,
      onClose: deps.release ? (parameter, modelId) => deps.release!(modelId, parameter) : undefined,
      onColourBy: deps.colourBy
        ? (parameter) => {
            if (this.modelId !== null) deps.colourBy!(this.modelId, parameter);
          }
        : undefined,
      onTotals:
        deps.totals && deps.addToTotals
          ? (parameter) => {
              deps.addToTotals!(parameter);
              this.showTab('totals');
            }
          : undefined,
    });
    parent.appendChild(this.container);
    this.markTabs();
  }

  /** The tab shown. */
  currentTab(): ParametersTab {
    return this.tab;
  }

  /**
   * Show the Totals tab (opening the panel when it is closed), or the
   * Parameters tab of the model shown last (or the first model).
   */
  showTab(tab: ParametersTab): void {
    if (tab === 'totals' && !this.deps.totals) return;
    if (tab === 'parameters') {
      const modelId = this.modelId ?? this.deps.getModels()[0]?.id;
      if (modelId === undefined) return;
      if (this.modelId === null || !this.isOpen()) {
        this.open(modelId);
        return;
      }
    }
    const wasOpen = this.isOpen();
    this.container.classList.remove('hidden');
    if (this.tab === tab && wasOpen) return;
    this.tab = tab;
    this.markTabs();
    if (!wasOpen) this.refreshModels();
  }

  /** Open the panel on its Totals tab. */
  openTotals(): void {
    this.showTab('totals');
  }

  private markTabs(): void {
    const totals = this.tab === 'totals';
    for (const [tab, b] of this.tabButtons) {
      b.setAttribute('aria-selected', String(tab === this.tab));
      b.classList.toggle('active', tab === this.tab);
      b.tabIndex = tab === this.tab ? 0 : -1;
    }
    this.container.classList.toggle('totals-tab', totals);
    this.paramsBody.classList.toggle('hidden', totals);
    this.deps.totals?.getElement().classList.toggle('hidden', !totals);
    // The model's name and picker belong to the Parameters tab.
    this.modelArea(!totals);
    this.deps.totals?.setShown(totals && this.isOpen());
  }

  private modelArea(on: boolean): void {
    if (!on) {
      this.modelSelect.classList.add('hidden');
      this.titleModel.classList.add('hidden');
      return;
    }
    const several = this.deps.getModels().length > 1;
    this.modelSelect.classList.toggle('hidden', !several);
    this.titleModel.classList.toggle('hidden', several);
  }

  /** Show `modelId`'s parameters, starting discovery if it has not run. */
  open(modelId: string): void {
    const gen = ++this.generation;
    this.modelId = modelId;
    this.container.classList.remove('hidden');
    if (this.tab !== 'parameters') {
      this.tab = 'parameters';
      this.markTabs();
    }
    this.refreshModels();
    this.list.setData(null);
    this.markColoured();
    this.setProgress(null);
    this.statusEl.classList.remove('error');
    this.statusEl.textContent = this.deps.isLoading?.() ? 'Waiting for the load to finish…' : 'Reading parameters…';

    let promise: Promise<ModelParameters>;
    try {
      promise = this.deps.describe(
        modelId,
        (done, total) => {
          if (gen !== this.generation) return;
          this.statusEl.textContent = `Reading parameters… ${counts.format(done)} of ${counts.format(total)} elements`;
          this.setProgress(total > 0 ? done / total : 1);
        },
        () => {
          if (gen === this.generation) this.statusEl.textContent = 'Reading parameters…';
        },
      );
    } catch (err) {
      promise = Promise.reject(err);
    }
    promise.then(
      (result) => {
        if (gen !== this.generation) return;
        this.setProgress(null);
        let status = `${counts.format(result.parameters.length)} parameters across ${counts.format(result.scopeSize)} elements with geometry`;
        if (result.unreadable) status += ` · ${counts.format(result.unreadable)} could not be read`;
        this.statusEl.textContent = status;
        this.list.setData(result);
      },
      (err: unknown) => {
        if (gen !== this.generation) return;
        this.setProgress(null);
        this.statusEl.classList.add('error');
        this.statusEl.textContent = `Could not read parameters: ${err instanceof Error ? err.message : String(err)}`;
      },
    );
  }

  close(): void {
    this.generation++;
    // Closing the panel closes its open parameter, and so gives up its build.
    this.list.open(null);
    this.modelId = null;
    this.container.classList.add('hidden');
    // Totals stop counting and give up their builds while the panel is closed.
    this.deps.totals?.setShown(false);
  }

  isOpen(): boolean {
    return !this.container.classList.contains('hidden');
  }

  /**
   * Mark the parameter the elements are coloured by, on the rows of the
   * models it covers; null when nothing is coloured.
   */
  setColoured(coloured: { key: string; models: ReadonlySet<string> } | null): void {
    this.coloured = coloured;
    this.markColoured();
  }

  private markColoured(): void {
    const c = this.coloured;
    this.list.setColouredKey(c && this.modelId !== null && c.models.has(this.modelId) ? c.key : null);
  }

  /** The model shown, or null when closed. */
  currentModel(): string | null {
    return this.modelId;
  }

  /** A model was removed: show another one, or close when none is left. */
  onModelRemoved(id: string): void {
    if (!this.isOpen()) return;
    const next = this.deps.getModels().find((m) => m.id !== id);
    if (this.tab === 'totals') {
      // Totals cover every model: the tab stays while any is left.
      if (this.modelId === id) {
        this.list.open(null);
        this.list.setData(null);
        this.modelId = null;
      }
      if (next) this.refreshModels();
      else this.close();
      return;
    }
    if (this.modelId !== id) {
      this.refreshModels();
      return;
    }
    if (next) this.open(next.id);
    else this.close();
  }

  /** Re-read the loaded models into the picker. Hidden with one model. */
  refreshModels(): void {
    const models = this.deps.getModels();
    this.modelSelect.replaceChildren();
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      this.modelSelect.appendChild(opt);
    }
    if (this.modelId !== null) this.modelSelect.value = this.modelId;
    this.modelArea(this.tab === 'parameters');
    const current = models.find((m) => m.id === this.modelId);
    this.titleModel.textContent = current ? current.name : '';
    this.titleModel.title = this.titleModel.textContent;
  }

  /**
   * Keep the panel's bottom edge above `el` (the contextual action tray in
   * the bottom-right corner), which grows upward as actions appear.
   */
  keepClearOf(el: HTMLElement): void {
    const update = (): void => {
      this.container.style.setProperty('--params-clearance', `${el.offsetHeight}px`);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    this.clearanceObserver?.disconnect();
    this.clearanceObserver = new ResizeObserver(update);
    this.clearanceObserver.observe(el);
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  getList(): ParameterList {
    return this.list;
  }

  dispose(): void {
    this.clearanceObserver?.disconnect();
    this.generation++;
    this.list.dispose();
    this.container.remove();
  }

  private setProgress(fraction: number | null): void {
    this.progressEl.classList.toggle('hidden', fraction === null);
    if (fraction !== null) this.progressFill.style.width = `${Math.round(fraction * 100)}%`;
  }
}
