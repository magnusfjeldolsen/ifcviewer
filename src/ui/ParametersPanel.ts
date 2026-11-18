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

import type { ModelParameters } from '../inspector/types';
import { ParameterList } from './ParameterList';

export interface ParametersPanelDeps {
  /** The loaded models, in the order the Models panel shows them. */
  getModels(): { id: string; name: string }[];
  /** Describe one model's parameters, reporting elements read so far. */
  describe(modelId: string, onProgress: (done: number, total: number) => void): Promise<ModelParameters>;
}

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
  /** Bumped on every open: replies for an earlier one are dropped. */
  private generation = 0;

  constructor(
    parent: HTMLElement,
    private readonly deps: ParametersPanelDeps,
  ) {
    this.container = document.createElement('section');
    this.container.className = 'params-panel hidden';
    this.container.setAttribute('aria-label', 'Parameters');

    const header = document.createElement('div');
    header.className = 'params-panel-header';
    const title = document.createElement('span');
    title.className = 'params-panel-title';
    title.textContent = 'Parameters';
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
    this.container.appendChild(this.statusEl);
    this.container.appendChild(this.progressEl);
    this.list = new ParameterList(this.container);
    parent.appendChild(this.container);
  }

  /** Show `modelId`'s parameters, starting discovery if it has not run. */
  open(modelId: string): void {
    const gen = ++this.generation;
    this.modelId = modelId;
    this.container.classList.remove('hidden');
    this.refreshModels();
    this.list.setData(null);
    this.setProgress(null);
    this.statusEl.classList.remove('error');
    this.statusEl.textContent = 'Reading parameters…';

    let promise: Promise<ModelParameters>;
    try {
      promise = this.deps.describe(modelId, (done, total) => {
        if (gen !== this.generation) return;
        this.statusEl.textContent = `Reading parameters… ${counts.format(done)} of ${counts.format(total)} elements`;
        this.setProgress(total > 0 ? done / total : 1);
      });
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
    this.modelId = null;
    this.container.classList.add('hidden');
  }

  isOpen(): boolean {
    return !this.container.classList.contains('hidden');
  }

  /** The model shown, or null when closed. */
  currentModel(): string | null {
    return this.modelId;
  }

  /** A model was removed: show another one, or close when none is left. */
  onModelRemoved(id: string): void {
    if (!this.isOpen()) return;
    if (this.modelId !== id) {
      this.refreshModels();
      return;
    }
    const next = this.deps.getModels().find((m) => m.id !== id);
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
    const several = models.length > 1;
    this.modelSelect.classList.toggle('hidden', !several);
    this.titleModel.classList.toggle('hidden', several);
    const current = models.find((m) => m.id === this.modelId);
    this.titleModel.textContent = current ? current.name : '';
    this.titleModel.title = this.titleModel.textContent;
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  getList(): ParameterList {
    return this.list;
  }

  dispose(): void {
    this.generation++;
    this.list.dispose();
    this.container.remove();
  }

  private setProgress(fraction: number | null): void {
    this.progressEl.classList.toggle('hidden', fraction === null);
    if (fraction !== null) this.progressFill.style.width = `${Math.round(fraction * 100)}%`;
  }
}
