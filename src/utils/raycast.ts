import * as THREE from 'three';

/**
 * Raycast into the scene and return only hits on visible geometry
 * (respects active clipping planes, skips helper objects).
 */
export function raycastVisible(
  mouse: THREE.Vector2,
  camera: THREE.Camera,
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
): THREE.Intersection | null {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);

  const meshes: THREE.Mesh[] = [];
  scene.traverse((obj) => {
    if (
      obj instanceof THREE.Mesh &&
      !obj.userData.isClipHelper &&
      !obj.userData.isPivotMarker &&
      !obj.userData.isMeasurement
    ) {
      meshes.push(obj);
    }
  });

  const intersects = raycaster.intersectObjects(meshes, false);
  const clippingPlanes = renderer.clippingPlanes;

  return (
    intersects.find((hit) => {
      if (!hit.face) return false;
      return clippingPlanes.every(
        (plane) => plane.distanceToPoint(hit.point) >= 0,
      );
    }) ?? null
  );
}
