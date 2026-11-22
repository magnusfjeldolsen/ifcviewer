// @vitest-environment jsdom
/**
 * Flying as the third camera owner (#98): every way in and out, keys, and the
 * no-jump hand-back to orbit.
 *
 * `Viewer` builds a WebGLRenderer, which jsdom cannot run, so the renderer is
 * swapped for a stand-in that draws nothing. Everything else — OrbitControls,
 * the camera, the CameraAnimator — is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeRenderer {
    domElement: HTMLCanvasElement;
    clippingPlanes: THREE.Plane[] = [];
    constructor(params?: { canvas?: HTMLCanvasElement }) {
      this.domElement = params?.canvas ?? document.createElement('canvas');
    }
    setSize(): void {}
    setPixelRatio(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer };
});

const { Viewer } = await import('../src/viewer/Viewer');
type ViewerT = InstanceType<typeof Viewer>;

/** The internals these tests need to look at. */
interface Internals {
  controls: OrbitControls;
  animate: () => void;
}

const internals = (viewer: ViewerT): Internals => viewer as unknown as Internals;

let canvas: HTMLCanvasElement;
let viewer: ViewerT;
let now = 0;

/** One render-loop frame, `ms` after the last. */
function frame(ms = 1000 / 60): void {
  now += ms;
  internals(viewer).animate();
}

function frames(n: number): void {
  for (let i = 0; i < n; i++) frame();
}

function key(type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
  const e = new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function pose(): { p: THREE.Vector3; q: THREE.Quaternion } {
  const cam = viewer.getCamera();
  return { p: cam.position.clone(), q: cam.quaternion.clone() };
}

/** The view anchor sits on the camera's forward axis (so lookAt is a no-op). */
function anchorOnForwardAxis(): number {
  const cam = viewer.getCamera();
  const forward = cam.getWorldDirection(new THREE.Vector3());
  const toTarget = internals(viewer).controls.target.clone().sub(cam.position).normalize();
  return forward.angleTo(toTarget);
}

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  // Frames are driven by hand; the loop must not schedule itself.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  canvas = document.createElement('canvas');
  // jsdom has no pointer capture; OrbitControls asks for it on pointerdown.
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  canvas.hasPointerCapture = () => false;
  document.body.appendChild(canvas);
  viewer = new Viewer(canvas);
  viewer.fitToBox(new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 10, 10)));
  frame();
});

afterEach(() => {
  viewer.dispose();
  canvas.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('flying — ownership', () => {
  it('is a third owner, and leaving hands back to the user', () => {
    expect(viewer.getControlsMode()).toBe('user');
    viewer.enterFlying();
    expect(viewer.getControlsMode()).toBe('flying');
    expect(viewer.isFlying()).toBe(true);
    viewer.exitFlying();
    expect(viewer.getControlsMode()).toBe('user');
  });

  it('does not poll OrbitControls while flying', () => {
    const update = vi.spyOn(internals(viewer).controls, 'update');
    viewer.enterFlying();
    frames(5);
    expect(update).not.toHaveBeenCalled();
    viewer.exitFlying();
    frame();
    expect(update).toHaveBeenCalled();
  });

  it('switches OrbitControls pan off while flying and back on after', () => {
    const controls = internals(viewer).controls;
    viewer.enterFlying();
    expect(controls.enablePan).toBe(false);
    viewer.exitFlying();
    expect(controls.enablePan).toBe(true);
  });

  const exits: Array<[string, () => void, string]> = [
    ['exitFlying', () => viewer.exitFlying(), 'user'],
    ['toggleFlying', () => viewer.toggleFlying(), 'user'],
    ['fitToBox', () => viewer.fitToBox(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1))), 'user'],
    ['flyToBox', () => void viewer.flyToBox(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1))), 'animating'],
    ['restoreCameraState', () => viewer.restoreCameraState({ position: { x: 5, y: 5, z: 5 }, target: { x: 0, y: 0, z: 0 } }), 'user'],
    ['setControlsMode', () => viewer.setControlsMode('user'), 'user'],
  ];

  for (const [name, leave, owner] of exits) {
    it(`${name} leaves flying cleanly`, () => {
      const changes: boolean[] = [];
      viewer.onFlyingChange((f) => changes.push(f));
      viewer.enterFlying();
      key('keydown', 'KeyW');
      frames(3);
      leave();
      expect(viewer.isFlying()).toBe(false);
      expect(viewer.getControlsMode()).toBe(owner);
      expect(changes).toEqual([true, false]);
      expect(internals(viewer).controls.enablePan).toBe(true);
      // The key listeners are gone: W no longer moves anything, and nobody's
      // keydown is swallowed any more.
      viewer.cancelCameraAnimation();
      const before = pose();
      const e = key('keydown', 'KeyW');
      expect(e.defaultPrevented).toBe(false);
      frames(10);
      if (owner === 'user') expect(viewer.getCamera().position.distanceTo(before.p)).toBeLessThan(1e-9);
    });
  }

  it('dispose leaves flying', () => {
    const changes: boolean[] = [];
    viewer.onFlyingChange((f) => changes.push(f));
    viewer.enterFlying();
    viewer.dispose();
    expect(changes).toEqual([true, false]);
    // afterEach disposes again; that must be harmless.
  });

  it('interrupts a running fly-to on entering, and the tween stops', async () => {
    const done = viewer.flyToBox(new THREE.Box3(new THREE.Vector3(50, 0, 50), new THREE.Vector3(60, 10, 60)));
    expect(viewer.getControlsMode()).toBe('animating');
    viewer.enterFlying();
    expect(viewer.getControlsMode()).toBe('flying');
    await done; // resolves on interrupt
    expect(viewer.getControlsMode()).toBe('flying');
  });

  it('grabbing the section handle mid-flight does not take the camera', () => {
    viewer.enterFlying();
    viewer.cancelCameraAnimation();
    expect(viewer.getControlsMode()).toBe('flying');
  });

  it('clearing the pivot mid-flight does not take the camera', () => {
    viewer.enterFlying();
    viewer.clearPivot();
    viewer.resetPivot();
    expect(viewer.getControlsMode()).toBe('flying');
  });
});

describe('flying — no jump', () => {
  it('enter then leave with no input leaves the camera exactly where it was', () => {
    const before = pose();
    viewer.enterFlying();
    frames(3);
    viewer.exitFlying();
    frames(3);
    const after = pose();
    expect(after.p.distanceTo(before.p)).toBeLessThan(1e-9);
    // angleTo bottoms out near 1e-8 (acos of a dot product next to 1).
    expect(after.q.angleTo(before.q)).toBeLessThan(1e-6);
    expect(Math.max(...after.q.toArray().map((x, i) => Math.abs(x - before.q.toArray()[i])))).toBeLessThan(1e-12);
  });

  it('after flying and turning, leaving puts the anchor on the forward axis and orbit polls change nothing', () => {
    viewer.enterFlying();
    key('keydown', 'KeyW');
    key('keydown', 'ArrowLeft');
    key('keydown', 'ArrowUp');
    frames(40);
    key('keyup', 'KeyW');
    key('keyup', 'ArrowLeft');
    key('keyup', 'ArrowUp');
    frames(30);
    // Mid-flight the anchor rides along on the forward axis too.
    expect(anchorOnForwardAxis()).toBeLessThan(1e-6);
    const flown = pose();
    viewer.exitFlying();
    expect(anchorOnForwardAxis()).toBeLessThan(1e-6);
    frames(5); // OrbitControls.update() runs lookAt(target) every frame now
    const after = pose();
    expect(after.p.distanceTo(flown.p)).toBeLessThan(1e-9);
    expect(after.q.angleTo(flown.q)).toBeLessThan(1e-6);
  });

  it('a mouse drag while flying turns the view in place', () => {
    viewer.enterFlying();
    const before = pose();
    Object.defineProperty(canvas, 'clientHeight', { value: 800, configurable: true });
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100, bubbles: true }));
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 110, clientY: 100, bubbles: true }));
    canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 210, clientY: 100, bubbles: true }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, clientX: 210, clientY: 100, bubbles: true }));
    const after = pose();
    expect(after.p.distanceTo(before.p)).toBeLessThan(1e-9);
    expect(after.q.angleTo(before.q)).toBeCloseTo(Math.PI / 8, 3);
    expect(anchorOnForwardAxis()).toBeLessThan(1e-6);
  });
});

describe('flying — keys', () => {
  it('moves with W while flying and not otherwise', () => {
    const start = viewer.getCamera().position.clone();
    key('keydown', 'KeyW');
    frames(10);
    key('keyup', 'KeyW');
    expect(viewer.getCamera().position.distanceTo(start)).toBe(0);
    viewer.enterFlying();
    key('keydown', 'KeyW');
    frames(30);
    expect(viewer.getCamera().position.distanceTo(start)).toBeGreaterThan(1);
  });

  it('releases held keys when the window loses focus', () => {
    viewer.enterFlying();
    key('keydown', 'KeyW');
    frames(10);
    window.dispatchEvent(new Event('blur'));
    frames(60); // ease out
    const stopped = viewer.getCamera().position.clone();
    frames(30);
    expect(viewer.getCamera().position.distanceTo(stopped)).toBe(0);
  });

  it('leaving releases held keys, so re-entering does not fly off', () => {
    viewer.enterFlying();
    key('keydown', 'KeyW');
    frames(5);
    viewer.exitFlying();
    viewer.enterFlying();
    const p = viewer.getCamera().position.clone();
    frames(30);
    expect(viewer.getCamera().position.distanceTo(p)).toBe(0);
  });

  it('fly keys win over other listeners while flying', () => {
    const heard: string[] = [];
    const listener = (e: KeyboardEvent): void => {
      heard.push(e.code);
    };
    document.addEventListener('keydown', listener);
    window.addEventListener('keydown', listener);
    try {
      key('keydown', 'KeyS', {}, document.body);
      expect(heard).toEqual(['KeyS', 'KeyS']);
      heard.length = 0;
      viewer.enterFlying();
      const e = key('keydown', 'KeyS', {}, document.body);
      expect(heard).toEqual([]);
      expect(e.defaultPrevented).toBe(true);
      // Not a fly key: everyone still hears it (F = Fit View, M = Measure …).
      key('keydown', 'KeyM', {}, document.body);
      expect(heard).toEqual(['KeyM', 'KeyM']);
    } finally {
      document.removeEventListener('keydown', listener);
      window.removeEventListener('keydown', listener);
    }
  });

  it('Ctrl / Cmd / Alt chords pass through untouched (undo, browser keys)', () => {
    viewer.enterFlying();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const e = key('keydown', 'KeyW', mod);
      expect(e.defaultPrevented).toBe(false);
    }
    const p = viewer.getCamera().position.clone();
    frames(20);
    expect(viewer.getCamera().position.distanceTo(p)).toBe(0);
  });

  it('ignores keys typed into an input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      viewer.enterFlying();
      const e = key('keydown', 'KeyW', {}, input);
      expect(e.defaultPrevented).toBe(false);
      const p = viewer.getCamera().position.clone();
      frames(20);
      expect(viewer.getCamera().position.distanceTo(p)).toBe(0);
    } finally {
      input.remove();
    }
  });

  it('Space is kept from pressing a focused button', () => {
    viewer.enterFlying();
    const button = document.createElement('button');
    document.body.appendChild(button);
    try {
      expect(key('keydown', 'Space', {}, button).defaultPrevented).toBe(true);
      expect(key('keyup', 'Space', {}, button).defaultPrevented).toBe(true);
    } finally {
      button.remove();
    }
  });

  it('X / Z and the wheel step the speed, and it is kept across flights', () => {
    viewer.enterFlying();
    key('keydown', 'KeyX');
    key('keyup', 'KeyX');
    expect(viewer.getFlySpeed()).toBe(6);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    expect(viewer.getFlySpeed()).toBe(7);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
    key('keydown', 'KeyZ');
    expect(viewer.getFlySpeed()).toBe(5);
    // A trackpad's small deltas add up to one step.
    for (let i = 0; i < 5; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -25, cancelable: true }));
    expect(viewer.getFlySpeed()).toBe(6);
    viewer.exitFlying();
    viewer.enterFlying();
    expect(viewer.getFlySpeed()).toBe(6);
  });

  it('the wheel does not zoom while flying', () => {
    viewer.enterFlying();
    const p = viewer.getCamera().position.clone();
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    expect(viewer.getCamera().position.distanceTo(p)).toBe(0);
  });

  it('asks for no frames once still', () => {
    viewer.enterFlying();
    frame();
    const render = vi.spyOn(viewer.getRenderer(), 'render');
    frames(10);
    expect(render).not.toHaveBeenCalled();
    key('keydown', 'KeyD');
    frames(3);
    expect(render).toHaveBeenCalledTimes(3);
  });
});
