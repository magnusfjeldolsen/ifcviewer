// @vitest-environment jsdom
/**
 * The wider view while flying (#116): eased in on entering, eased or snapped
 * back on every way of leaving, always ending exactly at the orbit value with
 * the projection rebuilt, and drawing only while the ease runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

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
const { FLY_FOV_DEG, ORBIT_FOV_DEG, FOV_EASE_MS } = await import('../src/viewer/flyFov');
type ViewerT = InstanceType<typeof Viewer>;

let canvas: HTMLCanvasElement;
let viewer: ViewerT;
let now = 0;
let lockEl: Element | null = null;

function frame(ms = 1000 / 60): void {
  now += ms;
  (viewer as unknown as { animate: () => void }).animate();
}

/** Run frames until `ms` have passed. */
function run(ms: number): void {
  const end = now + ms;
  while (now < end) frame();
}

const fov = (): number => viewer.getCamera().fov;

/** The projection matrix agrees with `camera.fov` (updateProjectionMatrix was called). */
function projectionMatchesFov(): boolean {
  const cam = viewer.getCamera();
  const expected = 1 / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
  return Math.abs(cam.projectionMatrix.elements[5] - expected) < 1e-9;
}

const box = (): THREE.Box3 => new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 10, 10));

beforeEach(() => {
  now = 0;
  lockEl = null;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  Object.defineProperty(document, 'pointerLockElement', { get: () => lockEl, configurable: true });
  canvas = document.createElement('canvas');
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  canvas.hasPointerCapture = () => false;
  (canvas as unknown as { requestPointerLock: unknown }).requestPointerLock = vi.fn(() => Promise.resolve());
  (document as unknown as { exitPointerLock: unknown }).exitPointerLock = vi.fn(() => {
    lockEl = null;
    document.dispatchEvent(new Event('pointerlockchange'));
  });
  document.body.appendChild(canvas);
  viewer = new Viewer(canvas);
  viewer.fitToBox(box());
  frame();
});

afterEach(() => {
  viewer.dispose();
  canvas.remove();
  delete (document as unknown as { pointerLockElement?: unknown }).pointerLockElement;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fly field of view — entering', () => {
  it('starts at the orbit value', () => {
    expect(fov()).toBe(ORBIT_FOV_DEG);
    expect(projectionMatchesFov()).toBe(true);
  });

  it('eases wider over about the ease time, with no jump on the first frame', () => {
    viewer.enterFlying();
    expect(fov()).toBe(ORBIT_FOV_DEG);
    frame();
    expect(fov()).toBeGreaterThan(ORBIT_FOV_DEG);
    expect(fov()).toBeLessThan(ORBIT_FOV_DEG + 2);
    expect(projectionMatchesFov()).toBe(true);
    run(FOV_EASE_MS / 2);
    expect(fov()).toBeGreaterThan(ORBIT_FOV_DEG);
    expect(fov()).toBeLessThan(FLY_FOV_DEG);
    run(FOV_EASE_MS);
    expect(fov()).toBe(FLY_FOV_DEG);
    expect(projectionMatchesFov()).toBe(true);
  });

  it('draws every frame of the ease and nothing once it is over and still', () => {
    const render = vi.spyOn(viewer.getRenderer(), 'render');
    viewer.enterFlying();
    run(FOV_EASE_MS + 50);
    const during = render.mock.calls.length;
    expect(during).toBeGreaterThanOrEqual(Math.floor(FOV_EASE_MS / (1000 / 60)));
    render.mockClear();
    run(500);
    expect(render).not.toHaveBeenCalled();
  });
});

describe('fly field of view — leaving', () => {
  function flyWide(): void {
    viewer.enterFlying();
    run(FOV_EASE_MS + 20);
    expect(fov()).toBe(FLY_FOV_DEG);
  }

  const eased: Array<[string, () => void]> = [
    ['exitFlying (G, Esc, the toolbar button)', () => viewer.exitFlying()],
    ['toggleFlying', () => viewer.toggleFlying()],
    ['setControlsMode', () => viewer.setControlsMode('user')],
    ['flyToBox (animated fit)', () => void viewer.flyToBox(box())],
    [
      'pointer lock lost',
      () => {
        lockEl = null;
        document.dispatchEvent(new Event('pointerlockchange'));
      },
    ],
  ];

  for (const [name, leave] of eased) {
    it(`${name} eases back to exactly the orbit value`, () => {
      if (name === 'pointer lock lost') {
        viewer.enterFlying();
        lockEl = canvas;
        document.dispatchEvent(new Event('pointerlockchange'));
        run(FOV_EASE_MS + 20);
        expect(fov()).toBe(FLY_FOV_DEG);
      } else {
        flyWide();
      }
      leave();
      expect(viewer.isFlying()).toBe(false);
      frame();
      expect(fov()).toBeLessThan(FLY_FOV_DEG);
      expect(fov()).toBeGreaterThan(ORBIT_FOV_DEG);
      run(FOV_EASE_MS + 500);
      expect(fov()).toBe(ORBIT_FOV_DEG);
      expect(projectionMatchesFov()).toBe(true);
    });
  }

  const snapped: Array<[string, () => void]> = [
    ['fitToBox (fit, model load)', () => viewer.fitToBox(box())],
    ['restoreCameraState (saved view, session)', () => viewer.restoreCameraState({ position: { x: 5, y: 5, z: 5 }, target: { x: 0, y: 0, z: 0 } })],
  ];

  for (const [name, leave] of snapped) {
    it(`${name} puts the orbit value back at once`, () => {
      flyWide();
      leave();
      expect(fov()).toBe(ORBIT_FOV_DEG);
      expect(projectionMatchesFov()).toBe(true);
      run(FOV_EASE_MS + 100);
      expect(fov()).toBe(ORBIT_FOV_DEG);
    });

    it(`${name} also ends an ease-out still running`, () => {
      flyWide();
      viewer.exitFlying();
      run(FOV_EASE_MS / 3);
      expect(fov()).toBeGreaterThan(ORBIT_FOV_DEG);
      leave();
      expect(fov()).toBe(ORBIT_FOV_DEG);
      run(FOV_EASE_MS);
      expect(fov()).toBe(ORBIT_FOV_DEG);
    });
  }

  it('leaving while still easing in turns round smoothly and ends at the orbit value', () => {
    viewer.enterFlying();
    run(FOV_EASE_MS / 2);
    const mid = fov();
    expect(mid).toBeGreaterThan(ORBIT_FOV_DEG);
    viewer.exitFlying();
    frame();
    expect(fov()).toBeLessThanOrEqual(mid);
    expect(mid - fov()).toBeLessThan(2);
    run(FOV_EASE_MS);
    expect(fov()).toBe(ORBIT_FOV_DEG);
  });

  it('G twice quickly then left alone ends at the orbit value', () => {
    viewer.toggleFlying();
    frame();
    viewer.toggleFlying();
    frame();
    viewer.toggleFlying();
    frame();
    viewer.toggleFlying();
    run(FOV_EASE_MS + 100);
    expect(viewer.isFlying()).toBe(false);
    expect(fov()).toBe(ORBIT_FOV_DEG);
    expect(projectionMatchesFov()).toBe(true);
  });

  it('a saved camera state never records the field of view', () => {
    flyWide();
    expect(Object.keys(viewer.getCameraState()).sort()).toEqual(['position', 'target']);
  });
});
