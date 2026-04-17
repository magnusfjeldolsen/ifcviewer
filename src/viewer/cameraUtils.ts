import * as THREE from 'three';

export interface FitResult {
  position: THREE.Vector3;
  center: THREE.Vector3;
  near: number;
  far: number;
}

/**
 * Compute the camera position and clipping planes needed to frame a bounding box.
 * Pure function — no side effects on camera or controls.
 */
export function computeFitPosition(box: THREE.Box3, fovDeg: number): FitResult | null {
  if (box.isEmpty()) return null;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const distance = maxDim * 1.5;

  const position = new THREE.Vector3(
    center.x + distance,
    center.y + distance * 0.7,
    center.z + distance,
  );

  return {
    position,
    center,
    near: distance * 0.01,
    far: distance * 100,
  };
}
