// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { MarqueeSelector } from '../src/inspector/MarqueeSelector';
import type { Viewer } from '../src/viewer/Viewer';
import type { ModelManager, ModelEntry } from '../src/viewer/ModelManager';
import type { ToolManager, Tool } from '../src/tools/Tool';
import type { SelectionManager } from '../src/inspector/SelectionManager';
import type { SelectionMode } from '../src/inspector/types';
import type { ElementIdentity } from '../src/inspector/types';

/**
 * Integration tests for MarqueeSelector — drives a real DOM via jsdom,
 * stubs out the dependencies that need a WebGL context.
 *
 * The classification maths is covered by `marquee-frustum.test.ts`; here
 * we verify the gesture state machine (pending/dragging/idle), DOM
 * marquee element lifecycle, modifier handling, and tool/pivot bail.
 */

// ─── localStorage mock (SelectionManager pollutes this if loaded) ───
const lsStore = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => {
      lsStore.set(k, v);
    },
    removeItem: (k: string) => lsStore.delete(k),
    clear: () => lsStore.clear(),
    get length() {
      return lsStore.size;
    },
    key: (i: number) => [...lsStore.keys()][i] ?? null,
  },
  writable: true,
  configurable: true,
});

// ─── Fixtures ──────────────────────────────────────────────

function makeMeshAt(x: number, y: number, z: number, expressId: number, size = 0.1): THREE.Mesh {
  const geom = new THREE.BoxGeometry(size, size, size);
  geom.computeBoundingBox();
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(x, y, z);
  mesh.userData.expressID = expressId;
  mesh.updateMatrixWorld(true);
  return mesh;
}

function makeModelEntry(
  modelId: string,
  meshes: THREE.Mesh[],
  visible = true,
): ModelEntry {
  const group = new THREE.Group();
  group.name = modelId;
  for (const m of meshes) group.add(m);
  return { id: modelId, group, visible };
}

interface Env {
  canvas: HTMLCanvasElement;
  marqueeRoot: HTMLElement;
  viewer: Viewer;
  modelManager: ModelManager;
  toolManager: ToolManager;
  selectionManager: SelectionManager;
  modelStore: Map<string, ModelEntry>;
  toolState: { active: Tool | null };
  pivotState: { picking: boolean };
  controlsState: { enabled: boolean };
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: { clippingPlanes: THREE.Plane[] };
  applyManyCalls: Array<{ mode: SelectionMode; ids: ElementIdentity[] }>;
}

function makeEnv(): Env {
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 200;
  // jsdom returns (0,0,0,0) from getBoundingClientRect by default — override.
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(canvas);

  const marqueeRoot = document.createElement('div');
  document.body.appendChild(marqueeRoot);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const renderer = { clippingPlanes: [] as THREE.Plane[] };

  const toolState = { active: null as Tool | null };
  const pivotState = { picking: false };
  const controlsState = { enabled: true };

  const viewer = {
    getCanvas: () => canvas,
    getScene: () => scene,
    getCamera: () => camera,
    getRenderer: () => renderer as unknown as THREE.WebGLRenderer,
    isPivotPicking: () => pivotState.picking,
    setControlsEnabled: (enabled: boolean) => {
      controlsState.enabled = enabled;
    },
  } as unknown as Viewer;

  const modelStore = new Map<string, ModelEntry>();
  const modelManager = {
    getAllModels: () => Array.from(modelStore.values()),
    getModel: (id: string) => modelStore.get(id),
  } as unknown as ModelManager;

  const toolManager = {
    getActiveTool: () => toolState.active,
  } as unknown as ToolManager;

  const applyManyCalls: Array<{ mode: SelectionMode; ids: ElementIdentity[] }> = [];
  const selectionManager = {
    applyMany: (mode: SelectionMode, ids: readonly ElementIdentity[]) => {
      applyManyCalls.push({ mode, ids: [...ids] });
      return { kind: 'none' };
    },
  } as unknown as SelectionManager;

  return {
    canvas,
    marqueeRoot,
    viewer,
    modelManager,
    toolManager,
    selectionManager,
    modelStore,
    toolState,
    pivotState,
    controlsState,
    scene,
    camera,
    renderer,
    applyManyCalls,
  };
}

function pointerDown(canvas: HTMLCanvasElement, x: number, y: number, opts: PointerEventInit = {}): PointerEvent {
  const e = new PointerEvent('pointerdown', {
    button: 0,
    pointerId: 1,
    clientX: x,
    clientY: y,
    ...opts,
  });
  canvas.dispatchEvent(e);
  return e;
}
function pointerMove(canvas: HTMLCanvasElement, x: number, y: number): void {
  canvas.dispatchEvent(
    new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: y }),
  );
}
function pointerUp(canvas: HTMLCanvasElement, x: number, y: number): void {
  canvas.dispatchEvent(
    new PointerEvent('pointerup', { button: 0, pointerId: 1, clientX: x, clientY: y }),
  );
}

// ─── Tests ──────────────────────────────────────────────────

describe('MarqueeSelector — pointer gating', () => {
  let env: Env;
  let selector: MarqueeSelector;

  beforeEach(() => {
    env = makeEnv();
    selector = new MarqueeSelector({
      viewer: env.viewer,
      modelManager: env.modelManager,
      toolManager: env.toolManager,
      selectionManager: env.selectionManager,
      canvas: env.canvas,
      marqueeRoot: env.marqueeRoot,
    });
  });

  afterEach(() => {
    selector.dispose();
    document.body.innerHTML = '';
  });

  it('non-Alt pointerdown does not start a drag', () => {
    pointerDown(env.canvas, 50, 50, { altKey: false });
    pointerMove(env.canvas, 100, 100);
    pointerUp(env.canvas, 100, 100);
    expect(env.marqueeRoot.querySelector('.marquee-window, .marquee-crossing')).toBeNull();
    expect(env.applyManyCalls).toEqual([]);
  });

  it('right-button pointerdown does not start a drag', () => {
    env.canvas.dispatchEvent(
      new PointerEvent('pointerdown', { button: 2, pointerId: 1, clientX: 50, clientY: 50, altKey: true }),
    );
    pointerMove(env.canvas, 100, 100);
    pointerUp(env.canvas, 100, 100);
    expect(env.marqueeRoot.querySelector('.marquee-window, .marquee-crossing')).toBeNull();
  });

  it('sub-3px movement does not create the marquee div', () => {
    pointerDown(env.canvas, 50, 50, { altKey: true });
    pointerMove(env.canvas, 51, 51); // < 3px
    pointerUp(env.canvas, 51, 51);
    expect(env.marqueeRoot.querySelector('.marquee-window, .marquee-crossing')).toBeNull();
    expect(env.applyManyCalls).toEqual([]);
  });

  it('bails silently when a tool is active', () => {
    env.toolState.active = { name: 'measurement' } as Tool;
    pointerDown(env.canvas, 50, 50, { altKey: true });
    pointerMove(env.canvas, 100, 100);
    pointerUp(env.canvas, 100, 100);
    expect(env.marqueeRoot.querySelector('.marquee-window, .marquee-crossing')).toBeNull();
    expect(env.applyManyCalls).toEqual([]);
  });

  it('bails silently when pivot picking is on', () => {
    env.pivotState.picking = true;
    pointerDown(env.canvas, 50, 50, { altKey: true });
    pointerMove(env.canvas, 100, 100);
    pointerUp(env.canvas, 100, 100);
    expect(env.marqueeRoot.querySelector('.marquee-window, .marquee-crossing')).toBeNull();
    expect(env.applyManyCalls).toEqual([]);
  });

  it('disables OrbitControls on Alt-pointerdown and restores on pointerup', () => {
    expect(env.controlsState.enabled).toBe(true);
    pointerDown(env.canvas, 50, 50, { altKey: true });
    expect(env.controlsState.enabled).toBe(false);
    pointerMove(env.canvas, 100, 100);
    pointerUp(env.canvas, 100, 100);
    expect(env.controlsState.enabled).toBe(true);
  });
});

describe('MarqueeSelector — marquee div lifecycle', () => {
  let env: Env;
  let selector: MarqueeSelector;

  beforeEach(() => {
    env = makeEnv();
    selector = new MarqueeSelector({
      viewer: env.viewer,
      modelManager: env.modelManager,
      toolManager: env.toolManager,
      selectionManager: env.selectionManager,
      canvas: env.canvas,
      marqueeRoot: env.marqueeRoot,
    });
  });

  afterEach(() => {
    selector.dispose();
    document.body.innerHTML = '';
  });

  it('left-to-right drag uses .marquee-window class (blue solid)', () => {
    pointerDown(env.canvas, 50, 50, { altKey: true });
    pointerMove(env.canvas, 150, 150); // right & down → window mode
    expect(env.marqueeRoot.querySelector('.marquee-window')).not.toBeNull();
    expect(env.marqueeRoot.querySelector('.marquee-crossing')).toBeNull();
    pointerUp(env.canvas, 150, 150);
  });

  it('right-to-left drag uses .marquee-crossing class (green dashed)', () => {
    pointerDown(env.canvas, 150, 50, { altKey: true });
    pointerMove(env.canvas, 50, 150); // left & down → crossing
    expect(env.marqueeRoot.querySelector('.marquee-crossing')).not.toBeNull();
    expect(env.marqueeRoot.querySelector('.marquee-window')).toBeNull();
    pointerUp(env.canvas, 50, 150);
  });

  it('crossing the startX live-flips the marquee class', () => {
    pointerDown(env.canvas, 100, 100, { altKey: true });
    pointerMove(env.canvas, 150, 100); // right → window
    expect(env.marqueeRoot.querySelector('.marquee-window')).not.toBeNull();

    pointerMove(env.canvas, 50, 100); // now left → crossing
    expect(env.marqueeRoot.querySelector('.marquee-crossing')).not.toBeNull();
    expect(env.marqueeRoot.querySelector('.marquee-window')).toBeNull();

    pointerMove(env.canvas, 150, 100); // back to right → window again
    expect(env.marqueeRoot.querySelector('.marquee-window')).not.toBeNull();
    pointerUp(env.canvas, 150, 100);
  });

  it('removes the marquee div on pointerup', () => {
    pointerDown(env.canvas, 50, 50, { altKey: true });
    pointerMove(env.canvas, 150, 150);
    expect(env.marqueeRoot.children.length).toBe(1);
    pointerUp(env.canvas, 150, 150);
    expect(env.marqueeRoot.children.length).toBe(0);
  });

  it('marquee div geometry uses min(start,end) for left/top and abs(end-start) for size', () => {
    pointerDown(env.canvas, 80, 40, { altKey: true });
    pointerMove(env.canvas, 60, 100); // dragging up-left, but ending lower
    const el = env.marqueeRoot.querySelector<HTMLDivElement>('.marquee-crossing');
    expect(el).not.toBeNull();
    expect(el!.style.left).toBe('60px');
    expect(el!.style.top).toBe('40px');
    expect(el!.style.width).toBe('20px');
    expect(el!.style.height).toBe('60px');
    pointerUp(env.canvas, 60, 100);
  });
});

describe('MarqueeSelector — Esc handling', () => {
  let env: Env;
  let selector: MarqueeSelector;

  beforeEach(() => {
    env = makeEnv();
    selector = new MarqueeSelector({
      viewer: env.viewer,
      modelManager: env.modelManager,
      toolManager: env.toolManager,
      selectionManager: env.selectionManager,
      canvas: env.canvas,
      marqueeRoot: env.marqueeRoot,
    });
  });

  afterEach(() => {
    selector.dispose();
    document.body.innerHTML = '';
  });

  it('Esc during drag dismisses without committing', () => {
    pointerDown(env.canvas, 50, 50, { altKey: true });
    pointerMove(env.canvas, 150, 150);
    expect(env.marqueeRoot.children.length).toBe(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(env.marqueeRoot.children.length).toBe(0);
    expect(env.applyManyCalls).toEqual([]);
    expect(env.controlsState.enabled).toBe(true);
  });

  it('Esc on idle is a no-op', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(env.applyManyCalls).toEqual([]);
  });

  it('Esc stops propagation so the global shortcut does not also fire', () => {
    pointerDown(env.canvas, 50, 50, { altKey: true });
    pointerMove(env.canvas, 150, 150);

    const globalHandler = vi.fn();
    window.addEventListener('keydown', globalHandler); // bubble-phase, after capture
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(globalHandler).not.toHaveBeenCalled();
    window.removeEventListener('keydown', globalHandler);
  });
});

describe('MarqueeSelector — selection commit', () => {
  let env: Env;
  let selector: MarqueeSelector;

  beforeEach(() => {
    env = makeEnv();
    // Two meshes near origin (will be inside the marquee) and one off-screen.
    env.modelStore.set(
      'A',
      makeModelEntry('A', [
        makeMeshAt(0, 0, 0, 1),
        makeMeshAt(0.2, 0, 0, 2),
        makeMeshAt(50, 50, 0, 3), // outside frustum
      ]),
    );

    selector = new MarqueeSelector({
      viewer: env.viewer,
      modelManager: env.modelManager,
      toolManager: env.toolManager,
      selectionManager: env.selectionManager,
      canvas: env.canvas,
      marqueeRoot: env.marqueeRoot,
    });
  });

  afterEach(() => {
    selector.dispose();
    document.body.innerHTML = '';
  });

  it('Alt-drag commits via applyMany with replace mode', () => {
    // Big left-to-right drag covering the centre of the canvas.
    pointerDown(env.canvas, 10, 10, { altKey: true });
    pointerMove(env.canvas, 190, 190);
    pointerUp(env.canvas, 190, 190);

    expect(env.applyManyCalls.length).toBe(1);
    expect(env.applyManyCalls[0].mode).toBe('replace');
    const ids = env.applyManyCalls[0].ids;
    // expressIds 1 and 2 are at/near origin → selected. 3 is off-screen.
    const expressIds = ids.map((i) => i.expressId).sort();
    expect(expressIds).toEqual([1, 2]);
  });

  it('Alt+Ctrl-drag commits with add mode', () => {
    pointerDown(env.canvas, 10, 10, { altKey: true, ctrlKey: true });
    pointerMove(env.canvas, 190, 190);
    pointerUp(env.canvas, 190, 190);
    expect(env.applyManyCalls[0].mode).toBe('add');
  });

  it('Alt+Meta-drag commits with add mode (Mac cmd)', () => {
    pointerDown(env.canvas, 10, 10, { altKey: true, metaKey: true });
    pointerMove(env.canvas, 190, 190);
    pointerUp(env.canvas, 190, 190);
    expect(env.applyManyCalls[0].mode).toBe('add');
  });

  it('Alt+Shift-drag commits with remove mode', () => {
    pointerDown(env.canvas, 10, 10, { altKey: true, shiftKey: true });
    pointerMove(env.canvas, 190, 190);
    pointerUp(env.canvas, 190, 190);
    expect(env.applyManyCalls[0].mode).toBe('remove');
  });

  it('Modifier state is locked at pointerdown — releasing Alt mid-drag still commits', () => {
    pointerDown(env.canvas, 10, 10, { altKey: true });
    // Release Alt during drag (pointermove without altKey).
    env.canvas.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 190, clientY: 190, altKey: false }),
    );
    pointerUp(env.canvas, 190, 190);
    expect(env.applyManyCalls.length).toBe(1);
  });

  it('right-to-left drag uses crossing mode (any intersecting AABB)', () => {
    pointerDown(env.canvas, 190, 10, { altKey: true });
    pointerMove(env.canvas, 10, 190);
    pointerUp(env.canvas, 10, 190);
    expect(env.applyManyCalls.length).toBe(1);
    // Should still pick up expressId 1 and 2 (both fully inside).
    const ids = env.applyManyCalls[0].ids;
    const expressIds = ids.map((i) => i.expressId).sort();
    expect(expressIds).toEqual([1, 2]);
  });

  it('hidden model is excluded from results', () => {
    env.modelStore.get('A')!.visible = false;
    pointerDown(env.canvas, 10, 10, { altKey: true });
    pointerMove(env.canvas, 190, 190);
    pointerUp(env.canvas, 190, 190);
    expect(env.applyManyCalls[0].ids).toEqual([]);
  });

  it('mesh with mesh.visible=false is excluded', () => {
    env.modelStore.get('A')!.group.children[0].visible = false;
    pointerDown(env.canvas, 10, 10, { altKey: true });
    pointerMove(env.canvas, 190, 190);
    pointerUp(env.canvas, 190, 190);
    // Only expressId 2 remains visible at origin.
    const ids = env.applyManyCalls[0].ids;
    expect(ids.map((i) => i.expressId)).toEqual([2]);
  });

  it('mesh without expressID is excluded', () => {
    // Add a helper mesh with no userData.expressID.
    const helper = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial());
    helper.position.set(0.4, 0, 0);
    helper.updateMatrixWorld(true);
    env.modelStore.get('A')!.group.add(helper);

    pointerDown(env.canvas, 10, 10, { altKey: true });
    pointerMove(env.canvas, 190, 190);
    pointerUp(env.canvas, 190, 190);
    const ids = env.applyManyCalls[0].ids;
    // expressIds 1 and 2 — helper not included despite being in frustum.
    expect(ids.map((i) => i.expressId).sort()).toEqual([1, 2]);
  });

  it('respects active clipping plane (fully-clipped element excluded)', () => {
    // Clip everything in front of z=5 — meshes at origin are cut-side.
    env.renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, 1), -5)];
    pointerDown(env.canvas, 10, 10, { altKey: true });
    pointerMove(env.canvas, 190, 190);
    pointerUp(env.canvas, 190, 190);
    expect(env.applyManyCalls[0].ids).toEqual([]);
  });

  it('empty marquee (nothing inside) commits applyMany with [] in replace mode', () => {
    // Drag entirely outside the model area — small upper-corner box.
    // The meshes at origin map to roughly the centre of the canvas (100,100).
    // A 5×5px drag at (5,5)→(10,10) covers only the far-upper-left corner.
    pointerDown(env.canvas, 5, 5, { altKey: true });
    pointerMove(env.canvas, 10, 10);
    pointerUp(env.canvas, 10, 10);
    expect(env.applyManyCalls.length).toBe(1);
    expect(env.applyManyCalls[0].mode).toBe('replace');
    expect(env.applyManyCalls[0].ids).toEqual([]);
  });
});

describe('MarqueeSelector — disposal', () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('dispose removes all listeners and the marquee element', () => {
    const selector = new MarqueeSelector({
      viewer: env.viewer,
      modelManager: env.modelManager,
      toolManager: env.toolManager,
      selectionManager: env.selectionManager,
      canvas: env.canvas,
      marqueeRoot: env.marqueeRoot,
    });

    pointerDown(env.canvas, 50, 50, { altKey: true });
    pointerMove(env.canvas, 150, 150);
    expect(env.marqueeRoot.children.length).toBe(1);

    selector.dispose();

    // Marquee removed, controls restored.
    expect(env.marqueeRoot.children.length).toBe(0);
    expect(env.controlsState.enabled).toBe(true);

    // Further events do not commit anything.
    pointerDown(env.canvas, 50, 50, { altKey: true });
    pointerMove(env.canvas, 150, 150);
    pointerUp(env.canvas, 150, 150);
    expect(env.applyManyCalls).toEqual([]);
  });
});
