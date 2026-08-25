import * as THREE from 'three';

export interface FitResult {
  position: THREE.Vector3;
  center: THREE.Vector3;
  near: number;
  far: number;
}

export interface ClippingPlanes {
  near: number;
  far: number;
}

/**
 * Fraction of the viewing distance used as the near plane.
 *
 * Small enough that the plane never eats what you are looking at, large enough
 * that far/near stays modest at normal viewing distances.
 */
const NEAR_FRACTION = 0.002;

/**
 * Absolute floor on the near plane, in metres (the scene is in metres). 2 mm,
 * so a millimetre-scale feature can be approached closely enough to be worth
 * measuring — the dolly guard stops the camera at `near * 2`.
 */
const MIN_NEAR = 0.002;

/** How many scene radii beyond the camera the far plane sits. */
const FAR_SCENE_RADII = 4;

/**
 * Hard ceiling on far/near, which is what actually governs depth precision.
 *
 * The depth buffer is 24-bit (measured, not assumed), and z-fighting starts to
 * show past a ratio of roughly a million. Capping at 200 000 leaves better
 * than two orders of magnitude of headroom, and — crucially — it holds no
 * matter how large the model is: on a 2 km site the cap raises the near plane
 * to a few centimetres rather than letting the ratio run away.
 */
const MAX_DEPTH_RATIO = 200_000;

/**
 * Near and far planes for a camera `distance` from what it is looking at, in a
 * scene of the given radius.
 *
 * Recomputed as the camera moves rather than fixed at the last fit. A fixed
 * near plane has to be chosen for the whole-model view and then blocks every
 * close-up: on the Snowdon fixture it sat at 1.13 m, and the dolly guard
 * (`near * MIN_FOCUS_NEAR_PLANES`) refused to bring the camera closer than
 * 2.26 m to any surface — measured, and 300 further wheel notches moved it
 * 0.000 m. At that range one millimetre is under a pixel, which is why a
 * millimetre reading could be displayed but never earned.
 *
 * Deriving it from the live distance instead means the near plane shrinks as
 * you approach, so the guard asymptotes towards the surface rather than
 * stopping short of it, while far/near stays bounded by construction.
 *
 * `focusDistance` is how far the nearest thing worth seeing is — normally the
 * geometry under the cursor. `viewDistance` is how far the view anchor is, and
 * sizes the far plane; it defaults to `focusDistance` for callers that have
 * only one distance to offer.
 */
export function computeClippingPlanes(
  focusDistance: number,
  sceneRadius: number,
  viewDistance: number = focusDistance,
): ClippingPlanes {
  const focus = Math.max(focusDistance, 0);
  // The far plane follows the view anchor, not the focus: backing the camera
  // up to a wall must not clip away the rest of the model behind it.
  const view = Math.max(viewDistance, focus, 0);
  const safeRadius = Math.max(sceneRadius, MIN_NEAR);

  const far = view + safeRadius * FAR_SCENE_RADII;

  // The ratio cap is applied against THIS far, so the guarantee holds however
  // far apart the two distances drift.
  const near = Math.max(focus * NEAR_FRACTION, MIN_NEAR, far / MAX_DEPTH_RATIO);

  return { near, far };
}

/**
 * Compute the camera position and clipping planes needed to frame a bounding box.
 * Pure function — no side effects on camera or controls.
 */
export function computeFitPosition(box: THREE.Box3): FitResult | null {
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

  // The camera sits further from the centre than `distance`: the offset is
  // applied on all three axes. Use the real separation so the planes the fit
  // installs match the ones the render loop recomputes a frame later.
  const eyeDistance = position.distanceTo(center);
  const { near, far } = computeClippingPlanes(eyeDistance, sceneRadius(box));

  return { position, center, near, far };
}

/** Radius of the sphere enclosing `box` — the scale the far plane follows. */
export function sceneRadius(box: THREE.Box3): number {
  if (box.isEmpty()) return 1;
  return box.getSize(new THREE.Vector3()).length() / 2;
}
