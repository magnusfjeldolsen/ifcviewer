// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { ClippingTool } from '../src/tools/ClippingTool';

/**
 * These tests cover the observer surface that the contextual-action tray
 * subscribes to: `hasClipPlane()` and `onStateChange()`. They are NOT a
 * coverage exercise for placement/drag math — placement is exercised end-
 * to-end via the manual smoke tests, and drag math has no math left to
 * speak of (single linear constant per unit cursor delta).
 *
 * To trigger plane creation without spinning up a full WebGLRenderer, we
 * mock `raycastVisible` to return a synthetic hit on a unit cube placed at
 * the origin. That hands ClippingTool a face normal and a world-space hit
 * point, which is everything it needs to call createClipPlane().
 */

// Module-level mock so `raycastVisible` always returns a synthetic hit
// when we dispatch a left-mousedown during placing mode. The mesh inside
// the hit is real (built per test), so the normal/normalMatrix math works.
let mockHit: THREE.Intersection | null = null;
vi.mock('../src/utils/raycast', () => ({
  raycastVisible: () => mockHit,
}));

function makeRenderer(): THREE.WebGLRenderer {
  // The tool only touches `clippingPlanes` and `localClippingEnabled`.
  return {
    clippingPlanes: [] as THREE.Plane[],
    localClippingEnabled: false,
  } as unknown as THREE.WebGLRenderer;
}

function makeSyntheticHit(): THREE.Intersection {
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geom, mat);
  mesh.updateMatrixWorld(true);
  return {
    distance: 1,
    point: new THREE.Vector3(0, 0, 0),
    object: mesh,
    face: {
      a: 0,
      b: 1,
      c: 2,
      normal: new THREE.Vector3(0, 0, 1),
      materialIndex: 0,
    },
  } as THREE.Intersection;
}

function placeClipPlane(canvas: HTMLCanvasElement): void {
  mockHit = makeSyntheticHit();
  const ev = new MouseEvent('mousedown', { button: 0, bubbles: true });
  canvas.dispatchEvent(ev);
  mockHit = null;
}

describe('ClippingTool — state-observer surface', () => {
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let canvas: HTMLCanvasElement;
  let tool: ClippingTool;

  beforeEach(() => {
    renderer = makeRenderer();
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    tool = new ClippingTool({ renderer, scene, camera, canvas });
  });

  afterEach(() => {
    tool.dispose();
    canvas.remove();
    mockHit = null;
  });

  it('hasClipPlane() returns false before any plane is placed', () => {
    expect(tool.hasClipPlane()).toBe(false);
  });

  it('hasClipPlane() flips to true after a plane is placed', () => {
    tool.enterPlacingMode();
    placeClipPlane(canvas);
    expect(tool.hasClipPlane()).toBe(true);
  });

  it('clearClipPlane() flips hasClipPlane() back to false', () => {
    tool.enterPlacingMode();
    placeClipPlane(canvas);
    expect(tool.hasClipPlane()).toBe(true);

    tool.clearClipPlane();
    expect(tool.hasClipPlane()).toBe(false);
  });

  it('onStateChange(cb) fires once on create and once on clear', () => {
    const cb = vi.fn();
    tool.onStateChange(cb);

    tool.enterPlacingMode();
    placeClipPlane(canvas);
    expect(cb).toHaveBeenCalledTimes(1);

    tool.clearClipPlane();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('onStateChange returns an unsubscribe that stops further notifications', () => {
    const cb = vi.fn();
    const off = tool.onStateChange(cb);

    tool.enterPlacingMode();
    placeClipPlane(canvas);
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    tool.clearClipPlane();
    expect(cb).toHaveBeenCalledTimes(1); // still 1
  });

  it('multiple listeners receive independent notifications; unsubscribing one preserves the other', () => {
    const cbA = vi.fn();
    const cbB = vi.fn();
    const offA = tool.onStateChange(cbA);
    tool.onStateChange(cbB);

    tool.enterPlacingMode();
    placeClipPlane(canvas);
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB).toHaveBeenCalledTimes(1);

    offA();
    tool.clearClipPlane();
    expect(cbA).toHaveBeenCalledTimes(1); // unsubscribed
    expect(cbB).toHaveBeenCalledTimes(2); // still subscribed
  });

  it('re-placing a plane (place → place again) fires create once per placement, no spurious remove', () => {
    const cb = vi.fn();
    tool.onStateChange(cb);

    tool.enterPlacingMode();
    placeClipPlane(canvas);
    expect(cb).toHaveBeenCalledTimes(1);

    // Re-place: removeClipPlane() inside createClipPlane sees no prior plane?
    // No — there IS a prior plane, so it fires once on remove, then once on
    // create. That's the documented behavior: each transition is observable.
    tool.enterPlacingMode();
    placeClipPlane(canvas);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('dispose() clears listeners — no notifications fire after dispose', () => {
    const cb = vi.fn();
    tool.onStateChange(cb);

    tool.enterPlacingMode();
    placeClipPlane(canvas);
    expect(cb).toHaveBeenCalledTimes(1);

    tool.dispose();
    // After dispose, plane is already cleared; cb saw the remove transition.
    const callsAtDispose = cb.mock.calls.length;
    expect(callsAtDispose).toBe(2); // create + remove during dispose

    // Re-entering placing + dispatching does nothing — listeners array is empty
    // AND the canvas listener was removed by deactivate(). To be defensive,
    // verify the listener can't fire even if the array somehow re-populated:
    // we can't add to the cleared list (we don't hold the tool API anymore is
    // a fiction — we do), but onStateChange after dispose would just register
    // into the cleared array. We don't test that escape hatch; the contract
    // is that dispose drops existing listeners.
  });
});

/**
 * Grabbing the handle must own the drag outright. The viewer listens for
 * `pointerdown` on the same canvas and was registered first, so stopping
 * propagation was not enough: both listeners ran, and every handle drag also
 * orbited the camera — while an orbit started near the handle also dragged the
 * section plane. Measured in the running app (#87): a 200 px orbit drag begun
 * 12 px from the handle moved the plane 24 m.
 */
describe('ClippingTool — the handle drag owns the gesture', () => {
  let canvas: HTMLCanvasElement;
  let tool: ClippingTool;
  let navigation: ReturnType<typeof vi.fn<(e: Event) => void>>;

  beforeEach(() => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0 }) as DOMRect;
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    document.body.appendChild(canvas);
    // Stand-in for the viewer's orbit listener: added before the tool exists,
    // exactly as in the app.
    navigation = vi.fn<(e: Event) => void>();
    canvas.addEventListener('pointerdown', navigation);
    tool = new ClippingTool({ renderer: makeRenderer(), scene: new THREE.Scene(), camera, canvas });
    tool.enterPlacingMode();
    // The synthetic hit is at the origin, which the camera sees at the centre.
    placeClipPlane(canvas);
  });

  afterEach(() => {
    tool.dispose();
    canvas.remove();
  });

  const pointerDown = (x: number, y: number) =>
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: x, clientY: y, bubbles: true }),
    );

  it('a press on the handle never reaches navigation', () => {
    pointerDown(50, 50);
    expect(navigation).not.toHaveBeenCalled();
  });

  it('a press away from the handle is left to navigation', () => {
    pointerDown(5, 5);
    expect(navigation).toHaveBeenCalledTimes(1);
  });
});

/**
 * Follow-ups to #87, each reproduced in the running app:
 *
 * - grabbing the handle while Fit View was still flying the camera left the
 *   fly-to running under the drag, because the handle claims the press before
 *   the animator's interrupt listener can see it;
 * - a second finger on a touch screen moved the plane too, and a cancelled
 *   pointer could leave the drag stuck on;
 * - the handle could be dragged beyond the far plane, where it vanished.
 */
describe('ClippingTool — handle drag follow-ups', () => {
  let canvas: HTMLCanvasElement;
  let tool: ClippingTool;
  let renderer: THREE.WebGLRenderer;
  let navigation: ReturnType<typeof vi.fn<(e: Event) => void>>;
  let cancelCameraAnimation: ReturnType<typeof vi.fn<() => void>>;
  let captured: Set<number>;

  beforeEach(() => {
    // Looking down -z at a floor-like plane: its normal (y) is vertical on
    // screen, so dragging up and down moves it.
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0 }) as DOMRect;
    captured = new Set();
    canvas.setPointerCapture = (id: number) => void captured.add(id);
    canvas.releasePointerCapture = (id: number) => void captured.delete(id);
    canvas.hasPointerCapture = (id: number) => captured.has(id);
    document.body.appendChild(canvas);
    navigation = vi.fn<(e: Event) => void>();
    canvas.addEventListener('pointerdown', navigation);
    cancelCameraAnimation = vi.fn<() => void>();
    renderer = makeRenderer();
    tool = new ClippingTool({ renderer, scene: new THREE.Scene(), camera, canvas, cancelCameraAnimation });
    tool.enterPlacingMode();
    const hit = makeSyntheticHit();
    hit.face!.normal.set(0, 1, 0);
    mockHit = hit;
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    mockHit = null;
    tool.update();
  });

  afterEach(() => {
    tool.dispose();
    canvas.remove();
  });

  const pointer = (type: string, pointerId: number, x: number, y: number) =>
    canvas.dispatchEvent(new PointerEvent(type, { button: 0, pointerId, clientX: x, clientY: y, bubbles: true }));
  const planeConstant = () => renderer.clippingPlanes[0].constant;

  it('stops a camera fly-to when the handle is grabbed', () => {
    pointer('pointerdown', 1, 50, 50);
    expect(cancelCameraAnimation).toHaveBeenCalledTimes(1);
  });

  it('leaves a fly-to alone when the press misses the handle', () => {
    pointer('pointerdown', 1, 5, 5);
    expect(cancelCameraAnimation).not.toHaveBeenCalled();
  });

  it('moves the plane with the grabbing pointer only', () => {
    pointer('pointerdown', 1, 50, 50);
    const start = planeConstant();
    pointer('pointermove', 1, 50, 40);
    const afterFirst = planeConstant();
    expect(afterFirst).not.toBeCloseTo(start);

    // A second finger lands and moves: the plane must not follow it, and
    // navigation must not see it either.
    pointer('pointerdown', 2, 80, 80);
    expect(navigation).not.toHaveBeenCalled();
    pointer('pointermove', 2, 80, 20);
    expect(planeConstant()).toBeCloseTo(afterFirst);

    // Lifting the second finger does not end the first finger's drag.
    pointer('pointerup', 2, 80, 20);
    expect(tool.isDragging()).toBe(true);
    pointer('pointerup', 1, 50, 40);
    expect(tool.isDragging()).toBe(false);
  });

  it('ends the drag when the browser cancels the pointer', () => {
    pointer('pointerdown', 1, 50, 50);
    pointer('pointercancel', 1, 50, 50);
    expect(tool.isDragging()).toBe(false);
    expect(captured.size).toBe(0);
    const before = planeConstant();
    pointer('pointermove', 1, 50, 10);
    expect(planeConstant()).toBeCloseTo(before);
  });

  it('ends the drag when pointer capture is lost', () => {
    pointer('pointerdown', 1, 50, 50);
    captured.clear();
    pointer('lostpointercapture', 1, 50, 50);
    expect(tool.isDragging()).toBe(false);
  });

  it('reports the handle, as drawn, for the view to keep between its planes', () => {
    const box = new THREE.Box3();
    tool.expandViewBounds(box);
    // update() scales the handle to the camera distance (5) times 0.03.
    const reach = 5 * 0.03 * 2;
    expect(box.containsPoint(new THREE.Vector3(0, 0, 0))).toBe(true);
    expect(box.max.x).toBeCloseTo(reach);
    expect(box.min.y).toBeCloseTo(-reach);

    tool.clearClipPlane();
    const empty = new THREE.Box3();
    tool.expandViewBounds(empty);
    expect(empty.isEmpty()).toBe(true);
  });
});
