// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SelectionBasketPanel } from '../src/ui/SelectionBasketPanel';
import type { BasketPanelDeps } from '../src/ui/SelectionBasketPanel';
import { SelectionBasket } from '../src/inspector/SelectionBasket';
import type { ElementIdentity, SelectionState } from '../src/inspector/types';

function identity(modelId: string, expressId: number): ElementIdentity {
  return { modelId, expressId, ifcClass: 'IfcWall', ifcTypeCode: 1 };
}

/**
 * Minimal selection source: a settable state + an onChange fan-out so the
 * panel re-evaluates M+/M− enablement when selection changes.
 */
function makeSelectionSource(initial: SelectionState = { kind: 'none' }) {
  let state = initial;
  const listeners: Array<(s: SelectionState) => void> = [];
  return {
    getState: () => state,
    onChange: (cb: (s: SelectionState) => void) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    set(next: SelectionState) {
      state = next;
      for (const cb of listeners) cb(next);
    },
  };
}

function makeDeps(over: Partial<BasketPanelDeps> = {}): BasketPanelDeps {
  return {
    basket: new SelectionBasket(),
    selection: makeSelectionSource(),
    onAddSelection: vi.fn(),
    onRemoveSelection: vi.fn(),
    onRecall: vi.fn(),
    onClear: vi.fn(),
    ...over,
  };
}

function btn(parent: HTMLElement, action: string): HTMLButtonElement {
  return parent.querySelector(`[data-basket-action="${action}"]`) as HTMLButtonElement;
}

describe('SelectionBasketPanel — visibility', () => {
  let parent: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  it('renders the panel hidden when the basket is empty', () => {
    const deps = makeDeps();
    new SelectionBasketPanel(parent, deps);
    const panel = parent.querySelector('.basket-panel') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.classList.contains('hidden')).toBe(true);
  });

  it('shows the panel once the basket is non-empty', () => {
    const basket = new SelectionBasket();
    const deps = makeDeps({ basket });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 1)]);
    const panel = parent.querySelector('.basket-panel') as HTMLElement;
    expect(panel.classList.contains('hidden')).toBe(false);
  });

  it('hides again when the basket is cleared', () => {
    const basket = new SelectionBasket();
    const deps = makeDeps({ basket });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 1)]);
    basket.clear();
    const panel = parent.querySelector('.basket-panel') as HTMLElement;
    expect(panel.classList.contains('hidden')).toBe(true);
  });
});

describe('SelectionBasketPanel — count', () => {
  let parent: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  it('renders the count text reflecting basket size', () => {
    const basket = new SelectionBasket();
    const deps = makeDeps({ basket });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 1), identity('A', 2), identity('B', 3)]);
    const count = parent.querySelector('.basket-count') as HTMLElement;
    expect(count.textContent).toContain('3');
  });

  it('updates the count when the basket changes', () => {
    const basket = new SelectionBasket();
    const deps = makeDeps({ basket });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 1)]);
    let count = parent.querySelector('.basket-count') as HTMLElement;
    expect(count.textContent).toContain('1');
    basket.add([identity('A', 2)]);
    count = parent.querySelector('.basket-count') as HTMLElement;
    expect(count.textContent).toContain('2');
  });
});

describe('SelectionBasketPanel — buttons fire the right actions', () => {
  let parent: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  it('M+ calls onAddSelection', () => {
    const basket = new SelectionBasket();
    const selection = makeSelectionSource({ kind: 'single', identities: [identity('A', 1)] });
    const deps = makeDeps({ basket, selection });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 9)]); // make the panel visible
    btn(parent, 'add').click();
    expect(deps.onAddSelection).toHaveBeenCalledTimes(1);
  });

  it('M− calls onRemoveSelection', () => {
    const basket = new SelectionBasket();
    const selection = makeSelectionSource({ kind: 'single', identities: [identity('A', 1)] });
    const deps = makeDeps({ basket, selection });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 9)]);
    btn(parent, 'remove').click();
    expect(deps.onRemoveSelection).toHaveBeenCalledTimes(1);
  });

  it('MR calls onRecall', () => {
    const basket = new SelectionBasket();
    const deps = makeDeps({ basket });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 1)]);
    btn(parent, 'recall').click();
    expect(deps.onRecall).toHaveBeenCalledTimes(1);
  });

  it('MC calls onClear', () => {
    const basket = new SelectionBasket();
    const deps = makeDeps({ basket });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 1)]);
    btn(parent, 'clear').click();
    expect(deps.onClear).toHaveBeenCalledTimes(1);
  });
});

describe('SelectionBasketPanel — M+/M− enablement follows selection', () => {
  let parent: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  it('M+ and M− are disabled when there is no live selection', () => {
    const basket = new SelectionBasket();
    const selection = makeSelectionSource({ kind: 'none' });
    const deps = makeDeps({ basket, selection });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 1)]);
    expect(btn(parent, 'add').disabled).toBe(true);
    expect(btn(parent, 'remove').disabled).toBe(true);
  });

  it('M+ and M− are enabled when there is a live selection', () => {
    const basket = new SelectionBasket();
    const selection = makeSelectionSource({ kind: 'single', identities: [identity('A', 1)] });
    const deps = makeDeps({ basket, selection });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 9)]);
    expect(btn(parent, 'add').disabled).toBe(false);
    expect(btn(parent, 'remove').disabled).toBe(false);
  });

  it('MR and MC are always enabled while the basket is non-empty', () => {
    const basket = new SelectionBasket();
    const selection = makeSelectionSource({ kind: 'none' });
    const deps = makeDeps({ basket, selection });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 1)]);
    expect(btn(parent, 'recall').disabled).toBe(false);
    expect(btn(parent, 'clear').disabled).toBe(false);
  });

  it('re-enables M+/M− when a selection arrives after the panel is shown', () => {
    const basket = new SelectionBasket();
    const selection = makeSelectionSource({ kind: 'none' });
    const deps = makeDeps({ basket, selection });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 1)]);
    expect(btn(parent, 'add').disabled).toBe(true);
    selection.set({ kind: 'single', identities: [identity('B', 5)] });
    expect(btn(parent, 'add').disabled).toBe(false);
  });
});

describe('SelectionBasketPanel — tooltips', () => {
  let parent: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  it('each button carries a descriptive tooltip', () => {
    const basket = new SelectionBasket();
    const deps = makeDeps({ basket });
    new SelectionBasketPanel(parent, deps);
    basket.add([identity('A', 1)]);
    expect(btn(parent, 'add').title).toMatch(/add/i);
    expect(btn(parent, 'remove').title).toMatch(/remove/i);
    expect(btn(parent, 'recall').title).toMatch(/select/i);
    expect(btn(parent, 'clear').title).toMatch(/clear/i);
  });
});

describe('SelectionBasketPanel — dispose', () => {
  it('removes the DOM node and unsubscribes', () => {
    document.body.innerHTML = '';
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const basket = new SelectionBasket();
    const deps = makeDeps({ basket });
    const panel = new SelectionBasketPanel(parent, deps);
    panel.dispose();
    expect(parent.querySelector('.basket-panel')).toBeNull();
    // After dispose, basket changes must not throw (listener detached).
    expect(() => basket.add([identity('A', 1)])).not.toThrow();
  });
});
