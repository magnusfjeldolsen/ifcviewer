import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeFitPosition } from '../src/viewer/cameraUtils';

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

  it('should set near/far proportional to distance', () => {
    const box = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(20, 20, 20),
    );
    const result = computeFitPosition(box)!;
    // maxDim = 20, distance = 30
    expect(result.near).toBeCloseTo(0.3); // 30 * 0.01
    expect(result.far).toBeCloseTo(3000); // 30 * 100
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
