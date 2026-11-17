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

/**
 * Slack on the far plane beyond the farthest point the scene can reach, as a
 * fraction of that distance — enough that geometry exactly on the bounding
 * sphere is not lost to rounding, small enough to waste no depth range.
 */
const FAR_SLACK = 0.02;

/**
 * How far the camera may back away from what it is zooming at, in scene
 * radii. Fit View sits about 3.5 radii out, so this leaves the model a small
 * but recognisable shape on screen.
 */
const MAX_VIEW_RADII = 20;

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
 * geometry under the cursor — and sizes the near plane. `centreDistance` is
 * how far the centre of the scene's bounding sphere is, and sizes the far
 * plane: nothing in the scene can be farther than `centreDistance +
 * sceneRadius`, whatever the camera is looking at. It defaults to
 * `focusDistance` for callers looking at the centre.
 *
 * The far plane must come from the scene and never from the view anchor
 * (`controls.target`). The anchor is a point on the camera's forward axis that
 * dolly and orbit carry along with the camera, so its distance stays put while
 * the model recedes; sizing far from it cut the back off the model as soon as
 * you zoomed out (#87).
 */
export function computeClippingPlanes(
  focusDistance: number,
  sceneRadius: number,
  centreDistance: number = focusDistance,
): ClippingPlanes {
  const focus = Math.max(focusDistance, 0);
  const safeRadius = Math.max(sceneRadius, MIN_NEAR);

  // The farthest point of the scene, plus a sliver. Backing the camera up to
  // a wall must not clip away the model behind it, and neither must zooming
  // out with the view anchor left behind.
  const far = (Math.max(centreDistance, 0) + safeRadius) * (1 + FAR_SLACK);

  // The ratio cap is applied against THIS far, so the guarantee holds however
  // far apart the two distances drift. One short of the cap, so rounding in
  // the division can never land the ratio a hair above it.
  const near = Math.max(focus * NEAR_FRACTION, MIN_NEAR, far / (MAX_DEPTH_RATIO - 1));

  return { near, far };
}

/** What the clipping planes are computed from, read off the live view. */
export interface ClippingView {
  /** Camera position. */
  position: THREE.Vector3;
  /** The view anchor (`controls.target`), a point on the forward axis. */
  anchor: THREE.Vector3;
  /** Distance to the geometry last found under the cursor; null if none. */
  hitDistance: number | null;
  /** Bounds of everything loaded, hidden or not. */
  scene: THREE.Sphere;
}

/**
 * Near and far planes for the live view.
 *
 * Near follows the nearer of the cursor hit and the anchor: whatever is under
 * the cursor is what the user is about to run into, and the anchor covers the
 * case where they are pointing at empty space. Erring small only spends depth
 * precision, and `computeClippingPlanes` caps how much it can spend. Far
 * follows the scene alone, so where the anchor happens to sit can never cut
 * the model.
 */
export function clippingPlanesForView(view: ClippingView): ClippingPlanes {
  const toAnchor = view.position.distanceTo(view.anchor);
  const focus = Math.min(toAnchor, view.hitDistance ?? Infinity);
  const toCentre = view.position.distanceTo(view.scene.center);
  return computeClippingPlanes(focus, view.scene.radius, toCentre);
}

/** How far the camera may back away from what it zooms at, for a scene of this radius. */
export function maxViewDistance(sceneRadius: number): number {
  return Math.max(sceneRadius, MIN_NEAR) * MAX_VIEW_RADII;
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

/** The sphere enclosing `box`, centred on it; null for an empty box. */
export function sceneSphere(box: THREE.Box3): THREE.Sphere | null {
  if (box.isEmpty()) return null;
  return new THREE.Sphere(box.getCenter(new THREE.Vector3()), sceneRadius(box));
}
