/**
 * Selection Basket panel — feature 1 of the Data Insight phase.
 *
 * A small DOM-driven panel (no framework) that appears **only when the basket
 * is non-empty**. It shows "N in basket" plus the calculator cluster
 * M+ · M− · MR · MC, each with a tooltip:
 *   - M+ — "Add selection to basket"
 *   - M− — "Remove selection from basket"
 *   - MR — "Select basket contents"
 *   - MC — "Clear basket"
 *
 * M+ / M− are disabled (greyed, tooltip still shown) when there is no live
 * selection; MR / MC are always enabled while the basket is non-empty. The
 * *cluster* appears/disappears with the basket (calmer than individual
 * buttons popping in and out), while the inspector's "Add to basket" header
 * button covers the very first add (the chicken-and-egg of "buttons only
 * show once a basket exists").
 *
 * This component only renders + dispatches; the four actions are wired to the
 * SelectionBasket + SelectionManager by App.ts. See
 * dev/plans/handoff-selection-basket.md (D1).
 */

import type { SelectionState } from '../inspector/types';
import type { SelectionBasket } from '../inspector/SelectionBasket';

/** The slice of SelectionManager the panel needs for M+/M− enablement. */
export interface BasketSelectionSource {
  getState(): SelectionState;
  onChange(listener: (state: SelectionState) => void): () => void;
}

export interface BasketPanelDeps {
  /** The basket model — drives count + visibility via its onChange. */
  basket: SelectionBasket;
  /** Live selection — drives M+/M− enable/disable via its onChange. */
  selection: BasketSelectionSource;
  /** M+ — add the current live selection to the basket. */
  onAddSelection: () => void;
  /** M− — remove the current live selection from the basket. */
  onRemoveSelection: () => void;
  /** MR — recall: select the basket's contents (highlight them). */
  onRecall: () => void;
  /** MC — clear the basket. */
  onClear: () => void;
}

interface ButtonSpec {
  action: 'add' | 'remove' | 'recall' | 'clear';
  glyph: string;
  title: string;
  onClick: () => void;
}

/** True when the live selection has at least one element. */
function hasLiveSelection(state: SelectionState): boolean {
  return state.kind !== 'none';
}

export class SelectionBasketPanel {
  private container: HTMLElement;
  private countEl: HTMLElement;
  private addBtn: HTMLButtonElement;
  private removeBtn: HTMLButtonElement;

  private deps: BasketPanelDeps;
  private unsubscribeBasket: () => void;
  private unsubscribeSelection: () => void;

  constructor(parent: HTMLElement, deps: BasketPanelDeps) {
    this.deps = deps;

    this.container = document.createElement('div');
    this.container.className = 'basket-panel hidden';

    // ── Count row ──
    const countRow = document.createElement('div');
    countRow.className = 'basket-count-row';
    this.countEl = document.createElement('span');
    this.countEl.className = 'basket-count';
    this.countEl.textContent = '0 in basket';
    countRow.appendChild(this.countEl);
    this.container.appendChild(countRow);

    // ── Calculator cluster: M+ · M− · MR · MC ──
    const cluster = document.createElement('div');
    cluster.className = 'basket-cluster';

    const specs: ButtonSpec[] = [
      { action: 'add', glyph: 'M+', title: 'Add selection to basket', onClick: deps.onAddSelection },
      { action: 'remove', glyph: 'M−', title: 'Remove selection from basket', onClick: deps.onRemoveSelection },
      { action: 'recall', glyph: 'MR', title: 'Select basket contents', onClick: deps.onRecall },
      { action: 'clear', glyph: 'MC', title: 'Clear basket', onClick: deps.onClear },
    ];

    const buttons = specs.map((spec) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'basket-btn';
      b.dataset.basketAction = spec.action;
      b.textContent = spec.glyph;
      b.title = spec.title;
      b.addEventListener('click', () => {
        // Defensive: a disabled button can't be clicked, but guard anyway so
        // a programmatic .click() in a disabled state is a no-op.
        if (b.disabled) return;
        spec.onClick();
      });
      cluster.appendChild(b);
      return b;
    });
    this.addBtn = buttons[0];
    this.removeBtn = buttons[1];

    this.container.appendChild(cluster);
    parent.appendChild(this.container);

    // Subscribe: basket → count + visibility; selection → M+/M− enablement.
    this.unsubscribeBasket = deps.basket.onChange(() => this.refreshBasket());
    this.unsubscribeSelection = deps.selection.onChange(() => this.refreshSelection());

    // Drive initial state.
    this.refreshBasket();
    this.refreshSelection();
  }

  /** Update count + visibility from the basket. */
  private refreshBasket(): void {
    const n = this.deps.basket.size();
    this.countEl.textContent = `${n} in basket`;
    this.container.classList.toggle('hidden', n === 0);
  }

  /** Enable/disable M+/M− based on whether a live selection exists. */
  private refreshSelection(): void {
    const enabled = hasLiveSelection(this.deps.selection.getState());
    this.addBtn.disabled = !enabled;
    this.removeBtn.disabled = !enabled;
  }

  isHidden(): boolean {
    return this.container.classList.contains('hidden');
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  dispose(): void {
    this.unsubscribeBasket();
    this.unsubscribeSelection();
    this.container.remove();
  }
}
