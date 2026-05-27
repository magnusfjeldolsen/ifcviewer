import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SelectionBasket } from '../src/inspector/SelectionBasket';
import { HistoryManager } from '../src/core/history/HistoryManager';
import type { ElementIdentity } from '../src/inspector/types';

/**
 * The SelectionBasket model is pure (no DOM, no web-ifc) so it gets strong
 * unit coverage here. The four calculator actions (M+/M−/MR/MC) are wired in
 * App.ts; this file covers the underlying model: dedupe, onChange semantics,
 * serialization round-trip, and model-removal pruning.
 */

function identity(modelId: string, expressId: number, over: Partial<ElementIdentity> = {}): ElementIdentity {
  return { modelId, expressId, ifcClass: 'IfcWall', ifcTypeCode: 1, ...over };
}

describe('SelectionBasket — add / size / has', () => {
  let basket: SelectionBasket;

  beforeEach(() => {
    basket = new SelectionBasket();
  });

  it('starts empty', () => {
    expect(basket.size()).toBe(0);
    expect(basket.getContents()).toEqual([]);
  });

  it('adds identities and reports size + has', () => {
    basket.add([identity('A', 1), identity('A', 2)]);
    expect(basket.size()).toBe(2);
    expect(basket.has('A', 1)).toBe(true);
    expect(basket.has('A', 2)).toBe(true);
    expect(basket.has('A', 3)).toBe(false);
    expect(basket.has('B', 1)).toBe(false);
  });

  it('dedupes by modelId:expressId across calls', () => {
    basket.add([identity('A', 1)]);
    basket.add([identity('A', 1)]); // duplicate
    expect(basket.size()).toBe(1);
  });

  it('dedupes within a single add call', () => {
    basket.add([identity('A', 1), identity('A', 1), identity('A', 2)]);
    expect(basket.size()).toBe(2);
  });

  it('treats same expressId in different models as distinct', () => {
    basket.add([identity('A', 5), identity('B', 5)]);
    expect(basket.size()).toBe(2);
    expect(basket.has('A', 5)).toBe(true);
    expect(basket.has('B', 5)).toBe(true);
  });

  it('preserves insertion order in getContents', () => {
    basket.add([identity('A', 3), identity('A', 1), identity('B', 2)]);
    expect(basket.getContents().map((i) => `${i.modelId}:${i.expressId}`)).toEqual([
      'A:3',
      'A:1',
      'B:2',
    ]);
  });
});

describe('SelectionBasket — remove / clear', () => {
  let basket: SelectionBasket;

  beforeEach(() => {
    basket = new SelectionBasket();
    basket.add([identity('A', 1), identity('A', 2), identity('B', 1)]);
  });

  it('removes the given identities', () => {
    basket.remove([identity('A', 1)]);
    expect(basket.size()).toBe(2);
    expect(basket.has('A', 1)).toBe(false);
    expect(basket.has('A', 2)).toBe(true);
  });

  it('no-ops per element when removing something not in the basket', () => {
    basket.remove([identity('A', 99), identity('A', 2)]);
    expect(basket.size()).toBe(2);
    expect(basket.has('A', 2)).toBe(false);
  });

  it('clear empties the basket', () => {
    basket.clear();
    expect(basket.size()).toBe(0);
    expect(basket.getContents()).toEqual([]);
  });
});

describe('SelectionBasket — onChange', () => {
  let basket: SelectionBasket;

  beforeEach(() => {
    basket = new SelectionBasket();
  });

  it('fires onChange on a real add', () => {
    const cb = vi.fn();
    basket.onChange(cb);
    basket.add([identity('A', 1)]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onChange when add is a pure no-op (all duplicates)', () => {
    basket.add([identity('A', 1)]);
    const cb = vi.fn();
    basket.onChange(cb);
    basket.add([identity('A', 1)]); // already present → no mutation
    expect(cb).not.toHaveBeenCalled();
  });

  it('does NOT fire onChange when adding an empty list', () => {
    const cb = vi.fn();
    basket.onChange(cb);
    basket.add([]);
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires onChange once per mutating add (batched)', () => {
    const cb = vi.fn();
    basket.onChange(cb);
    basket.add([identity('A', 1), identity('A', 2), identity('A', 3)]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires onChange on a real remove but not on a no-op remove', () => {
    basket.add([identity('A', 1)]);
    const cb = vi.fn();
    basket.onChange(cb);
    basket.remove([identity('A', 2)]); // not present → no-op
    expect(cb).not.toHaveBeenCalled();
    basket.remove([identity('A', 1)]); // present → mutates
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires onChange on a real clear but not when already empty', () => {
    const cb = vi.fn();
    basket.onChange(cb);
    basket.clear(); // already empty → no-op
    expect(cb).not.toHaveBeenCalled();
    basket.add([identity('A', 1)]);
    cb.mockClear();
    basket.clear(); // had content → mutates
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('returns an unsubscribe that stops further notifications', () => {
    const cb = vi.fn();
    const off = basket.onChange(cb);
    basket.add([identity('A', 1)]);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    basket.add([identity('A', 2)]);
    expect(cb).toHaveBeenCalledTimes(1); // no further calls
  });
});

describe('SelectionBasket — serialize / deserialize', () => {
  it('round-trips contents as { modelId, expressId }[]', () => {
    const basket = new SelectionBasket();
    basket.add([identity('A', 1), identity('B', 7), identity('A', 3)]);

    const serialized = basket.serialize();
    expect(serialized).toEqual([
      { modelId: 'A', expressId: 1 },
      { modelId: 'B', expressId: 7 },
      { modelId: 'A', expressId: 3 },
    ]);

    const restored = new SelectionBasket();
    restored.deserialize(serialized);
    expect(restored.size()).toBe(3);
    expect(restored.has('A', 1)).toBe(true);
    expect(restored.has('B', 7)).toBe(true);
    expect(restored.has('A', 3)).toBe(true);
    expect(restored.serialize()).toEqual(serialized);
  });

  it('deserialize replaces existing contents', () => {
    const basket = new SelectionBasket();
    basket.add([identity('A', 99)]);
    basket.deserialize([{ modelId: 'A', expressId: 1 }]);
    expect(basket.size()).toBe(1);
    expect(basket.has('A', 99)).toBe(false);
    expect(basket.has('A', 1)).toBe(true);
  });

  it('deserialize fires onChange once', () => {
    const basket = new SelectionBasket();
    const cb = vi.fn();
    basket.onChange(cb);
    basket.deserialize([{ modelId: 'A', expressId: 1 }, { modelId: 'A', expressId: 2 }]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('deserialized identities are minimal but valid (ifcClass/typeCode placeholders)', () => {
    const basket = new SelectionBasket();
    basket.deserialize([{ modelId: 'A', expressId: 1 }]);
    const [id] = basket.getContents();
    expect(id.modelId).toBe('A');
    expect(id.expressId).toBe(1);
    expect(typeof id.ifcClass).toBe('string');
    expect(typeof id.ifcTypeCode).toBe('number');
  });
});

describe('SelectionBasket — model-removal pruning', () => {
  let basket: SelectionBasket;

  beforeEach(() => {
    basket = new SelectionBasket();
    basket.add([identity('A', 1), identity('A', 2), identity('B', 1)]);
  });

  it('drops all entries owned by the removed model', () => {
    basket.onModelRemoved('A');
    expect(basket.size()).toBe(1);
    expect(basket.has('A', 1)).toBe(false);
    expect(basket.has('A', 2)).toBe(false);
    expect(basket.has('B', 1)).toBe(true);
  });

  it('fires onChange when pruning removes something', () => {
    const cb = vi.fn();
    basket.onChange(cb);
    basket.onModelRemoved('A');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onChange when the removed model had no entries', () => {
    const cb = vi.fn();
    basket.onChange(cb);
    basket.onModelRemoved('Z'); // not in basket
    expect(cb).not.toHaveBeenCalled();
    expect(basket.size()).toBe(3);
  });

  it('does not confuse a model id that is a prefix of another', () => {
    const b = new SelectionBasket();
    b.add([identity('model', 1), identity('model-2', 1)]);
    b.onModelRemoved('model');
    expect(b.has('model', 1)).toBe(false);
    expect(b.has('model-2', 1)).toBe(true);
  });
});

// ── Undo / redo integration (HistoryManager-backed basket) ─────────────
//
// The basket takes an OPTIONAL 2nd constructor param `history`. When present,
// the three USER actions M+ (add) / M− (remove) / MC (clear) each push exactly
// ONE command whose memento is the basket's serialized contents before/after.
// SYSTEM changes (deserialize on session restore, onModelRemoved pruning) push
// none, and a command's own re-apply must never push a fresh command.
describe('SelectionBasket — undo / redo (history-backed)', () => {
  let history: HistoryManager;
  let basket: SelectionBasket;

  function contents(b: SelectionBasket): string[] {
    return b.getContents().map((i) => `${i.modelId}:${i.expressId}`);
  }

  beforeEach(() => {
    history = new HistoryManager();
    basket = new SelectionBasket(history);
  });

  it('T20: add / remove / clear each push exactly ONE command', () => {
    basket.add([identity('A', 1), identity('A', 2), identity('A', 3)]);
    expect(history.canUndo()).toBe(true);

    basket.remove([identity('A', 2)]);
    basket.clear();

    // Three user actions → three undo steps available, then exhausted.
    let steps = 0;
    while (history.canUndo()) {
      history.undo();
      steps++;
    }
    expect(steps).toBe(3);
  });

  it('T21: undo of add removes added entries; redo re-adds; undo of clear restores all', () => {
    basket.add([identity('A', 1), identity('A', 2)]);
    expect(contents(basket)).toEqual(['A:1', 'A:2']);

    history.undo(); // undo the add
    expect(basket.size()).toBe(0);

    history.redo(); // re-add
    expect(contents(basket)).toEqual(['A:1', 'A:2']);

    basket.clear();
    expect(basket.size()).toBe(0);

    history.undo(); // undo the clear → all contents return
    expect(contents(basket)).toEqual(['A:1', 'A:2']);
  });

  it('T22: deserialize (session restore) and onModelRemoved push NO command', () => {
    basket.deserialize([
      { modelId: 'A', expressId: 1 },
      { modelId: 'B', expressId: 2 },
    ]);
    expect(history.canUndo()).toBe(false); // restore is not a user action

    basket.onModelRemoved('A');
    expect(history.canUndo()).toBe(false); // prune is not a user action
    expect(basket.has('B', 2)).toBe(true);
  });

  it('T23: restoring basket contents during undo fires onChange but pushes NO fresh command', () => {
    basket.add([identity('A', 1)]);
    basket.add([identity('A', 2)]);
    expect(contents(basket)).toEqual(['A:1', 'A:2']);

    const cb = vi.fn();
    basket.onChange(cb);

    history.undo(); // restore to ['A:1']
    expect(contents(basket)).toEqual(['A:1']);
    expect(cb).toHaveBeenCalledTimes(1); // onChange fires (session-save side effect)

    // No fresh command was pushed by the restore: the redo future is intact.
    expect(history.canRedo()).toBe(true);
    history.redo();
    expect(contents(basket)).toEqual(['A:1', 'A:2']);
  });
});
