import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  computeClippingPlanes,
  computeFitPosition,
  sceneRadius,
} from '../src/viewer/cameraUtils';

describe('computeFitPosition', () => {
  it('should return null for an empty box', () => {
    const box = new THREE.Box3();
    expect(computeFitPosition(box)).toBeNull();
  });

  it('should compute center at the midpoint of the box', () => {
    const box = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 10, 10),
    );
    const result = computeFitPosition(box)!;
    expect(result.center.x).toBeCloseTo(5);
    expect(result.center.y).toBeCloseTo(5);
    expect(result.center.z).toBeCloseTo(5);
  });

  it('should place camera at a distance from the center', () => {
    const box = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 10, 10),
    );
    const result = computeFitPosition(box)!;
    const dist = result.position.distanceTo(result.center);
    // maxDim = 10, distance = 10 * 1.5 = 15
    // camera offset = (15, 15*0.7, 15) from center
    expect(dist).toBeGreaterThan(10);
  });

  it('frames the whole box between its planes', () => {
    const box = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(20, 20, 20),
    );
    const result = computeFitPosition(box)!;
    const eye = result.position.distanceTo(result.center);

    // Everything from the near corner to the far corner has to be inside.
    expect(result.near).toBeLessThan(eye - sceneRadius(box));
    expect(result.far).toBeGreaterThan(eye + sceneRadius(box));
  });

  it('agrees with computeClippingPlanes, so the fit does not fight the loop', () => {
    // The render loop recomputes the planes every frame from the live camera
    // distance. If the fit installed a different formula the view would shift
    // on the first frame after a fit.
    const box = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(20, 20, 20),
    );
    const result = computeFitPosition(box)!;
    const live = computeClippingPlanes(
      result.position.distanceTo(result.center),
      sceneRadius(box),
    );
    expect(result.near).toBeCloseTo(live.near);
    expect(result.far).toBeCloseTo(live.far);
  });

  it('should handle non-uniform boxes', () => {
    const box = new THREE.Box3(
      new THREE.Vector3(-100, 0, 0),
      new THREE.Vector3(100, 1, 1),
    );
    const result = computeFitPosition(box)!;
    // maxDim = 200 (x-axis dominates)
    expect(result.center.x).toBeCloseTo(0);
    const dist = result.position.distanceTo(result.center);
    expect(dist).toBeGreaterThan(200);
  });
});
