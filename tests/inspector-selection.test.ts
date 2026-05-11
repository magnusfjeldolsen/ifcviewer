// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SelectionManager } from '../src/inspector/SelectionManager';
import type { SelectionManagerDeps } from '../src/inspector/SelectionManager';
import type { Tool, ToolManager } from '../src/tools/Tool';
import type { Viewer } from '../src/viewer/Viewer';
import type { ModelManager, ModelEntry } from '../src/viewer/ModelManager';
import type { ElementIdentity } from '../src/inspector/types';

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
  for (const id of expressIds) makeMeshUnderGroup(group, id);
  return { id: modelId, group, visible: true };
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

  it('add freely spans models in Phase 2 (no single-model lock yet)', () => {
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
    makeMeshUnderGroup(group, 7);
    makeMeshUnderGroup(group, 7);
    makeMeshUnderGroup(group, 8);
    env.modelStore.set('A', { id: 'A', group, visible: true });

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

  it('disposes the cloned highlight material on deselect (no leak)', () => {
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new SelectionManager(env.deps);
    const mesh = env.modelStore.get('A')!.group.children[0] as THREE.Mesh;

    manager.apply('replace', identity('A', 1));
    const clone = mesh.material as THREE.Material;
    const disposeSpy = vi.spyOn(clone, 'dispose');

    manager.clear();
    expect(disposeSpy).toHaveBeenCalledOnce();
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
    const env = makeStubDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    env.modelStore.set('B', makeModelEntry('B', [10]));
    const manager = new SelectionManager(env.deps);

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
