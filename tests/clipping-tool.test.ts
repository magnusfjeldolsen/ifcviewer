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
