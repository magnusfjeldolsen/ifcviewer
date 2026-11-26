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

  for (const polar of [1e-6, 1e-4, 0.005]) {
    it(`entering from a plan view (polar ${polar}), a 1 px drag turns the view by 1 px worth and keeps the heading`, () => {
      // Orbit's plan view: looking down, the top of the screen towards −Z.
      viewer.restoreCameraState({
        position: { x: 0, y: 50, z: 0 },
        target: { x: 0, y: 50 - 10 * Math.cos(polar), z: -10 * Math.sin(polar) },
      });
      frame();
      viewer.enterFlying();
      const before = pose();
      const right0 = new THREE.Vector3(1, 0, 0).applyQuaternion(before.q);
      Object.defineProperty(canvas, 'clientHeight', { value: 800, configurable: true });
      const at = (type: string, x: number): boolean =>
        canvas.dispatchEvent(new PointerEvent(type, { button: 0, pointerId: 7, clientX: x, clientY: 100, bubbles: true }));
      at('pointerdown', 100);
      at('pointermove', 104); // crosses the click threshold
      at('pointermove', 105); // one pixel of look
      at('pointerup', 105);
      const after = pose();
      const onePixel = Math.PI / 800;
      expect(after.q.angleTo(before.q)).toBeLessThanOrEqual(onePixel * 1.0001 + 1e-7);
      const right1 = new THREE.Vector3(1, 0, 0).applyQuaternion(after.q);
      expect(right1.angleTo(right0)).toBeCloseTo(onePixel, 5);
    });
  }

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

  it('fly keys win over other listeners when focus is on the view', () => {
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

  it('leaves keys alone when focus is in a panel or on a control', () => {
    const panel = document.createElement('div');
    const tab = document.createElement('button'); // a Parameters tab, a Totals line …
    const handle = document.createElement('div'); // the panel resize handle
    handle.tabIndex = 0;
    panel.append(tab, handle);
    document.body.appendChild(panel);
    const heard: string[] = [];
    const listener = (e: KeyboardEvent): void => {
      heard.push(e.code);
    };
    panel.addEventListener('keydown', listener);
    try {
      viewer.enterFlying();
      const start = pose();
      for (const [target, code] of [[tab, 'Space'], [handle, 'ArrowLeft'], [tab, 'ArrowRight'], [handle, 'KeyW']] as const) {
        const down = key('keydown', code, {}, target);
        expect(down.defaultPrevented).toBe(false);
        expect(key('keyup', code, {}, target).defaultPrevented).toBe(false);
      }
      expect(heard).toEqual(['Space', 'ArrowLeft', 'ArrowRight', 'KeyW']);
      frames(20);
      const after = pose();
      expect(after.p.distanceTo(start.p)).toBe(0);
      expect(after.q.angleTo(start.q)).toBeLessThan(1e-6);
    } finally {
      panel.remove();
    }
  });

  it('clicking the view takes focus back from a panel', () => {
    const tab = document.createElement('button');
    document.body.appendChild(tab);
    try {
      tab.focus();
      expect(document.activeElement).toBe(tab);
      canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 3, clientX: 5, clientY: 5, bubbles: true }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 3, clientX: 5, clientY: 5, bubbles: true }));
      expect(document.activeElement).toBe(document.body);
    } finally {
      tab.remove();
    }
  });

  it('fly keys do nothing while something else has the keyboard (menu, help card)', () => {
    let open = true;
    viewer.setFlyKeysSuspended(() => open);
    viewer.enterFlying();
    const p = viewer.getCamera().position.clone();
    expect(key('keydown', 'KeyW').defaultPrevented).toBe(false);
    frames(20);
    expect(viewer.getCamera().position.distanceTo(p)).toBe(0);
    key('keyup', 'KeyW');
    open = false;
    expect(key('keydown', 'KeyW').defaultPrevented).toBe(true);
    frames(20);
    expect(viewer.getCamera().position.distanceTo(p)).toBeGreaterThan(0.5);
  });

  it('a Cmd chord lets go of held keys (macOS sends no keyup for them)', () => {
    viewer.enterFlying();
    key('keydown', 'KeyW');
    key('keydown', 'MetaLeft', { metaKey: true });
    // W is released under Cmd: its keyup never comes.
    frames(60);
    const stopped = viewer.getCamera().position.clone();
    frames(20);
    expect(viewer.getCamera().position.distanceTo(stopped)).toBe(0);
  });

  it('releasing Cmd lets go of held keys too', () => {
    viewer.enterFlying();
    key('keydown', 'KeyD');
    key('keyup', 'MetaRight', { key: 'Meta' });
    frames(60);
    const stopped = viewer.getCamera().position.clone();
    frames(20);
    expect(viewer.getCamera().position.distanceTo(stopped)).toBe(0);
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

  it('Space on the view is kept from scrolling the page', () => {
    viewer.enterFlying();
    expect(key('keydown', 'Space', {}, document.body).defaultPrevented).toBe(true);
    expect(key('keyup', 'Space', {}, document.body).defaultPrevented).toBe(true);
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
    // The field of view eases wider for its first ~250 ms (#116).
    frames(20);
    const render = vi.spyOn(viewer.getRenderer(), 'render');
    frames(10);
    expect(render).not.toHaveBeenCalled();
    key('keydown', 'KeyD');
    frames(3);
    expect(render).toHaveBeenCalledTimes(3);
  });
});

describe('flying — pointer lock', () => {
  let lockEl: Element | null;
  let requestLock: ReturnType<typeof vi.fn>;
  let exitLock: ReturnType<typeof vi.fn>;

  const lockChanged = (): void => {
    document.dispatchEvent(new Event('pointerlockchange'));
  };
  const grant = (): void => {
    lockEl = canvas;
    lockChanged();
    // The first movement after a grant is dropped (it can be a spurious jump).
    mouse('pointermove', { movementX: 1 });
  };

  beforeEach(() => {
    lockEl = null;
    Object.defineProperty(document, 'pointerLockElement', { get: () => lockEl, configurable: true });
    requestLock = vi.fn(() => Promise.resolve());
    exitLock = vi.fn(() => {
      lockEl = null;
      lockChanged();
    });
    (canvas as unknown as { requestPointerLock: unknown }).requestPointerLock = requestLock;
    (document as unknown as { exitPointerLock: unknown }).exitPointerLock = exitLock;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
  });

  afterEach(() => {
    delete (document as unknown as { pointerLockElement?: unknown }).pointerLockElement;
  });

  /** A mouse event on the canvas, with movement (jsdom drops it from the init). */
  function mouse(type: string, init: PointerEventInit & { movementX?: number; movementY?: number } = {}): PointerEvent | MouseEvent {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    const e = new Ctor(type, { bubbles: true, cancelable: true, clientX: 5, clientY: 7, pointerId: 1, ...init });
    Object.defineProperty(e, 'movementX', { value: init.movementX ?? 0 });
    Object.defineProperty(e, 'movementY', { value: init.movementY ?? 0 });
    canvas.dispatchEvent(e);
    return e;
  }

  it('entering asks for the lock, with raw mouse movement', () => {
    viewer.enterFlying();
    expect(requestLock).toHaveBeenCalledWith({ unadjustedMovement: true });
    expect(viewer.getFlyLook()).toBe('mouse');
  });

  it('falls back to a plain lock where raw movement is not supported', async () => {
    requestLock.mockImplementationOnce(() => Promise.reject(new Error('NotSupportedError')));
    viewer.enterFlying();
    await Promise.resolve();
    await Promise.resolve();
    expect(requestLock).toHaveBeenCalledTimes(2);
    expect(requestLock.mock.calls[1]).toEqual([undefined]);
  });

  it('moving the captured mouse turns the view with no button held', () => {
    viewer.enterFlying();
    grant();
    const before = pose();
    mouse('pointermove', { movementX: 60, movementY: 0 });
    const after = pose();
    expect(after.p.distanceTo(before.p)).toBe(0);
    // Same feel as drag-to-look: half a turn per view height.
    expect(after.q.angleTo(before.q)).toBeCloseTo((60 * Math.PI) / 600, 4);
  });

  it('a press while captured starts no gesture of ours', () => {
    viewer.enterFlying();
    grant();
    const before = pose();
    mouse('pointerdown', { button: 0 });
    mouse('pointermove', { clientX: 300, clientY: 300 }); // no movement: the cursor is frozen
    mouse('pointerup', { button: 0 });
    expect(pose().q.angleTo(before.q)).toBeLessThan(1e-6);
  });

  it('clicks land at the crosshair in the centre, modifiers kept', () => {
    viewer.enterFlying();
    grant();
    const seen: Array<[string, number, number, boolean]> = [];
    const record = (e: MouseEvent): void => {
      seen.push([e.type, e.clientX, e.clientY, e.ctrlKey]);
    };
    canvas.addEventListener('pointerdown', record);
    canvas.addEventListener('click', record);
    try {
      mouse('pointerdown', { button: 0, ctrlKey: true });
      mouse('click', { button: 0, ctrlKey: true });
      expect(seen).toEqual([
        ['pointerdown', 400, 300, true],
        ['click', 400, 300, true],
      ]);
    } finally {
      canvas.removeEventListener('pointerdown', record);
      canvas.removeEventListener('click', record);
    }
  });

  it('a right-click opens the menu at the crosshair and leaves flying', () => {
    viewer.enterFlying();
    grant();
    let at: [number, number] | null = null;
    const onMenu = (e: MouseEvent): void => {
      at = [e.clientX, e.clientY];
      e.preventDefault();
    };
    canvas.addEventListener('contextmenu', onMenu);
    try {
      const e = mouse('contextmenu', { button: 2 });
      expect(at).toEqual([400, 300]);
      expect(e.defaultPrevented).toBe(true);
      expect(viewer.isFlying()).toBe(false);
      expect(exitLock).toHaveBeenCalled();
    } finally {
      canvas.removeEventListener('contextmenu', onMenu);
    }
  });

  it('Chrome sends no contextmenu while locked: releasing the right button opens the menu at the crosshair', () => {
    viewer.enterFlying();
    grant();
    let at: [number, number] | null = null;
    const onMenu = (e: MouseEvent): void => {
      at = [e.clientX, e.clientY];
    };
    canvas.addEventListener('contextmenu', onMenu);
    try {
      mouse('pointerdown', { button: 2 });
      mouse('pointerup', { button: 2 });
      expect(at).toEqual([400, 300]);
      expect(viewer.isFlying()).toBe(false);
      expect(lockEl).toBeNull();
    } finally {
      canvas.removeEventListener('contextmenu', onMenu);
    }
  });

  it('a mouse move arriving after the browser let go (Esc) does not turn the view', () => {
    viewer.enterFlying();
    grant();
    const before = pose();
    lockEl = null; // released; 'pointerlockchange' not yet delivered
    mouse('pointermove', { movementX: 200, movementY: 50 });
    expect(pose().q.angleTo(before.q)).toBeLessThan(1e-6);
    lockChanged();
    expect(viewer.isFlying()).toBe(false);
  });

  it('losing the lock (Esc, Alt+Tab) leaves flying and hands back to the user', () => {
    const changes: boolean[] = [];
    viewer.onFlyingChange((f) => changes.push(f));
    viewer.enterFlying();
    grant();
    const before = pose();
    lockEl = null;
    lockChanged();
    expect(viewer.getControlsMode()).toBe('user');
    expect(changes).toEqual([true, false]);
    frames(3);
    const after = pose();
    expect(after.p.distanceTo(before.p)).toBeLessThan(1e-9);
    expect(after.q.angleTo(before.q)).toBeLessThan(1e-6);
    // Clicks are the page's own again.
    let x = -1;
    const onClick = (e: MouseEvent): void => {
      x = e.clientX;
    };
    canvas.addEventListener('click', onClick);
    mouse('click');
    canvas.removeEventListener('click', onClick);
    expect(x).toBe(5);
  });

  const exits: Array<[string, () => void]> = [
    ['G / toggleFlying', () => viewer.toggleFlying()],
    ['exitFlying', () => viewer.exitFlying()],
    ['fitToBox', () => viewer.fitToBox(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)))],
    ['flyToBox', () => void viewer.flyToBox(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)))],
    ['restoreCameraState', () => viewer.restoreCameraState({ position: { x: 5, y: 5, z: 5 }, target: { x: 0, y: 0, z: 0 } })],
    ['setControlsMode', () => viewer.setControlsMode('user')],
    ['dispose', () => viewer.dispose()],
  ];
  for (const [name, leave] of exits) {
    it(`${name} releases the lock`, () => {
      viewer.enterFlying();
      grant();
      leave();
      expect(exitLock).toHaveBeenCalledTimes(1);
      expect(lockEl).toBeNull();
      expect(viewer.isFlying()).toBe(false);
      expect(viewer.getControlsMode()).not.toBe('flying');
    });
  }

  it('when the lock is refused, flying carries on with drag-to-look and a click asks again', async () => {
    requestLock.mockImplementation(() => Promise.reject(new Error('refused')));
    const looks: string[] = [];
    viewer.onFlyLookChange((l) => looks.push(l));
    viewer.enterFlying();
    await new Promise((r) => setTimeout(r, 0));
    expect(viewer.isFlying()).toBe(true);
    expect(viewer.getFlyLook()).toBe('drag');
    expect(looks).toEqual(['mouse', 'drag']);
    // Dragging still looks.
    const before = pose();
    mouse('pointerdown', { button: 0, clientX: 100, clientY: 100 });
    mouse('pointermove', { clientX: 110, clientY: 100 });
    mouse('pointermove', { clientX: 160, clientY: 100 });
    mouse('pointerup', { button: 0, clientX: 160, clientY: 100 });
    expect(pose().q.angleTo(before.q)).toBeGreaterThan(0.1);
    const calls = requestLock.mock.calls.length;
    // A drag does not ask again; a click does.
    expect(requestLock.mock.calls.length).toBe(calls);
    mouse('pointerdown', { button: 0, clientX: 200, clientY: 200 });
    mouse('pointerup', { button: 0, clientX: 200, clientY: 200 });
    expect(requestLock.mock.calls.length).toBe(calls + 1);
    // Granted later: the mouse looks by itself from then on.
    grant();
    expect(viewer.getFlyLook()).toBe('mouse');
  });

  it('without the Pointer Lock API at all, flying uses drag-to-look', () => {
    delete (canvas as unknown as { requestPointerLock?: unknown }).requestPointerLock;
    viewer.enterFlying();
    expect(viewer.getFlyLook()).toBe('drag');
  });

  it('a lock granted (promise) after flying was left is released at once', async () => {
    let resolveLock!: () => void;
    requestLock.mockImplementation(() => new Promise<void>((r) => (resolveLock = r)));
    viewer.enterFlying();
    viewer.toggleFlying(); // G twice quickly: left while the request is pending
    expect(viewer.isFlying()).toBe(false);
    lockEl = canvas; // the browser grants it anyway
    resolveLock();
    await Promise.resolve();
    await Promise.resolve();
    expect(exitLock).toHaveBeenCalled();
    expect(lockEl).toBeNull();
    expect(viewer.getControlsMode()).toBe('user');
    expect(internals(viewer).controls.enabled).toBe(true);
  });

  it('a lock granted (event) after flying was left is released at once', () => {
    requestLock.mockImplementation(() => undefined); // older API: no promise
    viewer.enterFlying();
    viewer.fitToBox(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1))); // Fit during the pending window
    lockEl = canvas;
    lockChanged();
    expect(exitLock).toHaveBeenCalled();
    expect(lockEl).toBeNull();
    expect(viewer.isFlying()).toBe(false);
    expect(internals(viewer).controls.enabled).toBe(true);
  });

  it('a refused raw-movement lock does not flash drag mode while the plain retry runs', async () => {
    const looks: string[] = [];
    viewer.onFlyLookChange((l) => looks.push(l));
    requestLock.mockImplementationOnce(() => {
      queueMicrotask(() => document.dispatchEvent(new Event('pointerlockerror')));
      return Promise.reject(new Error('NotSupportedError'));
    });
    requestLock.mockImplementationOnce(() => new Promise<void>(() => {})); // still pending
    viewer.enterFlying();
    await new Promise((r) => setTimeout(r, 0));
    expect(requestLock).toHaveBeenCalledTimes(2);
    expect(viewer.getFlyLook()).toBe('mouse');
    expect(looks).toEqual(['mouse']);
  });

  it('drops the first movement after a grant, and caps a single huge one', () => {
    viewer.enterFlying();
    lockEl = canvas;
    lockChanged();
    const q0 = pose().q;
    mouse('pointermove', { movementX: 3000 }); // spurious jump right after the grant
    expect(pose().q.angleTo(q0)).toBeLessThan(1e-6);
    const q1 = pose().q;
    mouse('pointermove', { movementX: 5000 }); // a glitch later on: capped
    expect(pose().q.angleTo(q1)).toBeCloseTo((250 * Math.PI) / 600, 4);
  });

  it('releasing the left button after the view turned is not a click at the centre', () => {
    viewer.enterFlying();
    grant();
    const ups: number[] = [];
    let clicks = 0;
    const onUp = (e: PointerEvent): void => {
      ups.push(e.clientX);
    };
    const onClick = (): void => {
      clicks++;
    };
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('click', onClick);
    try {
      mouse('pointerdown', { button: 0 });
      mouse('pointermove', { movementX: 20 });
      mouse('pointerup', { button: 0 });
      mouse('click', { button: 0 });
      expect(clicks).toBe(0);
      expect(Math.abs(ups[0] - 400)).toBeGreaterThan(10); // downstream sees a drag
      // A still press and release is still a click at the centre.
      mouse('pointerdown', { button: 0 });
      mouse('pointerup', { button: 0 });
      mouse('click', { button: 0 });
      expect(clicks).toBe(1);
      expect(ups[1]).toBe(400);
    } finally {
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('click', onClick);
    }
  });

  it('releasing the right button after the view turned opens no menu and keeps flying', () => {
    viewer.enterFlying();
    grant();
    let menus = 0;
    const onMenu = (): void => {
      menus++;
    };
    canvas.addEventListener('contextmenu', onMenu);
    try {
      mouse('pointerdown', { button: 2 });
      mouse('pointermove', { movementX: -15, movementY: 10 });
      mouse('pointerup', { button: 2 });
      const native = mouse('contextmenu', { button: 2 }); // Firefox sends one while locked
      expect(menus).toBe(0);
      expect(native.defaultPrevented).toBe(true);
      expect(viewer.isFlying()).toBe(true);
    } finally {
      canvas.removeEventListener('contextmenu', onMenu);
    }
  });

  it("swallows the browser's own contextmenu right after ours", () => {
    viewer.enterFlying();
    grant();
    const at: Array<[number, number]> = [];
    const onMenu = (e: MouseEvent): void => {
      at.push([e.clientX, e.clientY]);
    };
    canvas.addEventListener('contextmenu', onMenu);
    try {
      mouse('pointerdown', { button: 2 });
      mouse('pointerup', { button: 2 });
      expect(at).toEqual([[400, 300]]);
      expect(viewer.isFlying()).toBe(false);
      // Firefox on Windows: its own contextmenu on mouseup, at the frozen cursor.
      const late = mouse('contextmenu', { button: 2, clientX: 5, clientY: 7 });
      expect(late.defaultPrevented).toBe(true);
      expect(at).toEqual([[400, 300]]);
      // Only that one: the next right-click is the page's own again.
      mouse('contextmenu', { button: 2, clientX: 9, clientY: 9 });
      expect(at).toEqual([[400, 300], [9, 9]]);
    } finally {
      canvas.removeEventListener('contextmenu', onMenu);
    }
  });
  it('the mouse wheel still sets the speed while captured', () => {
    viewer.enterFlying();
    grant();
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true, bubbles: true }));
    expect(viewer.getFlySpeed()).toBe(6);
  });
});

describe('flying — pointer lock and OrbitControls', () => {
  it('OrbitControls sits out while the pointer is captured, and comes back', () => {
    let lockEl: Element | null = null;
    Object.defineProperty(document, 'pointerLockElement', { get: () => lockEl, configurable: true });
    (canvas as unknown as { requestPointerLock: unknown }).requestPointerLock = () => Promise.resolve();
    (document as unknown as { exitPointerLock: unknown }).exitPointerLock = () => {
      lockEl = null;
      document.dispatchEvent(new Event('pointerlockchange'));
    };
    try {
      const controls = internals(viewer).controls;
      viewer.enterFlying();
      lockEl = canvas;
      document.dispatchEvent(new Event('pointerlockchange'));
      // A locked pointer refuses pointer capture, which OrbitControls asks for.
      expect(controls.enabled).toBe(false);
      viewer.exitFlying();
      expect(controls.enabled).toBe(true);
      viewer.enterFlying();
      lockEl = canvas;
      document.dispatchEvent(new Event('pointerlockchange'));
      lockEl = null;
      document.dispatchEvent(new Event('pointerlockchange')); // Esc
      expect(controls.enabled).toBe(true);
    } finally {
      delete (document as unknown as { pointerLockElement?: unknown }).pointerLockElement;
    }
  });
});

describe('flying — looking at what is under the centre', () => {
  let lockEl: Element | null;
  let probes: boolean[];

  beforeEach(() => {
    lockEl = null;
    probes = [];
    Object.defineProperty(document, 'pointerLockElement', { get: () => lockEl, configurable: true });
    (canvas as unknown as { requestPointerLock: unknown }).requestPointerLock = () => Promise.resolve();
    (document as unknown as { exitPointerLock: unknown }).exitPointerLock = () => {
      lockEl = null;
      document.dispatchEvent(new Event('pointerlockchange'));
    };
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
    viewer.onFlyProbe((fast) => probes.push(fast));
  });

  afterEach(() => {
    delete (document as unknown as { pointerLockElement?: unknown }).pointerLockElement;
  });

  const lock = (): void => {
    viewer.enterFlying();
    lockEl = canvas;
    document.dispatchEvent(new Event('pointerlockchange'));
    look(1); // the first movement after a grant is dropped
  };
  const look = (dx: number): void => {
    const e = new PointerEvent('pointermove', { bubbles: true, pointerId: 1 });
    Object.defineProperty(e, 'movementX', { value: dx });
    Object.defineProperty(e, 'movementY', { value: 0 });
    canvas.dispatchEvent(e);
  };

  it('never looks outside flying', () => {
    frames(60);
    expect(probes).toEqual([]);
  });

  it('never looks in the drag-to-look fallback (no lock)', () => {
    viewer.enterFlying();
    key('keydown', 'KeyW');
    frames(60);
    expect(probes).toEqual([]);
  });

  it('looks once on capture, then only when the view moves', () => {
    lock();
    frames(30);
    expect(probes.length).toBe(1);
    frames(30);
    expect(probes.length).toBe(1);
    look(5);
    frames(10);
    expect(probes.length).toBe(2);
  });

  it('looks at most ten times a second while the view keeps moving', () => {
    lock();
    frame();
    probes.length = 0;
    for (let i = 0; i < 60; i++) {
      look(2);
      frame();
    }
    expect(probes.length).toBeGreaterThanOrEqual(9);
    expect(probes.length).toBeLessThanOrEqual(11);
  });

  it('skips frames that are already over budget', () => {
    lock();
    frame();
    probes.length = 0;
    // Every draw takes 20 ms.
    vi.spyOn(viewer.getRenderer(), 'render').mockImplementation(() => {
      now += 20;
    });
    for (let i = 0; i < 60; i++) {
      look(2);
      frame();
    }
    expect(probes).toEqual([]);
  });

  it('says when the view is turning fast, and not once it is still', () => {
    lock();
    frame();
    probes.length = 0;
    for (let i = 0; i < 12; i++) {
      look(40); // ~12 rad/s
      frame();
    }
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((f) => f)).toBe(true);
    probes.length = 0;
    look(1);
    frames(10);
    expect(probes[probes.length - 1]).toBe(false);
  });

  it('nothing is looked at after leaving', () => {
    lock();
    frame();
    viewer.exitFlying();
    probes.length = 0;
    frames(30);
    expect(probes).toEqual([]);
  });
});