/**
 * Selection Basket panel — feature 1 of the Data Insight phase.
 *
 * A small DOM-driven panel (no framework) that appears whenever there is
 * **something to do** — a live selection (so you can add it) OR a non-empty
 * basket (so you can recall/clear it). It shows "N in basket" plus the
 * calculator cluster M+ · M− · MR · MC, each with a tooltip:
 *   - M+ — "Add selection to basket"
 *   - M− — "Remove selection from basket"
 *   - MR — "Select basket contents"
 *   - MC — "Clear basket"
 *
 * Per-button enablement (greyed, tooltip still shown, when not applicable):
 *   - M+ — needs a live selection.
 *   - M− — needs a live selection AND a non-empty basket.
 *   - MR / MC — need a non-empty basket.
 * The *cluster* appears on any live selection, so selecting an element is the
 * entry point for starting a basket (no separate inspector button needed).
 * It stays hidden only when there's both no selection and an empty basket, so
 * the screen is calm until there's something to act on.
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
  private recallBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;

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
    this.recallBtn = buttons[2];
    this.clearBtn = buttons[3];

    this.container.appendChild(cluster);
    parent.appendChild(this.container);

    // Both the basket (count + MR/MC) and the live selection (M+/M−) feed the
    // same visibility + enablement decision, so both fire the one refresh.
    this.unsubscribeBasket = deps.basket.onChange(() => this.refresh());
    this.unsubscribeSelection = deps.selection.onChange(() => this.refresh());

    // Drive initial state.
    this.refresh();
  }

  /** Re-evaluate count, visibility, and per-button enablement. */
  private refresh(): void {
    const n = this.deps.basket.size();
    const hasSelection = hasLiveSelection(this.deps.selection.getState());
    this.countEl.textContent = `${n} in basket`;
    // Visible whenever there's something to add (a live selection) or
    // something to manage (a non-empty basket); hidden only when both empty.
    this.container.classList.toggle('hidden', n === 0 && !hasSelection);
    // M+ needs a selection; M− needs a selection AND something to remove
    // from; MR / MC need a non-empty basket.
    this.addBtn.disabled = !hasSelection;
    this.removeBtn.disabled = !hasSelection || n === 0;
    this.recallBtn.disabled = n === 0;
    this.clearBtn.disabled = n === 0;
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
