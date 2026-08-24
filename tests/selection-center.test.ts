// @vitest-environment jsdom
/**
 * `SelectionManager.getSelectionCenter()` — the fallback orbit pivot for a
 * gesture started over empty space. Revit and Navisworks both offer "centre
 * pivot on selection"; with something selected, that is nearly always what the
 * user means to turn around.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SelectionManager } from '../src/inspector/SelectionManager';
import type { SelectionManagerDeps } from '../src/inspector/SelectionManager';
import type { Tool, ToolManager } from '../src/tools/Tool';
import type { Viewer } from '../src/viewer/Viewer';
import type { ModelManager, ModelEntry } from '../src/viewer/ModelManager';
import type { ElementIdentity } from '../src/inspector/types';

const lsStore = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => { lsStore.set(k, v); },
    removeItem: (k: string) => { lsStore.delete(k); },
    clear: () => lsStore.clear(),
    get length() { return lsStore.size; },
    key: (i: number) => [...lsStore.keys()][i] ?? null,
  },
  writable: true,
  configurable: true,
});

const identity = (modelId: string, expressId: number): ElementIdentity => ({
  modelId,
  expressId,
  ifcClass: '',
  ifcTypeCode: 0,
});

/** A unit cube centred on `at`, so the expected centre is obvious by eye. */
function makeModelEntry(modelId: string, cubes: Array<[number, THREE.Vector3]>): ModelEntry {
  const group = new THREE.Group();
  group.name = modelId;
  const meshesByExpressId = new Map<number, THREE.Mesh[]>();

  for (const [expressId, at] of cubes) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshPhongMaterial({ color: 0x808080 }),
    );
    mesh.userData.expressID = expressId;
    mesh.position.copy(at);
    group.add(mesh);
    meshesByExpressId.set(expressId, [mesh]);
  }

  group.updateMatrixWorld(true);
  return { id: modelId, group, visible: true, meshesByExpressId };
}

function makeDeps(store: Map<string, ModelEntry>): SelectionManagerDeps {
  const canvas = document.createElement('canvas');
  const viewer = {
    getCanvas: () => canvas,
    getScene: () => new THREE.Scene(),
    getCamera: () => new THREE.PerspectiveCamera(),
    getRenderer: () => ({ clippingPlanes: [] }) as unknown as THREE.WebGLRenderer,
    isPivotPicking: () => false,
    requestRender: () => { /* no-op */ },
  } as unknown as Viewer;

  return {
    viewer,
    canvas,
    modelManager: { getModel: (id: string) => store.get(id) } as unknown as ModelManager,
    toolManager: { getActiveTool: () => null as Tool | null } as unknown as ToolManager,
  };
}

describe('SelectionManager.getSelectionCenter', () => {
  let store: Map<string, ModelEntry>;
  let manager: SelectionManager;

  beforeEach(() => {
    lsStore.clear();
    store = new Map();
    store.set('A', makeModelEntry('A', [
      [1, new THREE.Vector3(0, 0, 0)],
      [2, new THREE.Vector3(10, 0, 0)],
      [3, new THREE.Vector3(0, 6, 0)],
    ]));
    manager = new SelectionManager(makeDeps(store));
  });

  it('returns null when nothing is selected', () => {
    expect(manager.getSelectionCenter()).toBeNull();
  });

  it('returns the centre of a single selected element', () => {
    manager.apply('replace', identity('A', 2));
    const center = manager.getSelectionCenter()!;
    expect(center.x).toBeCloseTo(10, 6);
    expect(center.y).toBeCloseTo(0, 6);
    expect(center.z).toBeCloseTo(0, 6);
  });

  it('returns the centre of the whole selection, not of one member', () => {
    manager.apply('replace', identity('A', 1));
    manager.apply('add', identity('A', 2));
    const center = manager.getSelectionCenter()!;
    expect(center.x).toBeCloseTo(5, 6);
  });

  it('tracks the selection shrinking again', () => {
    // The cache must not outlive the selection that produced it, or orbit
    // starts turning about where the selection used to be.
    manager.apply('replace', identity('A', 1));
    manager.apply('add', identity('A', 2));
    expect(manager.getSelectionCenter()!.x).toBeCloseTo(5, 6);

    manager.apply('remove', identity('A', 2));
    expect(manager.getSelectionCenter()!.x).toBeCloseTo(0, 6);
  });

  it('returns null again after clear', () => {
    manager.apply('replace', identity('A', 1));
    expect(manager.getSelectionCenter()).not.toBeNull();
    manager.clear();
    expect(manager.getSelectionCenter()).toBeNull();
  });

  it('spans all three axes', () => {
    manager.apply('replace', identity('A', 1));
    manager.apply('add', identity('A', 3));
    const center = manager.getSelectionCenter()!;
    expect(center.x).toBeCloseTo(0, 6);
    expect(center.y).toBeCloseTo(3, 6);
  });

  it('hands back a copy the caller cannot use to corrupt the cache', () => {
    manager.apply('replace', identity('A', 1));
    manager.getSelectionCenter()!.set(99, 99, 99);
    expect(manager.getSelectionCenter()!.x).toBeCloseTo(0, 6);
  });

  it('returns null when the selected element belongs to no loaded model', () => {
    // Nothing highlighted means no bounds to union — the viewer then falls
    // through to the fit centre rather than orbiting about the origin.
    manager.apply('replace', identity('missing', 1));
    expect(manager.getSelectionCenter()).toBeNull();
  });
});
