// @vitest-environment jsdom
/**
 * Markers that hold a constant size on screen must hold it when flying widens
 * the view (#116). Scaled by distance alone they shrank to about 59 % at 70°,
 * while the measurement labels beside them (which already read the field of
 * view) stayed 24 px.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { fovSizeFactor, labelWorldHeight, markerScale, MARKER_TUNED_FOV_DEG } from '../src/tools/labelScale';

let mockHit: THREE.Intersection | null = null;
vi.mock('../src/utils/raycast', () => ({
  raycastVisible: () => mockHit,
}));

const { ClippingTool } = await import('../src/tools/ClippingTool');

describe('fovSizeFactor / markerScale', () => {
  it('is exactly 1 at the tuned field of view, so nothing changes in orbit', () => {
    expect(MARKER_TUNED_FOV_DEG).toBe(45);
    expect(fovSizeFactor(45)).toBe(1);
    expect(markerScale(12.5, 0.006, 45)).toBe(12.5 * 0.006);
  });

  it('grows by tan(fov/2) / tan(22.5°): about 1.69 at 70°', () => {
    expect(fovSizeFactor(70)).toBeCloseTo(Math.tan((35 * Math.PI) / 180) / Math.tan((22.5 * Math.PI) / 180), 12);
    expect(fovSizeFactor(70)).toBeCloseTo(1.690, 3);
    expect(fovSizeFactor(30)).toBeLessThan(1);
  });

  it('keeps a marker in a fixed ratio to a label at every field of view', () => {
    // Both are sized at the same distance on the view axis, where depth = distance.
    const ratio = (fov: number) => markerScale(10, 0.006, fov) / labelWorldHeight(10, fov, 800);
    expect(ratio(70)).toBeCloseTo(ratio(45), 12);
    expect(ratio(57)).toBeCloseTo(ratio(45), 12);
  });
});

function makeRenderer(): THREE.WebGLRenderer {
  return { clippingPlanes: [] as THREE.Plane[], localClippingEnabled: false } as unknown as THREE.WebGLRenderer;
}

/** A hit on a unit cube at the origin, facing the camera on +z. */
function syntheticHit(): THREE.Intersection {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld(true);
  return {
    distance: 5,
    point: new THREE.Vector3(0, 0, 0),
    object: mesh,
    face: { a: 0, b: 1, c: 2, normal: new THREE.Vector3(0, 0, 1), materialIndex: 0 },
  } as THREE.Intersection;
}

/** Pixel radius of the section handle's unit ring, as drawn, on a 600 px tall view. */
function handleRadiusPx(fov: number): number {
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 600, height: 600, right: 600, bottom: 600, x: 0, y: 0 }) as DOMRect;
  document.body.appendChild(canvas);
  const tool = new ClippingTool({ renderer: makeRenderer(), scene: new THREE.Scene(), camera, canvas });
  tool.enterPlacingMode();
  mockHit = syntheticHit();
  canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  mockHit = null;
  expect(tool.hasClipPlane()).toBe(true);
  tool.update();
  // `expandViewBounds` reaches twice the handle's scale (an arrow of length 2).
  const box = new THREE.Box3();
  tool.expandViewBounds(box);
  const handle = box.getCenter(new THREE.Vector3());
  const scale = (box.max.x - handle.x) / 2;
  const centre = handle.clone().project(camera);
  const edge = handle.clone().add(new THREE.Vector3(0, scale, 0)).project(camera);
  tool.dispose();
  canvas.remove();
  return ((edge.y - centre.y) / 2) * 600;
}

describe('section handle — size on screen across fields of view', () => {
  it('is unchanged at 45°: distance × 0.03, projected', () => {
    const scale = 5 * 0.03;
    const expected = (scale / (2 * 5 * Math.tan(Math.PI / 8))) * 600;
    expect(handleRadiusPx(45)).toBeCloseTo(expected, 6);
  });

  it('covers the same pixels at 70° and part-way through the ease', () => {
    const at45 = handleRadiusPx(45);
    expect(handleRadiusPx(70)).toBeCloseTo(at45, 6);
    expect(handleRadiusPx(57.3)).toBeCloseTo(at45, 6);
  });
});
