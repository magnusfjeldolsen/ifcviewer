// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppearanceManager, TRANSPARENCY_OPACITY } from '../src/viewer/AppearanceManager';
import type { AppearanceManagerDeps } from '../src/viewer/AppearanceManager';
import type { ModelManager } from '../src/viewer/ModelManager';
import type { ElementIdentity, Scope } from '../src/inspector/types';
import { boxModel, makeModelManager } from './helpers/models';
import { HistoryManager } from '../src/core/history/HistoryManager';

/**
 * AppearanceManager engine tests (D, the appearance system).
 *
 * The manager runs on a REAL ModelManager loaded with small boxes, and the
 * visual effect is asserted through `modelManager.getElementState` — what the
 * renderer will actually draw — rather than through meshes or materials.
 *
 * CRITICAL invariant under test: the states are mutually exclusive and every
 * transition (normal ↔ transparent ↔ hidden) ends in exactly the draw state
 * of the new state, with no residue of the previous one.
 */

// ── Fixtures ────────────────────────────────────────────────

function identity(modelId: string, expressId: number): ElementIdentity {
  return { modelId, expressId, ifcClass: '', ifcTypeCode: 0 };
}

function makeDeps(): {
  deps: AppearanceManagerDeps;
  modelManager: ModelManager;
  /** Load a model whose elements are the given expressIDs. */
  load: (modelId: string, expressIds: number[]) => void;
  renderCalls: { count: number };
} {
  const { modelManager } = makeModelManager();
  const renderCalls = { count: 0 };
  return {
    deps: { modelManager, requestRender: () => { renderCalls.count++; } },
    modelManager,
    load: (modelId, expressIds) => {
      modelManager.addModel(boxModel(modelId, expressIds));
    },
    renderCalls,
  };
}

/** Draw state for (modelId, expressId); throws if the element isn't loaded. */
function drawn(mm: ModelManager, modelId: string, expressId: number) {
  const s = mm.getElementState(modelId, expressId);
  if (!s) throw new Error(`element ${modelId}:${expressId} not loaded`);
  return s;
}

/** True when the element is drawn exactly as loaded: visible, own opacity (1). */
function isNormal(mm: ModelManager, modelId: string, expressId: number): boolean {
  const s = drawn(mm, modelId, expressId);
  return !s.hidden && !s.opacityOverridden && s.opacity === 1;
}

/** Build a Scope from (modelId, expressId) pairs. */
function scope(...pairs: Array<[string, number]>): Scope {
  return pairs.map(([m, e]) => identity(m, e));
}

// ── Tests ───────────────────────────────────────────────────

describe('AppearanceManager — hide / show-all (T1, T2)', () => {
  let env: ReturnType<typeof makeDeps>;
  let manager: AppearanceManager;

  beforeEach(() => {
    env = makeDeps();
    env.load('A', [1, 2, 3]);
    manager = new AppearanceManager(env.deps);
  });

  it('T1: fresh manager reports normal; hide(scope) records hidden for exactly those keys', () => {
    expect(manager.getStateFor('A', 1)).toBe('normal');
    expect(manager.getStateFor('A', 2)).toBe('normal');

    manager.hide(scope(['A', 1], ['A', 3]));

    expect(manager.getStateFor('A', 1)).toBe('hidden');
    expect(manager.getStateFor('A', 2)).toBe('normal'); // untouched
    expect(manager.getStateFor('A', 3)).toBe('hidden');
  });

  it('T2: hide stops the scope elements being drawn; showAll draws them again and empties the hidden set', () => {
    manager.hide(scope(['A', 1]));
    expect(drawn(env.modelManager, 'A', 1).hidden).toBe(true);
    expect(drawn(env.modelManager, 'A', 2).hidden).toBe(false);
    expect(manager.hasHidden()).toBe(true);

    manager.showAll();
    expect(drawn(env.modelManager, 'A', 1).hidden).toBe(false);
    expect(manager.getStateFor('A', 1)).toBe('normal');
    expect(manager.hasHidden()).toBe(false);
  });
});

describe('AppearanceManager — isolate (T3)', () => {
  it('T3: isolate(scope) hides the COMPLEMENT only; scope stays normal/visible', () => {
    const env = makeDeps();
    env.load('A', [1, 2, 3, 4]);
    env.load('B', [10, 20]);
    const manager = new AppearanceManager(env.deps);

    manager.isolate(scope(['A', 2], ['B', 10]));

    // Scope elements stay normal + visible.
    expect(manager.getStateFor('A', 2)).toBe('normal');
    expect(manager.getStateFor('B', 10)).toBe('normal');
    expect(drawn(env.modelManager, 'A', 2).hidden).toBe(false);
    expect(drawn(env.modelManager, 'B', 10).hidden).toBe(false);

    // Everything NOT in scope is hidden.
    expect(manager.getStateFor('A', 1)).toBe('hidden');
    expect(manager.getStateFor('A', 3)).toBe('hidden');
    expect(manager.getStateFor('A', 4)).toBe('hidden');
    expect(manager.getStateFor('B', 20)).toBe('hidden');
    expect(drawn(env.modelManager, 'A', 1).hidden).toBe(true);
    expect(drawn(env.modelManager, 'B', 20).hidden).toBe(true);
  });

  it('T3b: isolate over a 500-element model hides exactly the complement (grouped flush)', () => {
    const env = makeDeps();
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    env.load('A', ids);
    env.load('B', [1000, 1001]);
    const manager = new AppearanceManager(env.deps);
    const keep = new Set([7, 250, 499]);

    manager.isolate(scope(...[...keep].map((id): [string, number] => ['A', id])));

    for (const id of ids) {
      expect(drawn(env.modelManager, 'A', id).hidden).toBe(!keep.has(id));
    }
    expect(drawn(env.modelManager, 'B', 1000).hidden).toBe(true);
    expect(drawn(env.modelManager, 'B', 1001).hidden).toBe(true);
    expect(manager.hiddenCount()).toBe(500 - keep.size + 2);

    manager.showAll();
    for (const id of ids) expect(drawn(env.modelManager, 'A', id).hidden).toBe(false);
  });
});

describe('AppearanceManager — transparent / opaque (T4, T5)', () => {
  it('T4: transparent draws the element at TRANSPARENCY_OPACITY; opaque restores its own opacity', () => {
    const env = makeDeps();
    env.load('A', [1]);
    const manager = new AppearanceManager(env.deps);

    manager.transparent(scope(['A', 1]));
    expect(manager.getStateFor('A', 1)).toBe('transparent');
    const faded = drawn(env.modelManager, 'A', 1);
    expect(faded.opacity).toBeCloseTo(TRANSPARENCY_OPACITY);
    expect(faded.opacityOverridden).toBe(true);
    expect(faded.hidden).toBe(false);

    manager.opaque(scope(['A', 1]));
    expect(manager.getStateFor('A', 1)).toBe('normal');
    expect(isNormal(env.modelManager, 'A', 1)).toBe(true);
  });

  it('T5: same-coloured elements do not cross-contaminate — only the scope element fades', () => {
    const env = makeDeps();
    // Every box in boxModel has the same colour.
    env.load('A', [1, 2, 3, 4, 5]);
    const manager = new AppearanceManager(env.deps);

    manager.transparent(scope(['A', 1]));

    expect(drawn(env.modelManager, 'A', 1).opacity).toBeCloseTo(TRANSPARENCY_OPACITY);
    for (const id of [2, 3, 4, 5]) expect(isNormal(env.modelManager, 'A', id)).toBe(true);
  });
});

describe('AppearanceManager — onChange (T6)', () => {
  let env: ReturnType<typeof makeDeps>;
  let manager: AppearanceManager;

  beforeEach(() => {
    env = makeDeps();
    env.load('A', [1, 2]);
    manager = new AppearanceManager(env.deps);
  });

  it('T6: onChange fires once on a real mutation, NOT on a no-op', () => {
    const listener = vi.fn();
    manager.onChange(listener);

    manager.hide(scope(['A', 1]));
    expect(listener).toHaveBeenCalledTimes(1);

    // No-op 1: hide an already-hidden element.
    manager.hide(scope(['A', 1]));
    expect(listener).toHaveBeenCalledTimes(1);

    // No-op 2: opaque when nothing is transparent.
    manager.opaque(scope(['A', 2]));
    expect(listener).toHaveBeenCalledTimes(1);

    // Real mutation again.
    manager.transparent(scope(['A', 2]));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('AppearanceManager — serialize / deserialize (T7)', () => {
  it('T7: serialize() → {modelId, expressId, state}[]; deserialize() rehydrates the map AND re-applies the visual effect for live models', () => {
    const env = makeDeps();
    env.load('A', [1, 2, 3]);
    const manager = new AppearanceManager(env.deps);

    manager.hide(scope(['A', 1]));
    manager.transparent(scope(['A', 2]));

    const serialized = manager.serialize();
    expect(serialized).toEqual(
      expect.arrayContaining([
        { modelId: 'A', expressId: 1, state: 'hidden' },
        { modelId: 'A', expressId: 2, state: 'transparent' },
      ]),
    );
    expect(serialized).toHaveLength(2);

    // Fresh manager + freshly loaded model; deserialize must re-apply effects.
    const env2 = makeDeps();
    env2.load('A', [1, 2, 3]);
    const manager2 = new AppearanceManager(env2.deps);
    manager2.deserialize(serialized);

    expect(manager2.getStateFor('A', 1)).toBe('hidden');
    expect(manager2.getStateFor('A', 2)).toBe('transparent');
    expect(drawn(env2.modelManager, 'A', 1).hidden).toBe(true);
    expect(drawn(env2.modelManager, 'A', 2).opacity).toBeCloseTo(TRANSPARENCY_OPACITY);
    expect(isNormal(env2.modelManager, 'A', 3)).toBe(true);
  });
});

describe('AppearanceManager — onModelRemoved (T8)', () => {
  it('T8: prunes only that model entries (delimiter-aware so "m1" != "m1-2"); fires onChange iff something was pruned', () => {
    const env = makeDeps();
    env.load('m1', [1]);
    env.load('m1-2', [1]);
    const manager = new AppearanceManager(env.deps);

    manager.hide(scope(['m1', 1], ['m1-2', 1]));
    const listener = vi.fn();
    manager.onChange(listener);

    manager.onModelRemoved('m1');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.getStateFor('m1', 1)).toBe('normal'); // pruned
    expect(manager.getStateFor('m1-2', 1)).toBe('hidden'); // delimiter-aware: NOT pruned

    // Removing a model with no entries is a silent no-op.
    const env2 = makeDeps();
    env2.load('A', [1]);
    const manager2 = new AppearanceManager(env2.deps);
    manager2.hide(scope(['A', 1]));
    const listener2 = vi.fn();
    manager2.onChange(listener2);
    manager2.onModelRemoved('B');
    expect(listener2).not.toHaveBeenCalled();
  });
});

describe('AppearanceManager — mutually-exclusive transitions (T9, T10)', () => {
  it('T9 (A4): hide an already-transparent element → hidden and no longer faded; showAll → normal (NOT back to transparent)', () => {
    const env = makeDeps();
    env.load('A', [1]);
    const manager = new AppearanceManager(env.deps);

    manager.transparent(scope(['A', 1]));
    expect(drawn(env.modelManager, 'A', 1).opacity).toBeCloseTo(TRANSPARENCY_OPACITY);

    // Hide overrides transparent: the fade is dropped and the element hidden.
    manager.hide(scope(['A', 1]));
    expect(manager.getStateFor('A', 1)).toBe('hidden');
    const hidden = drawn(env.modelManager, 'A', 1);
    expect(hidden.hidden).toBe(true);
    expect(hidden.opacityOverridden).toBe(false);
    expect(hidden.opacity).toBe(1);

    // showAll returns to normal, NOT to transparent (mutually exclusive).
    manager.showAll();
    expect(manager.getStateFor('A', 1)).toBe('normal');
    expect(isNormal(env.modelManager, 'A', 1)).toBe(true);
  });

  it('T10: every transition ends in the draw state of the new state, with no residue', () => {
    const env = makeDeps();
    env.load('A', [1]);
    const manager = new AppearanceManager(env.deps);

    // transparent → opaque → normal
    manager.transparent(scope(['A', 1]));
    manager.opaque(scope(['A', 1]));
    expect(manager.getStateFor('A', 1)).toBe('normal');
    expect(isNormal(env.modelManager, 'A', 1)).toBe(true);

    // normal → transparent → hidden → showAll
    manager.transparent(scope(['A', 1]));
    expect(drawn(env.modelManager, 'A', 1).opacity).toBeCloseTo(TRANSPARENCY_OPACITY);
    manager.hide(scope(['A', 1]));
    expect(drawn(env.modelManager, 'A', 1).hidden).toBe(true);
    expect(drawn(env.modelManager, 'A', 1).opacityOverridden).toBe(false);
    manager.showAll();
    expect(manager.getStateFor('A', 1)).toBe('normal');
    expect(isNormal(env.modelManager, 'A', 1)).toBe(true);

    // hidden → transparent (overrides hide) → clearTransparency → normal
    manager.hide(scope(['A', 1]));
    manager.transparent(scope(['A', 1]));
    const faded = drawn(env.modelManager, 'A', 1);
    expect(faded.hidden).toBe(false);
    expect(faded.opacity).toBeCloseTo(TRANSPARENCY_OPACITY);
    manager.clearTransparency();
    expect(isNormal(env.modelManager, 'A', 1)).toBe(true);
  });
});

describe('AppearanceManager — predicates (T11)', () => {
  it('T11: hasHidden()/hasTransparent() flip true on the matching state and false after showAll/opaque', () => {
    const env = makeDeps();
    env.load('A', [1, 2]);
    const manager = new AppearanceManager(env.deps);

    expect(manager.hasHidden()).toBe(false);
    expect(manager.hasTransparent()).toBe(false);

    manager.hide(scope(['A', 1]));
    expect(manager.hasHidden()).toBe(true);
    expect(manager.hasTransparent()).toBe(false);

    manager.transparent(scope(['A', 2]));
    expect(manager.hasTransparent()).toBe(true);

    manager.showAll();
    expect(manager.hasHidden()).toBe(false);
    expect(manager.hasTransparent()).toBe(true); // showAll only clears hidden

    manager.opaque(scope(['A', 2]));
    expect(manager.hasTransparent()).toBe(false);
  });
});

describe('AppearanceManager — show only (#70)', () => {
  function setup() {
    const env = makeDeps();
    env.load('A', [1, 2, 3, 4]);
    env.load('B', [10, 20]);
    const history = new HistoryManager();
    const manager = new AppearanceManager({ ...env.deps, history });
    return { env, manager, history };
  }
  const shown = (m: AppearanceManager) =>
    [['A', 1], ['A', 2], ['A', 3], ['A', 4], ['B', 10], ['B', 20]]
      .filter(([id, e]) => m.getStateFor(id as string, e as number) !== 'hidden')
      .map(([id, e]) => `${id}${e}`);

  it('shows only the given elements, across models, as one undo step', () => {
    const { manager, history } = setup();
    const r = manager.showOnly(scope(['A', 1], ['B', 10]), 'narrow');
    expect(r).toEqual({ shown: 2, fresh: false });
    expect(shown(manager)).toEqual(['A1', 'B10']);
    history.undo();
    expect(manager.hasHidden()).toBe(false);
    history.redo();
    expect(shown(manager)).toEqual(['A1', 'B10']);
  });

  it('a second show-only narrows the first (AND)', () => {
    const { manager, history } = setup();
    manager.showOnly(scope(['A', 1], ['A', 2], ['B', 10]), 'narrow');
    const r = manager.showOnly(scope(['A', 2], ['A', 3], ['B', 10], ['B', 20]), 'narrow');
    expect(r).toEqual({ shown: 2, fresh: false });
    expect(shown(manager)).toEqual(['A2', 'B10']);
    history.undo();
    expect(shown(manager)).toEqual(['A1', 'A2', 'B10']);
  });

  it('starts over with all of them when none of them is visible now', () => {
    const { manager } = setup();
    manager.showOnly(scope(['A', 1]), 'narrow');
    const r = manager.showOnly(scope(['A', 3], ['B', 20]), 'narrow');
    expect(r).toEqual({ shown: 2, fresh: true });
    expect(shown(manager)).toEqual(['A3', 'B20']);
  });

  it('add shows them as well, hiding nothing (OR)', () => {
    const { manager, history } = setup();
    manager.showOnly(scope(['A', 1]), 'narrow');
    manager.showOnly(scope(['A', 3], ['B', 20]), 'add');
    expect(shown(manager)).toEqual(['A1', 'A3', 'B20']);
    history.undo();
    expect(shown(manager)).toEqual(['A1']);
  });

  it('does nothing for no elements, rather than hiding everything', () => {
    const { manager, history } = setup();
    expect(manager.showOnly([], 'narrow')).toEqual({ shown: 0, fresh: false });
    expect(manager.hasHidden()).toBe(false);
    expect(history.canUndo()).toBe(false);
  });

  it('tells the renderer once per model, in at most two calls', () => {
    const { env, manager } = setup();
    const spy = vi.spyOn(env.modelManager, 'setHidden');
    manager.showOnly(scope(['A', 1], ['A', 2]), 'narrow');
    // A: two hidden (no shown change); B: both hidden.
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(['A', 'B']);
  });

  it('isolate still works as before through the shared path', () => {
    const { manager } = setup();
    manager.hide(scope(['A', 1]));
    manager.isolate(scope(['A', 1], ['A', 2]));
    expect(shown(manager)).toEqual(['A1', 'A2']);
  });
});
