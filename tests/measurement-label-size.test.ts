// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as THREE from 'three';
import { LABEL_HEIGHT_PX, labelWorldHeight } from '../src/tools/labelScale';
import { MeasurementRenderer } from '../src/tools/MeasurementRenderer';
import type { MeasurementView } from '../src/tools/measurementViews';

/**
 * Issue #57: the measurement label was sized in world units, so on screen it
 * grew without limit as the camera closed in, and filled the window at
 * working distance. It is now held at one height in CSS pixels.
 */

/** Pixels a world-space height spans at `depth`, for a perspective camera. */
function pixelsSpanned(worldHeight: number, depth: number, fovDeg: number, viewportPx: number): number {
  return (worldHeight * viewportPx) / (2 * depth * Math.tan((fovDeg * Math.PI) / 360));
}

const DEPTHS = [0.001, 0.01, 0.3, 1, 5, 30, 200, 5000];
const FOVS = [20, 45, 75, 110];
const VIEWPORTS = [320, 720, 1080, 2160];

describe('label size on screen (#57)', () => {
  it('is the same height in pixels at every distance, field of view and window height', () => {
    for (const depth of DEPTHS) {
      for (const fov of FOVS) {
        for (const vh of VIEWPORTS) {
          const h = labelWorldHeight(depth, fov, vh);
          expect(pixelsSpanned(h, depth, fov, vh)).toBeCloseTo(LABEL_HEIGHT_PX, 6);
        }
      }
    }
  });

  it('is a readable height, neither a speck nor a banner', () => {
    expect(LABEL_HEIGHT_PX).toBeGreaterThanOrEqual(16);
    expect(LABEL_HEIGHT_PX).toBeLessThanOrEqual(40);
  });

  it('survives a label at or behind the camera plane without collapsing to nothing or going negative', () => {
    for (const depth of [0, -3]) {
      const h = labelWorldHeight(depth, 45, 720);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThan(0);
    }
  });
});

// ── The renderer applies it ─────────────────────────────────

const fakeContext = {
  font: '',
  fillStyle: '',
  textAlign: '',
  textBaseline: '',
  measureText: () => ({ width: 100 }),
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  quadraticCurveTo: () => {},
  closePath: () => {},
  fill: () => {},
  fillText: () => {},
};

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => fakeContext) as never);
});

afterAll(() => {
  vi.restoreAllMocks();
});

function labelOf(scene: THREE.Scene): THREE.Sprite {
  let found: THREE.Sprite | null = null;
  scene.traverse((o) => {
    if (o instanceof THREE.Sprite) found = o;
  });
  expect(found).not.toBeNull();
  return found!;
}

/** Projected height of the label in pixels, measured the way the screen would. */
function screenHeight(label: THREE.Sprite, camera: THREE.PerspectiveCamera, viewportPx: number): number {
  camera.updateMatrixWorld();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(label.scale.y / 2);
  const top = label.position.clone().add(up).project(camera);
  const bottom = label.position.clone().sub(up).project(camera);
  return (Math.abs(top.y - bottom.y) / 2) * viewportPx;
}

describe('MeasurementRenderer label size (#57)', () => {
  // Survey coordinates: the precision fix of #105 must not be disturbed.
  const START = new THREE.Vector3(512345.678, 41.25, -6654321.987);
  const END = new THREE.Vector3(512349.321, 44.75, -6654318.432);
  const mid = START.clone().lerp(END, 0.5);

  function view(): MeasurementView {
    return {
      id: 'm1',
      start: START.clone(),
      end: END.clone(),
      visible: true,
      selected: false,
      hovered: false,
      startSnap: { target: 'point' },
      endSnap: { target: 'point' },
    };
  }

  function setup(heightPx: number) {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.001, 1e5);
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientHeight', { value: heightPx });
    Object.defineProperty(canvas, 'clientWidth', { value: heightPx * (16 / 9) });
    const renderer = new MeasurementRenderer({ scene, camera, canvas });
    return { scene, camera, renderer };
  }

  it('keeps a committed label at the same pixel height from a millimetre to hundreds of metres', () => {
    for (const vh of [480, 1080]) {
      const { scene, camera, renderer } = setup(vh);
      renderer.sync([view()]);
      const label = labelOf(scene);
      for (const distance of [0.005, 0.3, 2, 40, 800]) {
        camera.position.copy(mid).add(new THREE.Vector3(0.3, 0.2, 1).normalize().multiplyScalar(distance));
        camera.lookAt(mid);
        renderer.updateScales();
        expect(screenHeight(label, camera, vh)).toBeCloseTo(LABEL_HEIGHT_PX, 1);
      }
    }
  });

  it('holds it when the camera is not looking straight at the label', () => {
    const { scene, camera, renderer } = setup(720);
    renderer.sync([view()]);
    camera.position.copy(mid).add(new THREE.Vector3(1, 1, 1));
    camera.lookAt(mid.clone().add(new THREE.Vector3(0.4, 0.1, -0.2)));
    renderer.updateScales();
    // Off-axis, perspective stretches the projection a little; the label is
    // sized by depth, so it stays close to the target rather than exact.
    expect(screenHeight(labelOf(scene), camera, 720)).toBeGreaterThan(LABEL_HEIGHT_PX * 0.9);
    expect(screenHeight(labelOf(scene), camera, 720)).toBeLessThan(LABEL_HEIGHT_PX * 1.1);
  });

  it('a preview label starts at the right size and keeps it as the camera moves', () => {
    const { scene, camera, renderer } = setup(720);
    camera.position.copy(mid).add(new THREE.Vector3(0.5, 0.2, 0.4));
    camera.lookAt(mid);
    renderer.showPreview(START, END);
    const label = labelOf(scene);
    expect(screenHeight(label, camera, 720)).toBeCloseTo(LABEL_HEIGHT_PX, 1);

    camera.position.copy(mid).add(new THREE.Vector3(0.01, 0.01, 0.01));
    camera.lookAt(mid);
    renderer.updateScales();
    expect(screenHeight(label, camera, 720)).toBeCloseTo(LABEL_HEIGHT_PX, 1);
  });

  it('keeps the label text undistorted, whatever its length', () => {
    const { scene, camera, renderer } = setup(720);
    camera.position.copy(mid).add(new THREE.Vector3(1, 1, 1));
    camera.lookAt(mid);
    renderer.sync([view()]);
    renderer.updateScales();
    const label = labelOf(scene);
    const map = label.material.map!.image as HTMLCanvasElement;
    expect(label.scale.x / label.scale.y).toBeCloseTo(map.width / map.height, 6);
  });

  it('stops resizing a label once its measurement is gone', () => {
    const { scene, renderer } = setup(720);
    renderer.sync([view()]);
    const label = labelOf(scene);
    renderer.sync([]);
    label.scale.set(7, 7, 1);
    renderer.updateScales();
    expect(label.scale.x).toBe(7);
  });
});
