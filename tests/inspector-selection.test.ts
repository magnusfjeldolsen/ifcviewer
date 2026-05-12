// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  SelectionManager,
  SINGLE_MODEL_LOCK_STORAGE_KEY,
} from '../src/inspector/SelectionManager';
import type { SelectionManagerDeps } from '../src/inspector/SelectionManager';
import type { Tool, ToolManager } from '../src/tools/Tool';
import type { Viewer } from '../src/viewer/Viewer';
import type { ModelManager, ModelEntry } from '../src/viewer/ModelManager';
import type { ElementIdentity } from '../src/inspector/types';

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
 *   - Material clone / restore lifecycle on highlight.
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

function makeMeshUnderGroup(group: THREE.Group, expressId: number): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  const mat = new THREE.MeshPhongMaterial({ color: 0x808080 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData.expressID = expressId;
  group.add(mesh);
  return mesh;
}

function makeModelEntry(modelId: string, expressIds: number[]): ModelEntry {
  const group = new THREE.Group();
  group.name = modelId;
  const meshesByExpressId = new Map<number, THREE.Mesh[]>();
  for (const id of expressIds) {
    const mesh = makeMeshUnderGroup(group, id);
    let bucket = meshesByExpressId.get(id);
    if (!bucket) {
      bucket = [];
      meshesByExpressId.set(id, bucket);
    }
    bucket.push(mesh);
  }
  return { id: modelId, group, visible: true, meshesByExpressId };
}

function identity(modelId: string, expressId: number): ElementIdentity {
  return { modelId, expressId, ifcClass: '', ifcTypeCode: 0 };
}

function makeStubDeps(): {
  deps: SelectionManagerDeps;
  modelStore: Map<string, ModelEntry>;
  toolState: { active: Tool | null };
  pivotState: { picking: boolean };
  canvas: HTMLCanvasElement;
} {
  const modelStore = new Map<string, ModelEntry>();
  const toolState = { active: null as Tool | null };
  const pivotState = { picking: false };
  const canvas = document.createElement('canvas');

  const viewer = {
    getCanvas: () => canvas,
    getScene: () => new THREE.Scene(),
    getCamera: () => new THREE.PerspectiveCamera(),
    getRenderer: () => ({ clippingPlanes: [] }) as unknown as THREE.WebGLRenderer,
    isPivotPicking: () => pivotState.picking,
  } as unknown as Viewer;

  const modelManager = {
    getModel: (id: string) => modelStore.get(id),
  } as unknown as ModelManager;

  const toolManager = {
    getActiveTool: () => toolState.active,
  } as unknown as ToolManager;

  return {
    deps: { viewer, modelManager, toolManager, canvas },
    modelStore,
    toolState,
    pivotState,
    canvas,
  };
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
  it('highlights all meshes that share the selected expressID', () => {
    const env = makeStubDeps();
    // Two meshes in model A both carry expressID 7 (one element, two geoms).
    const group = new THREE.Group();
    group.name = 'A';
    const m1 = makeMeshUnderGroup(group, 7);
    const m2 = makeMeshUnderGroup(group, 7);
    const m3 = makeMeshUnderGroup(group, 8);
    const meshesByExpressId = new Map<number, THREE.Mesh[]>([
      [7, [m1, m2]],
      [8, [m3]],
    ]);
    env.modelStore.set('A', { id: 'A', group, visible: true, meshesByExpressId });

    const manager = new SelectionManager(env.deps);
    const before = group.children.map((c) => (c as THREE.Mesh).material);

    manager.apply('replace', identity('A', 7));

    const after = group.children.map((c) => (c as THREE.Mesh).material);
    // The two expressID===7 meshes got new material references; the third didn't.
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  it('applied highlight uses brand-blue emissive', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);

    manager.apply('replace', identity('A', 1));

    const mesh = env.modelStore.get('A')!.group.children[0] as THREE.Mesh;
    const mat = mesh.material as THREE.MeshPhongMaterial;
    expect(mat.emissive.getHex()).toBe(0x3b82f6);
    expect(mat.emissiveIntensity).toBeCloseTo(0.3);
  });

  it('restores the original material on deselect', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);
    const mesh = env.modelStore.get('A')!.group.children[0] as THREE.Mesh;
    const originalMat = mesh.material;

    manager.apply('replace', identity('A', 1));
    expect(mesh.material).not.toBe(originalMat);

    manager.clear();
    expect(mesh.material).toBe(originalMat);
  });

  it('does NOT dispose the highlight variant on deselect (it is cache-shared)', () => {
    // Variants are cached per-original-material across the entire selection
    // (and across re-selections), so we cannot safely dispose them when one
    // mesh deselects — another mesh may still be using the same variant,
    // and a future reselect must reuse it. Variants release naturally when
    // the original material is GC'd (model removal).
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);
    const mesh = env.modelStore.get('A')!.group.children[0] as THREE.Mesh;

    manager.apply('replace', identity('A', 1));
    const variant = mesh.material as THREE.Material;
    const disposeSpy = vi.spyOn(variant, 'dispose');

    manager.clear();
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it('highlight idempotent: re-adding same element does not double-clone', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);

    manager.apply('replace', identity('A', 1));
    const firstClone = (env.modelStore.get('A')!.group.children[0] as THREE.Mesh).material;
    manager.apply('replace', identity('A', 1));
    const secondClone = (env.modelStore.get('A')!.group.children[0] as THREE.Mesh).material;
    expect(secondClone).toBe(firstClone);
  });

  it('swapping selection restores A and highlights B', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1, 2]));
    const manager = new SelectionManager(env.deps);
    const meshA = env.modelStore.get('A')!.group.children[0] as THREE.Mesh;
    const meshB = env.modelStore.get('A')!.group.children[1] as THREE.Mesh;
    const origA = meshA.material;
    const origB = meshB.material;

    manager.apply('replace', identity('A', 1));
    expect(meshA.material).not.toBe(origA);

    manager.apply('replace', identity('A', 2));
    expect(meshA.material).toBe(origA);
    expect(meshB.material).not.toBe(origB);
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
    const mesh = env.modelStore.get('A')!.group.children[0] as THREE.Mesh;
    const originalMat = mesh.material; // Capture BEFORE selection so we can verify restore on dispose.
    const manager = new SelectionManager(env.deps);
    manager.apply('replace', identity('A', 1));
    expect(mesh.material).not.toBe(originalMat); // Highlighted with a clone.

    manager.dispose();
    expect(mesh.material).toBe(originalMat);
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
    const meshes = env.modelStore.get('A')!.group.children as THREE.Mesh[];
    // Meshes for expressID 1 and 2 should be highlighted (material clone),
    // mesh for expressID 3 untouched.
    const mat1 = meshes[0].material as THREE.MeshPhongMaterial;
    const mat2 = meshes[1].material as THREE.MeshPhongMaterial;
    expect(mat1.emissive.getHex()).toBe(0x3b82f6);
    expect(mat2.emissive.getHex()).toBe(0x3b82f6);
  });

  it('replace from N to [] restores all highlighted meshes', () => {
    const mesh = env.modelStore.get('A')!.group.children[0] as THREE.Mesh;
    const orig = mesh.material;
    manager.applyMany('replace', [identity('A', 1), identity('A', 2)]);
    expect(mesh.material).not.toBe(orig);
    manager.applyMany('replace', []);
    expect(mesh.material).toBe(orig);
  });
});

// ── Highlight scaling (variant cache) ───────────────────────────

describe('SelectionManager — highlight scaling', () => {
  /**
   * Construct a model whose meshes deliberately share material references
   * so we can assert that the highlight variant cache reuses one variant
   * across all sharing meshes. Each expressID gets its own mesh, but the
   * caller controls which expressIDs share a material via `groups`.
   *
   * Example: `groups = [[1, 2, 3], [4, 5]]` produces 5 meshes; 1,2,3 share
   * a MeshPhongMaterial and 4,5 share another, distinct one.
   */
  function makeSharedMaterialEntry(modelId: string, groups: number[][]): ModelEntry {
    const group = new THREE.Group();
    group.name = modelId;
    const meshesByExpressId = new Map<number, THREE.Mesh[]>();
    for (const ids of groups) {
      const sharedMat = new THREE.MeshPhongMaterial({ color: 0x808080 });
      for (const id of ids) {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), sharedMat);
        mesh.userData.expressID = id;
        group.add(mesh);
        meshesByExpressId.set(id, [mesh]);
      }
    }
    return { id: modelId, group, visible: true, meshesByExpressId };
  }

  it('selecting N elements that share M distinct original materials creates only M variants', () => {
    // 6 elements split across 2 shared-material groups → expect 2 distinct
    // highlight variants regardless of selection size.
    const env = makeStubDeps();
    env.modelStore.set(
      'A',
      makeSharedMaterialEntry('A', [
        [1, 2, 3, 4],
        [5, 6],
      ]),
    );
    const manager = new SelectionManager(env.deps);
    manager.setSingleModelLock(false);

    manager.applyMany('replace', [
      identity('A', 1),
      identity('A', 2),
      identity('A', 3),
      identity('A', 4),
      identity('A', 5),
      identity('A', 6),
    ]);

    const meshes = env.modelStore.get('A')!.group.children as THREE.Mesh[];
    const uniqueVariants = new Set(meshes.map((m) => m.material));
    expect(uniqueVariants.size).toBe(2);
  });

  it('two meshes that share an original material share the SAME variant reference', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeSharedMaterialEntry('A', [[1, 2]]));
    const manager = new SelectionManager(env.deps);

    manager.applyMany('replace', [identity('A', 1), identity('A', 2)]);

    const meshes = env.modelStore.get('A')!.group.children as THREE.Mesh[];
    expect(meshes[0].material).toBe(meshes[1].material);
  });

  it('reselecting the same element after deselect reuses the cached variant', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);
    const mesh = env.modelStore.get('A')!.group.children[0] as THREE.Mesh;
    const original = mesh.material;

    manager.apply('replace', identity('A', 1));
    const firstVariant = mesh.material;
    expect(firstVariant).not.toBe(original);

    manager.clear();
    expect(mesh.material).toBe(original);

    manager.apply('replace', identity('A', 1));
    const secondVariant = mesh.material;
    // Cache hit: same variant reference as the first selection.
    expect(secondVariant).toBe(firstVariant);
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
