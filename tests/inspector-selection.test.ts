// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  SelectionManager,
  SINGLE_MODEL_LOCK_STORAGE_KEY,
} from '../src/inspector/SelectionManager';
import type { SelectionManagerDeps } from '../src/inspector/SelectionManager';
import { AppearanceManager } from '../src/viewer/AppearanceManager';
import { HistoryManager } from '../src/core/history/HistoryManager';
import type { Tool, ToolManager } from '../src/tools/Tool';
import type { Viewer } from '../src/viewer/Viewer';
import type { ModelManager, ModelEntry } from '../src/viewer/ModelManager';
import type { ElementIdentity, SelectionState } from '../src/inspector/types';
import type { ParsedModel } from '../src/parser/types';
import { boxModel, boxMesh, makeModelManager, cameraLookingAt } from './helpers/models';

// ── localStorage mock — must be installed before SelectionManager is
// constructed because its constructor reads the persisted lock flag.
const lsStore = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => {
      lsStore.set(k, v);
    },
    removeItem: (k: string) => {
      lsStore.delete(k);
    },
    clear: () => lsStore.clear(),
    get length() {
      return lsStore.size;
    },
    key: (i: number) => [...lsStore.keys()][i] ?? null,
  },
  writable: true,
  configurable: true,
});

/**
 * Tests focus on:
 *   - Pure state transitions via `apply(mode, identity)` (no DOM dispatch).
 *   - Highlight on / off per element (read back from the real ModelManager).
 *   - Tool / pivot ownership gating: SelectionManager must NOT mutate state
 *     when a tool is active or pivot picking is on.
 *   - `clear()` and `onModelRemoved()` lifecycle.
 *
 * Click-event integration (the pointerdown + pointerup pair routing through
 * raycastVisible) is covered by manual smoke tests; doing it here would
 * require a full WebGLRenderer + Camera + Scene fixture which is heavier
 * than this phase needs. The `handleClick` path is exercised indirectly
 * by the bail-when-tool-active test, which proves the listener is wired.
 */

// ── Fixtures ────────────────────────────────────────────────

/** A model of unit boxes, one per id (a repeated id = a two-piece element). */
function makeModelEntry(modelId: string, expressIds: number[]): ParsedModel {
  return boxModel(modelId, expressIds);
}

function identity(modelId: string, expressId: number): ElementIdentity {
  return { modelId, expressId, ifcClass: '', ifcTypeCode: 0 };
}

/** Thin facade over a real ModelManager so test bodies read like a map. */
interface ModelStore {
  set(id: string, model: ParsedModel): void;
  get(id: string): ModelEntry | undefined;
  delete(id: string): void;
}

function makeStubDeps(): {
  deps: SelectionManagerDeps;
  modelManager: ModelManager;
  modelStore: ModelStore;
  toolState: { active: Tool | null };
  pivotState: { picking: boolean };
  canvas: HTMLCanvasElement;
} {
  const { modelManager, scene } = makeModelManager();
  const modelStore: ModelStore = {
    set: (_id, model) => void modelManager.addModel(model),
    get: (id) => modelManager.getModel(id),
    delete: (id) => void modelManager.removeModel(id),
  };
  const toolState = { active: null as Tool | null };
  const pivotState = { picking: false };
  const canvas = document.createElement('canvas');

  const viewer = {
    getCanvas: () => canvas,
    getScene: () => scene,
    getCamera: () => new THREE.PerspectiveCamera(),
    getRenderer: () => ({ clippingPlanes: [] }) as unknown as THREE.WebGLRenderer,
    isPivotPicking: () => pivotState.picking,
    requestRender: () => { /* no-op for tests */ },
  } as unknown as Viewer;

  const toolManager = {
    getActiveTool: () => toolState.active,
  } as unknown as ToolManager;

  return {
    deps: { viewer, modelManager, toolManager, canvas },
    modelManager,
    modelStore,
    toolState,
    pivotState,
    canvas,
  };
}

/** Whether an element is drawn highlighted right now. */
function highlighted(mm: ModelManager, modelId: string, expressId: number): boolean {
  return mm.getElementState(modelId, expressId)?.highlighted ?? false;
}

// ── Tests ───────────────────────────────────────────────────

describe('SelectionManager — state transitions', () => {
  let env: ReturnType<typeof makeStubDeps>;
  let manager: SelectionManager;

  beforeEach(() => {
    lsStore.clear();
    env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1, 2, 3]));
    env.modelStore.set('B', makeModelEntry('B', [10, 20]));
    manager = new SelectionManager(env.deps);
  });

  it('starts with kind: none', () => {
    expect(manager.getState()).toEqual({ kind: 'none' });
  });

  it('replace from empty selects single element', () => {
    const state = manager.apply('replace', identity('A', 1));
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0]).toEqual(identity('A', 1));
    }
  });

  it('replace with different element swaps selection', () => {
    manager.apply('replace', identity('A', 1));
    const state = manager.apply('replace', identity('A', 2));
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0].expressId).toBe(2);
    }
  });

  it('replace with same element is a no-op (state unchanged)', () => {
    manager.apply('replace', identity('A', 1));
    const listener = vi.fn();
    manager.onChange(listener);
    manager.apply('replace', identity('A', 1));
    // The state remained kind: single with same identity, and listener was
    // still notified (we accept that as a defensible choice — but state
    // value is unchanged).
    expect(manager.getState().kind).toBe('single');
  });

  it('add from empty selects single element (ctrl on empty)', () => {
    const state = manager.apply('add', identity('A', 1));
    expect(state.kind).toBe('single');
  });

  it('add of a second element produces multi', () => {
    manager.apply('add', identity('A', 1));
    const state = manager.apply('add', identity('A', 2));
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.identities.map((i) => i.expressId)).toEqual([1, 2]);
    }
  });

  it('add of an already-selected element toggles it off', () => {
    manager.apply('add', identity('A', 1));
    manager.apply('add', identity('A', 2));
    const state = manager.apply('add', identity('A', 1));
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0].expressId).toBe(2);
    }
  });

  it('remove on unselected element is a no-op', () => {
    manager.apply('replace', identity('A', 1));
    const state = manager.apply('remove', identity('A', 2));
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0].expressId).toBe(1);
    }
  });

  it('remove of a selected element drops it from multi', () => {
    manager.apply('add', identity('A', 1));
    manager.apply('add', identity('A', 2));
    manager.apply('add', identity('A', 3));
    const state = manager.apply('remove', identity('A', 2));
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.identities.map((i) => i.expressId)).toEqual([1, 3]);
    }
  });

  it('remove of the last selected element returns to none', () => {
    manager.apply('replace', identity('A', 1));
    const state = manager.apply('remove', identity('A', 1));
    expect(state.kind).toBe('none');
  });

  it('add freely spans models when the single-model lock is off', () => {
    manager.setSingleModelLock(false);
    manager.apply('add', identity('A', 1));
    const state = manager.apply('add', identity('B', 10));
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      const keys = state.identities.map((i) => `${i.modelId}:${i.expressId}`);
      expect(keys).toEqual(['A:1', 'B:10']);
    }
  });

  it('clear() returns selection to none', () => {
    manager.apply('add', identity('A', 1));
    manager.apply('add', identity('A', 2));
    manager.clear();
    expect(manager.getState()).toEqual({ kind: 'none' });
  });

  it('clear() on empty selection is a no-op and does not notify', () => {
    const listener = vi.fn();
    manager.onChange(listener);
    manager.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  it('onChange listener fires when selection mutates', () => {
    const listener = vi.fn();
    manager.onChange(listener);
    manager.apply('replace', identity('A', 1));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].kind).toBe('single');
  });

  it('onChange unsubscribe stops further notifications', () => {
    const listener = vi.fn();
    const unsub = manager.onChange(listener);
    manager.apply('replace', identity('A', 1));
    unsub();
    manager.apply('replace', identity('A', 2));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('SelectionManager — highlight lifecycle', () => {
  it('highlights every piece of the selected element and nothing else', () => {
    const env = makeStubDeps();
    // Element 7 is made of two boxes (one element, two geometry pieces).
    env.modelStore.set('A', makeModelEntry('A', [7, 7, 8]));
    const batch = env.modelStore.get('A')!.batch;
    const manager = new SelectionManager(env.deps);

    manager.apply('replace', identity('A', 7));

    expect(highlighted(env.modelManager, 'A', 7)).toBe(true);
    expect(highlighted(env.modelManager, 'A', 8)).toBe(false);
    // Both pieces of 7 are framed by the highlight: the selection centre lies
    // midway between the two boxes (x = 0 and x = 2).
    expect(batch.pieceCount).toBe(3);
    expect(manager.getSelectionCenter()!.x).toBeCloseTo(1);
  });

  it('a highlighted element keeps its own colour and opacity', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);
    const before = env.modelManager.getElementState('A', 1)!;

    manager.apply('replace', identity('A', 1));

    const after = env.modelManager.getElementState('A', 1)!;
    expect(after.highlighted).toBe(true);
    expect(after.color).toEqual(before.color);
    expect(after.opacity).toBe(before.opacity);
    expect(after.hidden).toBe(false);
  });

  it('deselect clears the highlight', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);

    manager.apply('replace', identity('A', 1));
    expect(highlighted(env.modelManager, 'A', 1)).toBe(true);

    manager.clear();
    expect(highlighted(env.modelManager, 'A', 1)).toBe(false);
  });

  it('reselecting after deselect highlights again', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);

    manager.apply('replace', identity('A', 1));
    manager.clear();
    manager.apply('replace', identity('A', 1));
    expect(highlighted(env.modelManager, 'A', 1)).toBe(true);
  });

  it('highlight idempotent: re-picking the same element keeps it highlighted', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);

    manager.apply('replace', identity('A', 1));
    manager.apply('replace', identity('A', 1));
    expect(highlighted(env.modelManager, 'A', 1)).toBe(true);
  });

  it('swapping selection unhighlights A and highlights B', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1, 2]));
    const manager = new SelectionManager(env.deps);

    manager.apply('replace', identity('A', 1));
    expect(highlighted(env.modelManager, 'A', 1)).toBe(true);

    manager.apply('replace', identity('A', 2));
    expect(highlighted(env.modelManager, 'A', 1)).toBe(false);
    expect(highlighted(env.modelManager, 'A', 2)).toBe(true);
  });
});

describe('SelectionManager — tool / pivot ownership', () => {
  it('does not change selection when a tool is active (click path)', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    env.toolState.active = { name: 'measurement' } as Tool;
    const manager = new SelectionManager(env.deps);

    // Simulate a click: pointerdown then pointerup at same position.
    env.canvas.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10 }),
    );
    env.canvas.dispatchEvent(
      new PointerEvent('pointerup', { button: 0, clientX: 10, clientY: 10 }),
    );

    expect(manager.getState()).toEqual({ kind: 'none' });
  });

  it('does not change selection when pivot picking is active', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    env.pivotState.picking = true;
    const manager = new SelectionManager(env.deps);

    env.canvas.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10 }),
    );
    env.canvas.dispatchEvent(
      new PointerEvent('pointerup', { button: 0, clientX: 10, clientY: 10 }),
    );

    expect(manager.getState()).toEqual({ kind: 'none' });
  });

  it('ignores drag (movement >= 3px between down and up)', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);
    // Pre-seed a selection so we can verify the drag did NOT clear it.
    manager.apply('replace', identity('A', 1));

    env.canvas.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10 }),
    );
    env.canvas.dispatchEvent(
      new PointerEvent('pointerup', { button: 0, clientX: 30, clientY: 50 }),
    );

    // The "click" was a drag; no raycast, no clear.
    expect(manager.getState().kind).toBe('single');
  });

  it('ignores non-left-button clicks', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);
    manager.apply('replace', identity('A', 1));

    env.canvas.dispatchEvent(
      new PointerEvent('pointerdown', { button: 2, clientX: 10, clientY: 10 }),
    );
    env.canvas.dispatchEvent(
      new PointerEvent('pointerup', { button: 2, clientX: 10, clientY: 10 }),
    );

    expect(manager.getState().kind).toBe('single');
  });
});

describe('SelectionManager — lifecycle', () => {
  it('onModelRemoved drops selected entries from that model only', () => {
    lsStore.clear();
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    env.modelStore.set('B', makeModelEntry('B', [10]));
    const manager = new SelectionManager(env.deps);
    // Disable the single-model lock so we can have a real cross-model
    // multi-select to drop A from.
    manager.setSingleModelLock(false);

    manager.apply('add', identity('A', 1));
    manager.apply('add', identity('B', 10));
    expect(manager.getState().kind).toBe('multi');

    // Simulate App.removeModel('A'): notify SelectionManager first, then
    // drop A from the store (ModelManager.removeModel disposes the meshes).
    manager.onModelRemoved('A');
    env.modelStore.delete('A');

    const state = manager.getState();
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0].modelId).toBe('B');
    }
  });

  it('onModelRemoved on a model with no selection is a silent no-op', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    env.modelStore.set('B', makeModelEntry('B', [10]));
    const manager = new SelectionManager(env.deps);
    manager.apply('replace', identity('A', 1));

    const listener = vi.fn();
    manager.onChange(listener);
    manager.onModelRemoved('B');
    expect(listener).not.toHaveBeenCalled();
    expect(manager.getState().kind).toBe('single');
  });

  it('dispose() detaches listeners and clears state', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);
    manager.apply('replace', identity('A', 1));
    expect(highlighted(env.modelManager, 'A', 1)).toBe(true);

    manager.dispose();
    expect(highlighted(env.modelManager, 'A', 1)).toBe(false);
    expect(manager.getState().kind).toBe('none');

    // A subsequent canvas click should not throw or revive the manager.
    env.canvas.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, clientX: 5, clientY: 5 }),
    );
    env.canvas.dispatchEvent(
      new PointerEvent('pointerup', { button: 0, clientX: 5, clientY: 5 }),
    );
    expect(manager.getState().kind).toBe('none');
  });
});

// ── Phase 4: single-model lock ─────────────────────────────────

describe('SelectionManager — single-model lock (Phase 4)', () => {
  let env: ReturnType<typeof makeStubDeps>;
  let manager: SelectionManager;

  beforeEach(() => {
    lsStore.clear();
    env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1, 2, 3]));
    env.modelStore.set('B', makeModelEntry('B', [10, 20]));
    manager = new SelectionManager(env.deps);
  });

  it('lock is enabled by default', () => {
    expect(manager.isSingleModelLockEnabled()).toBe(true);
  });

  it('reads persisted lock value on construction', () => {
    lsStore.set(SINGLE_MODEL_LOCK_STORAGE_KEY, 'false');
    const env2 = makeStubDeps();
    env2.modelStore.set('A', makeModelEntry('A', [1]));
    const m2 = new SelectionManager(env2.deps);
    expect(m2.isSingleModelLockEnabled()).toBe(false);
  });

  it('setSingleModelLock persists to localStorage', () => {
    manager.setSingleModelLock(false);
    expect(lsStore.get(SINGLE_MODEL_LOCK_STORAGE_KEY)).toBe('false');
    manager.setSingleModelLock(true);
    expect(lsStore.get(SINGLE_MODEL_LOCK_STORAGE_KEY)).toBe('true');
  });

  it('setSingleModelLock emits onChange', () => {
    const listener = vi.fn();
    manager.onChange(listener);
    manager.setSingleModelLock(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setSingleModelLock with the same value is a no-op (no notify)', () => {
    const listener = vi.fn();
    manager.onChange(listener);
    manager.setSingleModelLock(true); // already on by default
    expect(listener).not.toHaveBeenCalled();
  });

  it('lock ON: ctrl+click in different model clears existing and starts fresh', () => {
    manager.apply('replace', identity('A', 1));
    expect(manager.getState().kind).toBe('single');
    const state = manager.apply('add', identity('B', 10));
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0].modelId).toBe('B');
      expect(state.identities[0].expressId).toBe(10);
    }
  });

  it('lock OFF: ctrl+click in different model adds (cross-model multi)', () => {
    manager.setSingleModelLock(false);
    manager.apply('add', identity('A', 1));
    const state = manager.apply('add', identity('B', 10));
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      const modelIds = state.identities.map((i) => i.modelId).sort();
      expect(modelIds).toEqual(['A', 'B']);
    }
  });

  it('lock ON: ctrl+click within the same model still adds normally', () => {
    manager.apply('add', identity('A', 1));
    const state = manager.apply('add', identity('A', 2));
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.identities.map((i) => i.expressId)).toEqual([1, 2]);
    }
  });

  it('lockedModelId on multi-state reflects the locked model when all share one', () => {
    manager.apply('add', identity('A', 1));
    manager.apply('add', identity('A', 2));
    const state = manager.getState();
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.lockedModelId).toBe('A');
    }
  });

  it('lockedModelId is undefined on a cross-model multi (lock off)', () => {
    manager.setSingleModelLock(false);
    manager.apply('add', identity('A', 1));
    manager.apply('add', identity('B', 10));
    const state = manager.getState();
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.lockedModelId).toBeUndefined();
    }
  });

  it('toggling lock ON with cross-model selection collapses to last-clicked model', () => {
    manager.setSingleModelLock(false);
    manager.apply('add', identity('A', 1));
    manager.apply('add', identity('A', 2));
    manager.apply('add', identity('B', 10)); // last-clicked is model B
    expect(manager.getState().kind).toBe('multi');

    manager.setSingleModelLock(true);
    const state = manager.getState();
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0].modelId).toBe('B');
      expect(state.identities[0].expressId).toBe(10);
    }
  });

  it('lock ON: plain "replace" pick in a different model still works (regression)', () => {
    manager.apply('replace', identity('A', 1));
    const state = manager.apply('replace', identity('B', 10));
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0].modelId).toBe('B');
    }
  });
});

// ── applyMany — batch selection for marquee ────────────────────

describe('SelectionManager — applyMany (batch)', () => {
  let env: ReturnType<typeof makeStubDeps>;
  let manager: SelectionManager;

  beforeEach(() => {
    lsStore.clear();
    env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1, 2, 3, 4, 5]));
    env.modelStore.set('B', makeModelEntry('B', [10, 20, 30]));
    manager = new SelectionManager(env.deps);
    // Most batch tests use the cross-model behaviour; opt out of the
    // single-model lock by default. The lock-specific test re-enables it.
    manager.setSingleModelLock(false);
  });

  it('replace with [] clears existing selection', () => {
    manager.apply('replace', identity('A', 1));
    const state = manager.applyMany('replace', []);
    expect(state.kind).toBe('none');
  });

  it('replace with [] on empty selection is a silent no-op', () => {
    const listener = vi.fn();
    manager.onChange(listener);
    manager.applyMany('replace', []);
    expect(listener).not.toHaveBeenCalled();
  });

  it('replace with one identity is equivalent to apply("replace", id)', () => {
    const state = manager.applyMany('replace', [identity('A', 1)]);
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0]).toEqual(identity('A', 1));
    }
  });

  it('replace with N selects all of them and drops prior selection', () => {
    manager.apply('replace', identity('A', 5)); // Will be dropped.
    const state = manager.applyMany('replace', [
      identity('A', 1),
      identity('A', 2),
      identity('A', 3),
    ]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.identities.map((i) => i.expressId).sort()).toEqual([1, 2, 3]);
    }
  });

  it('replace dedupes within the batch', () => {
    const state = manager.applyMany('replace', [
      identity('A', 1),
      identity('A', 2),
      identity('A', 1), // dup
      identity('A', 2), // dup
    ]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.identities.map((i) => i.expressId)).toEqual([1, 2]);
    }
  });

  it('add with N appends each new id, never toggles existing ones', () => {
    manager.apply('add', identity('A', 1));
    const state = manager.applyMany('add', [
      identity('A', 1), // already in → keep selected (no toggle)
      identity('A', 2),
      identity('A', 3),
    ]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.identities.map((i) => i.expressId).sort()).toEqual([1, 2, 3]);
    }
  });

  it('add dedupes within the batch', () => {
    const state = manager.applyMany('add', [
      identity('A', 1),
      identity('A', 1),
      identity('A', 2),
    ]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.identities.map((i) => i.expressId).sort()).toEqual([1, 2]);
    }
  });

  it('add of an empty batch is a no-op (no notify)', () => {
    manager.apply('replace', identity('A', 1));
    const listener = vi.fn();
    manager.onChange(listener);
    manager.applyMany('add', []);
    expect(listener).not.toHaveBeenCalled();
  });

  it('remove drops only the intersection of selection and batch', () => {
    manager.applyMany('replace', [
      identity('A', 1),
      identity('A', 2),
      identity('A', 3),
    ]);
    const state = manager.applyMany('remove', [
      identity('A', 2),
      identity('A', 4), // not in selection — no-op
      identity('A', 3),
    ]);
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0].expressId).toBe(1);
    }
  });

  it('remove of items none of which are selected is a silent no-op', () => {
    manager.apply('replace', identity('A', 1));
    const listener = vi.fn();
    manager.onChange(listener);
    manager.applyMany('remove', [identity('A', 2), identity('A', 3)]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('emits onChange exactly once per call', () => {
    const listener = vi.fn();
    manager.onChange(listener);
    manager.applyMany('replace', [
      identity('A', 1),
      identity('A', 2),
      identity('A', 3),
      identity('A', 4),
    ]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('singleModelLock=true + replace + multi-model batch keeps only the first model in batch', () => {
    manager.setSingleModelLock(true);
    const state = manager.applyMany('replace', [
      identity('A', 1),
      identity('B', 10),
      identity('A', 2),
      identity('B', 20),
    ]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      const modelIds = state.identities.map((i) => i.modelId);
      expect(new Set(modelIds)).toEqual(new Set(['A']));
      expect(state.identities.map((i) => i.expressId).sort()).toEqual([1, 2]);
    }
  });

  it('singleModelLock=true + add + existing selection in B keeps B regardless of batch order', () => {
    // Regression for the bug where applyMany picked the first model in the
    // batch (which depends on marquee iteration order = ModelManager
    // insertion order). For add/remove the lock must preserve the existing
    // selection's model, not the batch's first item.
    manager.setSingleModelLock(true);
    manager.apply('replace', identity('B', 100));
    // Batch lists A items first (mimicking insertion-order iteration), but
    // selection is in B → add should keep only B items.
    const state = manager.applyMany('add', [
      identity('A', 1),
      identity('B', 10),
      identity('A', 2),
      identity('B', 20),
    ]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      const modelIds = state.identities.map((i) => i.modelId);
      expect(new Set(modelIds)).toEqual(new Set(['B']));
      expect(state.identities.map((i) => i.expressId).sort((a, b) => a - b)).toEqual([10, 20, 100]);
    }
  });

  it('singleModelLock=true + remove + existing selection in B preserves B model', () => {
    manager.setSingleModelLock(true);
    manager.applyMany('replace', [identity('B', 10), identity('B', 20)]);
    // Batch contains both A (which isn't in selection) and B items.
    // remove should only act on B items.
    const state = manager.applyMany('remove', [
      identity('A', 1),
      identity('B', 10),
      identity('A', 2),
    ]);
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0].modelId).toBe('B');
      expect(state.identities[0].expressId).toBe(20);
    }
  });

  it('singleModelLock=true + add from empty selection falls back to first model in batch', () => {
    manager.setSingleModelLock(true);
    expect(manager.getState().kind).toBe('none');
    const state = manager.applyMany('add', [
      identity('A', 1),
      identity('B', 10),
      identity('A', 2),
    ]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      const modelIds = state.identities.map((i) => i.modelId);
      expect(new Set(modelIds)).toEqual(new Set(['A']));
      expect(state.identities.map((i) => i.expressId).sort()).toEqual([1, 2]);
    }
  });

  it('singleModelLock=false + multi-model batch keeps everything', () => {
    const state = manager.applyMany('replace', [
      identity('A', 1),
      identity('B', 10),
    ]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.identities.map((i) => `${i.modelId}:${i.expressId}`).sort()).toEqual([
        'A:1',
        'B:10',
      ]);
    }
  });

  it('singleModelLock with single-model batch passes through unchanged', () => {
    manager.setSingleModelLock(true);
    const state = manager.applyMany('replace', [
      identity('A', 1),
      identity('A', 2),
    ]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.identities.map((i) => i.expressId).sort()).toEqual([1, 2]);
    }
  });

  it('highlights are applied for every added identity', () => {
    manager.applyMany('replace', [identity('A', 1), identity('A', 2)]);
    // Elements 1 and 2 highlighted, 3 untouched.
    expect(highlighted(env.modelManager, 'A', 1)).toBe(true);
    expect(highlighted(env.modelManager, 'A', 2)).toBe(true);
    expect(highlighted(env.modelManager, 'A', 3)).toBe(false);
  });

  it('replace from N to [] clears every highlight', () => {
    manager.applyMany('replace', [identity('A', 1), identity('A', 2)]);
    expect(highlighted(env.modelManager, 'A', 1)).toBe(true);
    manager.applyMany('replace', []);
    expect(highlighted(env.modelManager, 'A', 1)).toBe(false);
    expect(highlighted(env.modelManager, 'A', 2)).toBe(false);
  });
});

// ── Highlight scaling (variant cache) ───────────────────────────

describe('SelectionManager — highlight scaling', () => {
  it('highlighting thousands of elements adds no materials or meshes (one draw state, not one clone each)', () => {
    const env = makeStubDeps();
    const ids = Array.from({ length: 2000 }, (_, i) => i + 1);
    env.modelStore.set('A', makeModelEntry('A', ids));
    const entry = env.modelStore.get('A')!;
    const childrenBefore = entry.group.children.length;
    const materialsBefore = new Set(entry.batch.chunkMeshes().map((m) => m.material));
    const manager = new SelectionManager(env.deps);

    manager.applyMany('replace', ids.map((id) => identity('A', id)));

    expect(manager.getState().kind).toBe('multi');
    expect(ids.every((id) => highlighted(env.modelManager, 'A', id))).toBe(true);
    expect(entry.group.children.length).toBe(childrenBefore);
    const materialsAfter = new Set(entry.batch.chunkMeshes().map((m) => m.material));
    expect(materialsAfter).toEqual(materialsBefore);
  });

  it('elements of different colours are all highlighted and keep their own colours', () => {
    const env = makeStubDeps();
    const red = { r: 1, g: 0, b: 0, a: 1 };
    const blue = { r: 0, g: 0, b: 1, a: 1 };
    env.modelStore.set('A', {
      id: 'A',
      meshes: [boxMesh(1, { color: red }), boxMesh(2, { color: blue, at: [2, 0, 0] })],
    });
    const manager = new SelectionManager(env.deps);

    manager.applyMany('replace', [identity('A', 1), identity('A', 2)]);

    const s1 = env.modelManager.getElementState('A', 1)!;
    const s2 = env.modelManager.getElementState('A', 2)!;
    expect(s1.highlighted && s2.highlighted).toBe(true);
    expect(s1.color).toEqual({ r: 1, g: 0, b: 0 });
    expect(s2.color).toEqual({ r: 0, g: 0, b: 1 });
  });

  it('reselecting the same element after deselect highlights it again', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);

    manager.apply('replace', identity('A', 1));
    expect(highlighted(env.modelManager, 'A', 1)).toBe(true);

    manager.clear();
    expect(highlighted(env.modelManager, 'A', 1)).toBe(false);

    manager.apply('replace', identity('A', 1));
    expect(highlighted(env.modelManager, 'A', 1)).toBe(true);
  });

  it('removing a model releases highlight bookkeeping for that model only', () => {
    // We can't directly observe WeakMap entries getting GC'd, but we CAN
    // verify the manager drops its highlight refs for the removed model.
    // The variant cache itself is keyed by the original material, which
    // ModelManager.removeModel disposes — once that material is GC'd, its
    // WeakMap entry releases automatically.
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1, 2]));
    env.modelStore.set('B', makeModelEntry('B', [10]));
    const manager = new SelectionManager(env.deps);
    manager.setSingleModelLock(false);

    manager.applyMany('add', [identity('A', 1), identity('A', 2), identity('B', 10)]);
    expect(manager.getState().kind).toBe('multi');

    manager.onModelRemoved('A');
    env.modelStore.delete('A');

    // Only B's selection survives; A's highlight refs are gone.
    const state = manager.getState();
    expect(state.kind).toBe('single');
    if (state.kind === 'single') {
      expect(state.identities[0].modelId).toBe('B');
    }
  });
});

// ── selectExactly — lock-bypassing recall path (Selection Basket, D3) ──
//
// MR (basket recall) must select the whole basket across models WITHOUT
// mutating the persisted single-model-lock preference. `applyMany('replace',
// …)` honours the lock (collapses the batch to one model), so recall uses
// `selectExactly(identities)` instead. These tests pin the two invariants
// that make D3 safe: (1) cross-model selection happens even when the lock is
// ON, and (2) the persisted lock preference is untouched.
describe('SelectionManager — selectExactly (basket recall, lock-bypassing)', () => {
  let env: ReturnType<typeof makeStubDeps>;
  let manager: SelectionManager;

  beforeEach(() => {
    lsStore.clear();
    env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1, 2, 3]));
    env.modelStore.set('B', makeModelEntry('B', [10, 20]));
    manager = new SelectionManager(env.deps); // lock defaults ON
  });

  it('selects elements across models even with the single-model lock ON', () => {
    expect(manager.isSingleModelLockEnabled()).toBe(true);
    const state = manager.selectExactly([identity('A', 1), identity('B', 10)]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      const keys = state.identities.map((i) => `${i.modelId}:${i.expressId}`);
      expect(keys).toEqual(['A:1', 'B:10']);
    }
  });

  it('does NOT mutate the persisted single-model-lock preference', () => {
    manager.selectExactly([identity('A', 1), identity('B', 10)]);
    // In-memory flag unchanged…
    expect(manager.isSingleModelLockEnabled()).toBe(true);
    // …and localStorage is not written by recall (no key, or still 'true').
    const persisted = lsStore.get(SINGLE_MODEL_LOCK_STORAGE_KEY);
    expect(persisted === undefined || persisted === 'true').toBe(true);
  });

  it('replaces the existing selection (replace semantics)', () => {
    manager.apply('replace', identity('A', 2));
    const state = manager.selectExactly([identity('A', 1), identity('B', 10)]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.identities.map((i) => `${i.modelId}:${i.expressId}`)).toEqual(['A:1', 'B:10']);
    }
  });

  it('dedupes within the batch', () => {
    const state = manager.selectExactly([identity('A', 1), identity('A', 1), identity('B', 10)]);
    expect(state.kind).toBe('multi');
    if (state.kind === 'multi') {
      expect(state.identities.length).toBe(2);
    }
  });

  it('empty input clears the selection', () => {
    manager.apply('replace', identity('A', 1));
    const state = manager.selectExactly([]);
    expect(state.kind).toBe('none');
  });

  it('emits onChange once for a mutating recall', () => {
    const listener = vi.fn();
    manager.onChange(listener);
    manager.selectExactly([identity('A', 1), identity('B', 10)]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('highlights elements in every recalled model', () => {
    manager.selectExactly([identity('A', 1), identity('B', 10)]);
    expect(highlighted(env.modelManager, 'A', 1)).toBe(true);
    expect(highlighted(env.modelManager, 'B', 10)).toBe(true);
  });
});

// ── Undo / redo integration (HistoryManager-backed selection) ──────────
//
// SelectionManager takes an OPTIONAL `history` dep. When present, each
// USER-initiated mutation (single apply, batch applyMany, recall
// selectExactly, user clear) pushes exactly ONE command; SYSTEM changes
// (onModelRemoved pruning, session restore) push none; and a command's
// own re-apply (undo/redo) must never push a fresh command. These tests use
// a real HistoryManager so the round-trips exercise the live stacks.
describe('SelectionManager — undo / redo (history-backed)', () => {
  let env: ReturnType<typeof makeStubDeps>;
  let history: HistoryManager;
  let manager: SelectionManager;

  function key(state: SelectionState): string {
    if (state.kind === 'none') return 'none';
    return state.identities
      .map((i) => `${i.modelId}:${i.expressId}`)
      .sort()
      .join(',');
  }

  beforeEach(() => {
    lsStore.clear();
    env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1, 2, 3, 4, 5]));
    env.modelStore.set('B', makeModelEntry('B', [10, 20, 30]));
    history = new HistoryManager();
    manager = new SelectionManager({ ...env.deps, history });
    manager.setSingleModelLock(false);
  });

  it('T12: one applyMany("replace", N ids) pushes exactly ONE command', () => {
    manager.applyMany('replace', [identity('A', 1), identity('A', 2), identity('A', 3)]);
    expect(history.canUndo()).toBe(true);
    // Exactly one undo step walks the whole batch back.
    history.undo();
    expect(history.canUndo()).toBe(false);
    expect(manager.getState().kind).toBe('none');
  });

  it('T13: undo restores the prior selection exactly; redo re-applies exactly', () => {
    manager.apply('replace', identity('A', 1));
    const afterFirst = key(manager.getState());

    manager.applyMany('replace', [identity('A', 2), identity('B', 10)]);
    const afterSecond = key(manager.getState());
    expect(afterSecond).not.toBe(afterFirst);

    history.undo();
    expect(key(manager.getState())).toBe(afterFirst);
    expect(manager.getState().kind).toBe('single');

    history.redo();
    expect(key(manager.getState())).toBe(afterSecond);
  });

  it('T14: each single apply pushes one command; three picks → three undo steps walk back', () => {
    manager.apply('replace', identity('A', 1)); // A:1
    manager.apply('add', identity('A', 2)); // A:1,A:2
    manager.apply('add', identity('A', 3)); // A:1,A:2,A:3
    expect(key(manager.getState())).toBe('A:1,A:2,A:3');

    history.undo();
    expect(key(manager.getState())).toBe('A:1,A:2');
    history.undo();
    expect(key(manager.getState())).toBe('A:1');
    history.undo();
    expect(manager.getState().kind).toBe('none');
    expect(history.canUndo()).toBe(false);
  });

  it('T15: onModelRemoved pruning pushes NO command', () => {
    manager.applyMany('add', [identity('A', 1), identity('B', 10)]);
    // Drain the stack so we can detect any spurious push from pruning.
    history.clear();
    expect(history.canUndo()).toBe(false);

    manager.onModelRemoved('A');
    expect(history.canUndo()).toBe(false);
    // The prune still happened (B survives), it just wasn't recorded.
    expect(manager.getState().kind).toBe('single');
  });

  it('T16: a command re-apply (undo/redo) does not itself push a new command', () => {
    manager.apply('replace', identity('A', 1));
    manager.apply('replace', identity('A', 2));
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);

    history.undo(); // restores A:1 via selectExactly — must NOT push
    expect(history.canRedo()).toBe(true);
    // Walk all the way back: still exactly the two original steps, no extras.
    history.undo();
    expect(manager.getState().kind).toBe('none');
    expect(history.canUndo()).toBe(false);

    history.redo();
    expect(key(manager.getState())).toBe('A:1');
    history.redo();
    expect(key(manager.getState())).toBe('A:2');
    expect(history.canRedo()).toBe(false);
  });

  it('T17: user clear() pushes one command; undo restores the cleared selection', () => {
    manager.applyMany('replace', [identity('A', 1), identity('A', 2)]);
    const before = key(manager.getState());

    manager.clear();
    expect(manager.getState().kind).toBe('none');

    history.undo();
    expect(key(manager.getState())).toBe(before);
  });

  it('T18: selectExactly (recall) pushes one command; undo restores the prior selection', () => {
    manager.apply('replace', identity('A', 1));
    const before = key(manager.getState());

    manager.selectExactly([identity('A', 2), identity('B', 10)]);
    const after = key(manager.getState());
    expect(after).not.toBe(before);

    history.undo();
    expect(key(manager.getState())).toBe(before);
    history.redo();
    expect(key(manager.getState())).toBe(after);
  });

  it('T19: undo restoring a cross-model selection does NOT mutate the single-model-lock preference', () => {
    // Use a fresh manager with the lock ON (default), so we can prove restore
    // bypasses the lock without flipping the preference. Clear lsStore first:
    // the shared beforeEach constructs a manager with the lock OFF, which
    // persists 'false' — we need the default-ON read for this test's intent.
    lsStore.clear();
    const env2 = makeStubDeps();
    env2.modelStore.set('A', makeModelEntry('A', [1, 2]));
    env2.modelStore.set('B', makeModelEntry('B', [10]));
    const history2 = new HistoryManager();
    const m2 = new SelectionManager({ ...env2.deps, history: history2 });
    expect(m2.isSingleModelLockEnabled()).toBe(true);

    // Build a cross-model selection WITHOUT touching the lock preference,
    // via the lock-bypassing recall path.
    m2.selectExactly([identity('A', 1), identity('B', 10)]);
    expect(m2.getState().kind).toBe('multi');

    // Now replace it (single model), then undo back to the cross-model state.
    m2.apply('replace', identity('A', 2));
    history2.undo();

    const restored = m2.getState();
    expect(restored.kind).toBe('multi');
    if (restored.kind === 'multi') {
      const keys = restored.identities.map((i) => `${i.modelId}:${i.expressId}`).sort();
      expect(keys).toEqual(['A:1', 'B:10']);
    }
    // The lock preference is untouched by the undo restore.
    expect(m2.isSingleModelLockEnabled()).toBe(true);
    const persisted = lsStore.get(SINGLE_MODEL_LOCK_STORAGE_KEY);
    expect(persisted === undefined || persisted === 'true').toBe(true);
  });
});

// ── Highlight ↔ appearance interplay ─────────────────────────────────
//
// Highlight, opacity and visibility are independent per-element attributes in
// the renderer (ModelManager / ModelBatch), so the precedence
// hidden > transparent > highlighted > base holds by construction, whatever
// order the two managers act in. These tests wire a REAL AppearanceManager and
// SelectionManager to ONE real ModelManager, as App does, and pin that.
describe('SelectionManager ↔ AppearanceManager interplay', () => {
  function makeInterplayEnv() {
    lsStore.clear();
    const base = makeStubDeps();
    base.modelStore.set('A', makeModelEntry('A', [1, 2, 3]));
    const appearance = new AppearanceManager({ modelManager: base.modelManager });
    const manager = new SelectionManager(base.deps);
    manager.setSingleModelLock(false);
    const state = (id: number) => base.modelManager.getElementState('A', id)!;
    return { manager, appearance, state };
  }

  it('T12: a transparent element that is then selected shows BOTH highlight and transparency', () => {
    const { manager, appearance, state } = makeInterplayEnv();

    appearance.transparent([identity('A', 1)]);
    manager.apply('replace', identity('A', 1));

    expect(state(1).highlighted).toBe(true);
    expect(state(1).opacity).toBeCloseTo(0.25);
  });

  it('T13: opaque on a still-selected element keeps the highlight', () => {
    const { manager, appearance, state } = makeInterplayEnv();

    appearance.transparent([identity('A', 1)]);
    manager.apply('replace', identity('A', 1));
    appearance.opaque([identity('A', 1)]);

    expect(state(1).highlighted).toBe(true);
    expect(state(1).opacity).toBe(1);
  });

  it('T14: deselecting a transparent element keeps it transparent', () => {
    const { manager, appearance, state } = makeInterplayEnv();

    appearance.transparent([identity('A', 1)]);
    manager.apply('replace', identity('A', 1));
    manager.clear();

    expect(state(1).highlighted).toBe(false);
    expect(state(1).opacity).toBeCloseTo(0.25);
  });

  it('T14b: ORDER INDEPENDENCE — select FIRST, THEN make transparent → both; deselect → stays transparent', () => {
    const { manager, appearance, state } = makeInterplayEnv();

    manager.apply('replace', identity('A', 1));
    appearance.transparent([identity('A', 1)]);

    expect(state(1).highlighted).toBe(true);
    expect(state(1).opacity).toBeCloseTo(0.25);

    manager.clear();
    expect(state(1).highlighted).toBe(false);
    expect(state(1).opacity).toBeCloseTo(0.25);
  });

  it('hiding a selected element keeps it selected but not drawn; show-all brings it back highlighted', () => {
    const { manager, appearance, state } = makeInterplayEnv();

    manager.apply('replace', identity('A', 2));
    appearance.hide([identity('A', 2)]);
    expect(state(2).hidden).toBe(true);
    expect(manager.getState().kind).toBe('single');

    appearance.showAll();
    expect(state(2).hidden).toBe(false);
    expect(state(2).highlighted).toBe(true);
  });
});

describe('SelectionManager — click path (real raycast)', () => {
  function makeClickEnv() {
    lsStore.clear();
    const env = makeStubDeps();
    // Box 1 at the origin, box 2 at x = 2; camera looks straight at box 1.
    env.modelStore.set('A', makeModelEntry('A', [1, 2]));
    const camera = cameraLookingAt([0, 0, 10], [0, 0, 0]);
    (env.deps.viewer as unknown as { getCamera: () => THREE.Camera }).getCamera = () => camera;
    env.canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0 }) as DOMRect;
    const manager = new SelectionManager(env.deps);
    const click = (x: number, y: number, init: PointerEventInit = {}) => {
      env.canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: x, clientY: y, ...init }));
      env.canvas.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: x, clientY: y, ...init }));
    };
    return { env, manager, click };
  }

  it('a click on an element selects and highlights it', () => {
    const { env, manager, click } = makeClickEnv();
    click(50, 50); // screen centre → box 1
    const state = manager.getState();
    expect(state.kind).toBe('single');
    if (state.kind === 'single') expect(state.identities[0]).toMatchObject({ modelId: 'A', expressId: 1 });
    expect(highlighted(env.modelManager, 'A', 1)).toBe(true);
  });

  it('a click on empty space clears the selection', () => {
    const { manager, click } = makeClickEnv();
    click(50, 50);
    click(50, 5); // well above the boxes
    expect(manager.getState().kind).toBe('none');
  });

  it('a hidden element is clicked through, not selected', () => {
    const { env, manager, click } = makeClickEnv();
    env.modelManager.setHidden('A', [1], true);
    click(50, 50);
    expect(manager.getState().kind).toBe('none');
  });
});
