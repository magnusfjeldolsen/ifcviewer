// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { AppearanceManager } from '../src/viewer/AppearanceManager';
import type { AppearanceManagerDeps } from '../src/viewer/AppearanceManager';
import type { ModelManager, ModelEntry } from '../src/viewer/ModelManager';
import type { ElementIdentity, Scope } from '../src/inspector/types';

/**
 * AppearanceManager engine tests (D, the appearance system).
 *
 * The state model is pure-ish; visibility / material effects assert against
 * real THREE meshes built into stub ModelEntry fixtures. We never spin up a
 * real Viewer or web-ifc — just the per-model `meshesByExpressId` index the
 * manager iterates (same O(1) lookup SelectionManager uses).
 *
 * CRITICAL invariant under test (the doc's flagged risk): AppearanceManager
 * treats the *pristine original material reference* on the mesh as its base.
 * Transparency swaps to a clone {transparent:true, opacity:0.25}; opaque
 * restores the EXACT original reference. Normalize-then-apply guarantees clean
 * transitions in every direction with no leaked variant.
 */

// ── Fixtures ────────────────────────────────────────────────

function makeMeshUnderGroup(
  group: THREE.Group,
  expressId: number,
  material?: THREE.Material,
): THREE.Mesh {
  const geom = new THREE.BufferGeometry();
  const mat = material ?? new THREE.MeshPhongMaterial({ color: 0x808080 });
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

/**
 * A model whose meshes deliberately share a material reference, to prove the
 * per-mesh transparency variant trick doesn't cross-contaminate same-colored
 * elements elsewhere. `groups` lists which expressIDs share one material.
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

function identity(modelId: string, expressId: number): ElementIdentity {
  return { modelId, expressId, ifcClass: '', ifcTypeCode: 0 };
}

function makeDeps(): {
  deps: AppearanceManagerDeps;
  modelStore: Map<string, ModelEntry>;
  renderCalls: { count: number };
} {
  const modelStore = new Map<string, ModelEntry>();
  const renderCalls = { count: 0 };
  const modelManager = {
    getModel: (id: string) => modelStore.get(id),
    getAllModels: () => Array.from(modelStore.values()),
  } as unknown as ModelManager;
  return {
    deps: { modelManager, requestRender: () => { renderCalls.count++; } },
    modelStore,
    renderCalls,
  };
}

/** Convenience: the single mesh for (modelId, expressId). */
function meshFor(store: Map<string, ModelEntry>, modelId: string, expressId: number): THREE.Mesh {
  return store.get(modelId)!.meshesByExpressId.get(expressId)![0];
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
    env.modelStore.set('A', makeModelEntry('A', [1, 2, 3]));
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

  it('T2: hide sets mesh.visible=false for scope meshes; showAll restores visible=true and empties the hidden set', () => {
    const m1 = meshFor(env.modelStore, 'A', 1);
    const m2 = meshFor(env.modelStore, 'A', 2);

    manager.hide(scope(['A', 1]));
    expect(m1.visible).toBe(false);
    expect(m2.visible).toBe(true);
    expect(manager.hasHidden()).toBe(true);

    manager.showAll();
    expect(m1.visible).toBe(true);
    expect(manager.getStateFor('A', 1)).toBe('normal');
    expect(manager.hasHidden()).toBe(false);
  });
});

describe('AppearanceManager — isolate (T3)', () => {
  it('T3: isolate(scope) hides the COMPLEMENT only; scope stays normal/visible', () => {
    const env = makeDeps();
    env.modelStore.set('A', makeModelEntry('A', [1, 2, 3, 4]));
    env.modelStore.set('B', makeModelEntry('B', [10, 20]));
    const manager = new AppearanceManager(env.deps);

    manager.isolate(scope(['A', 2], ['B', 10]));

    // Scope elements stay normal + visible.
    expect(manager.getStateFor('A', 2)).toBe('normal');
    expect(manager.getStateFor('B', 10)).toBe('normal');
    expect(meshFor(env.modelStore, 'A', 2).visible).toBe(true);
    expect(meshFor(env.modelStore, 'B', 10).visible).toBe(true);

    // Everything NOT in scope is hidden.
    expect(manager.getStateFor('A', 1)).toBe('hidden');
    expect(manager.getStateFor('A', 3)).toBe('hidden');
    expect(manager.getStateFor('A', 4)).toBe('hidden');
    expect(manager.getStateFor('B', 20)).toBe('hidden');
    expect(meshFor(env.modelStore, 'A', 1).visible).toBe(false);
    expect(meshFor(env.modelStore, 'B', 20).visible).toBe(false);
  });
});

describe('AppearanceManager — transparent / opaque (T4, T5)', () => {
  it('T4: transparent swaps to a transparent clone {transparent:true, opacity:0.25}, preserves original ref; opaque restores exact original ref', () => {
    const env = makeDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new AppearanceManager(env.deps);
    const mesh = meshFor(env.modelStore, 'A', 1);
    const original = mesh.material;

    manager.transparent(scope(['A', 1]));
    expect(manager.getStateFor('A', 1)).toBe('transparent');
    const variant = mesh.material as THREE.MeshPhongMaterial;
    expect(variant).not.toBe(original);
    expect(variant.transparent).toBe(true);
    expect(variant.opacity).toBeCloseTo(0.25);

    manager.opaque(scope(['A', 1]));
    expect(manager.getStateFor('A', 1)).toBe('normal');
    expect(mesh.material).toBe(original); // exact original reference restored
  });

  it('T5: shared-color meshes do not cross-contaminate (per-mesh variant, mirroring highlightVariants)', () => {
    const env = makeDeps();
    // expressIDs 1,2,3 all share one material; 4,5 share another.
    env.modelStore.set('A', makeSharedMaterialEntry('A', [[1, 2, 3], [4, 5]]));
    const manager = new AppearanceManager(env.deps);

    const m1 = meshFor(env.modelStore, 'A', 1);
    const m2 = meshFor(env.modelStore, 'A', 2); // shares material with m1
    const m4 = meshFor(env.modelStore, 'A', 4); // different material
    const sharedOriginal = m2.material;
    const otherOriginal = m4.material;

    manager.transparent(scope(['A', 1]));

    // Only mesh 1 became transparent; its same-material siblings are untouched.
    expect((m1.material as THREE.MeshPhongMaterial).opacity).toBeCloseTo(0.25);
    expect(m2.material).toBe(sharedOriginal);
    expect((m2.material as THREE.MeshPhongMaterial).opacity).toBe(1);
    expect(m4.material).toBe(otherOriginal);
  });
});

describe('AppearanceManager — onChange (T6)', () => {
  let env: ReturnType<typeof makeDeps>;
  let manager: AppearanceManager;

  beforeEach(() => {
    env = makeDeps();
    env.modelStore.set('A', makeModelEntry('A', [1, 2]));
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
    env.modelStore.set('A', makeModelEntry('A', [1, 2, 3]));
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

    // Fresh manager + fresh model meshes; deserialize must re-apply effects.
    const env2 = makeDeps();
    env2.modelStore.set('A', makeModelEntry('A', [1, 2, 3]));
    const manager2 = new AppearanceManager(env2.deps);
    manager2.deserialize(serialized);

    expect(manager2.getStateFor('A', 1)).toBe('hidden');
    expect(manager2.getStateFor('A', 2)).toBe('transparent');
    expect(meshFor(env2.modelStore, 'A', 1).visible).toBe(false);
    expect((meshFor(env2.modelStore, 'A', 2).material as THREE.MeshPhongMaterial).opacity).toBeCloseTo(0.25);
  });
});

describe('AppearanceManager — onModelRemoved (T8)', () => {
  it('T8: prunes only that model entries (delimiter-aware so "m1" != "m1-2"); fires onChange iff something was pruned', () => {
    const env = makeDeps();
    env.modelStore.set('m1', makeModelEntry('m1', [1]));
    env.modelStore.set('m1-2', makeModelEntry('m1-2', [1]));
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
    env2.modelStore.set('A', makeModelEntry('A', [1]));
    const manager2 = new AppearanceManager(env2.deps);
    manager2.hide(scope(['A', 1]));
    const listener2 = vi.fn();
    manager2.onChange(listener2);
    manager2.onModelRemoved('B');
    expect(listener2).not.toHaveBeenCalled();
  });
});

describe('AppearanceManager — mutually-exclusive transitions (T9, T10)', () => {
  it('T9 (A4): hide an already-transparent element → hidden, clone removed (original ref) + visible=false; showAll → normal (NOT back to transparent)', () => {
    const env = makeDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new AppearanceManager(env.deps);
    const mesh = meshFor(env.modelStore, 'A', 1);
    const original = mesh.material;

    manager.transparent(scope(['A', 1]));
    expect(mesh.material).not.toBe(original);

    // Hide overrides transparent: drop the clone, restore original ref, hide.
    manager.hide(scope(['A', 1]));
    expect(manager.getStateFor('A', 1)).toBe('hidden');
    expect(mesh.material).toBe(original); // clone removed
    expect(mesh.visible).toBe(false);

    // showAll returns to normal, NOT to transparent (mutually exclusive).
    manager.showAll();
    expect(manager.getStateFor('A', 1)).toBe('normal');
    expect(mesh.visible).toBe(true);
    expect(mesh.material).toBe(original);
  });

  it('T10: transition matrix leaves the correct base and no leaked variant', () => {
    const env = makeDeps();
    env.modelStore.set('A', makeModelEntry('A', [1]));
    const manager = new AppearanceManager(env.deps);
    const mesh = meshFor(env.modelStore, 'A', 1);
    const original = mesh.material;

    // transparent → opaque → normal
    manager.transparent(scope(['A', 1]));
    manager.opaque(scope(['A', 1]));
    expect(manager.getStateFor('A', 1)).toBe('normal');
    expect(mesh.material).toBe(original);
    expect(mesh.visible).toBe(true);

    // normal → transparent → hidden → showAll
    manager.transparent(scope(['A', 1]));
    expect((mesh.material as THREE.MeshPhongMaterial).opacity).toBeCloseTo(0.25);
    manager.hide(scope(['A', 1]));
    expect(mesh.visible).toBe(false);
    expect(mesh.material).toBe(original); // hide normalized away the transparent clone
    manager.showAll();
    expect(manager.getStateFor('A', 1)).toBe('normal');
    expect(mesh.visible).toBe(true);
    expect(mesh.material).toBe(original);
    expect((mesh.material as THREE.MeshPhongMaterial).opacity).toBe(1);
  });
});

describe('AppearanceManager — predicates (T11)', () => {
  it('T11: hasHidden()/hasTransparent() flip true on the matching state and false after showAll/opaque', () => {
    const env = makeDeps();
    env.modelStore.set('A', makeModelEntry('A', [1, 2]));
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
