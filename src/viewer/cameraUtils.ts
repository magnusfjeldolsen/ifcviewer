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
 * Fraction of the distance to the geometry under the cursor that the near
 * plane may take.
 *
 * Small enough that the plane never eats what you are looking at, large enough
 * that far/near stays modest at normal viewing distances.
 */
const NEAR_FRACTION = 0.002;

/**
 * Fraction of the camera's clearance from the scene (see `clippingPlanesForView`)
 * that the near plane may take. Nothing loaded is closer than the clearance,
 * and an on-screen point that far away is at least `clearance * cos(θ)` deep,
 * θ being its angle off the view axis: 0.76 at the corner of a 45° 16:9 view,
 * 0.69 on a 21:9 one. A half leaves room for both.
 */
const CLEARANCE_FRACTION = 0.5;

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
 * How far the camera may back away from the scene, in scene radii. Fit View
 * sits about 3.5 radii out, so this leaves the model a small but recognisable
 * shape on screen.
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
 * Near and far planes from a wanted near distance and the far plane.
 *
 * The near plane is never below `MIN_NEAR`, and never so small that far/near
 * passes the depth-precision cap. The cap is applied against THIS far, so the
 * guarantee holds however far apart the two drift; one short of the cap, so
 * rounding in the division can never land the ratio a hair above it.
 */
function boundedPlanes(wantedNear: number, far: number): ClippingPlanes {
  const near = Math.max(wantedNear, MIN_NEAR, far / (MAX_DEPTH_RATIO - 1));
  return { near, far };
}

/**
 * Far plane for a camera `centreDistance` from the centre of a scene of radius
 * `sceneRadius`: the farthest point the scene can reach, plus a sliver.
 *
 * Far must come from the scene and never from the view anchor
 * (`controls.target`). The anchor is a point on the camera's forward axis that
 * dolly and orbit carry along with the camera, so its distance stays put while
 * the model recedes; sizing far from it cut the back off the model as soon as
 * you zoomed out (#87).
 */
function farPlane(centreDistance: number, sceneRadius: number): number {
  return (Math.max(centreDistance, 0) + Math.max(sceneRadius, MIN_NEAR)) * (1 + FAR_SLACK);
}

/** What the clipping planes are computed from, read off the live view. */
export interface ClippingView {
  /** Camera position. */
  position: THREE.Vector3;
  /**
   * Distance to the geometry under the cursor, from the last raycast; null
   * when it was over empty space.
   */
  hitDistance: number | null;
  /**
   * Everything the planes must keep: all of the loaded model, hidden parts
   * included, and anything drawn outside it that has to stay visible.
   */
  scene: THREE.Box3;
  /**
   * Further things the near plane must not cut, but which do not size the far
   * plane: the ground grid, which can lie far from a georeferenced model.
   */
  clearOf?: readonly THREE.Box3[];
}

/**
 * Near and far planes for the live view.
 *
 * Far follows the scene alone: nothing in it is farther than the distance to
 * the centre of its bounding sphere plus its radius, whatever the camera is
 * looking at.
 *
 * Near follows the camera's *clearance*: its distance to the scene's bounding
 * box, which nothing loaded can be closer than. Outside the model that keeps
 * near well clear of everything, with plenty of depth precision for a view of
 * the whole model. As the camera closes in, the clearance shrinks with it, and
 * inside the box it is zero, so near drops to its floor there — the camera can
 * be millimetres from anything without a cut.
 *
 * The geometry under the cursor can only make near *smaller*, never larger.
 * Near used to follow the nearer of the cursor hit and the view anchor, and
 * the anchor rides along ~178 m ahead of the camera after a Fit; so after
 * close-up work, a click on empty sky put near back at 0.35 m and cut the slab
 * 0.28 m in front of the camera. Nothing in view can be cut now merely because
 * the cursor moved. The hit still matters outside the model: it lets the dolly
 * guard (`near * 2`) approach the surface under the cursor rather than
 * stalling at the clearance.
 *
 * Inside the box the floor is what bounds depth precision: far/near stays
 * under `MAX_DEPTH_RATIO`.
 */
export function clippingPlanesForView(view: ClippingView): ClippingPlanes {
  const { position, scene } = view;
  const sphere = scene.isEmpty() ? null : scene.getBoundingSphere(scratchSphere);
  const far = sphere ? farPlane(position.distanceTo(sphere.center), sphere.radius) : farPlane(0, 1);

  let clearance = scene.isEmpty() ? Infinity : scene.distanceToPoint(position);
  for (const box of view.clearOf ?? []) {
    if (!box.isEmpty()) clearance = Math.min(clearance, box.distanceToPoint(position));
  }
  const fromClearance = Number.isFinite(clearance) ? clearance * CLEARANCE_FRACTION : 0;
  const fromHit = view.hitDistance === null ? Infinity : Math.max(view.hitDistance, 0) * NEAR_FRACTION;

  return boundedPlanes(Math.min(fromClearance, fromHit), far);
}

const scratchSphere = new THREE.Sphere();

/** How far the camera may back away from the centre of a scene of this radius. */
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

  // The same planes the render loop recomputes a frame later, so the fit
  // and the loop never disagree.
  const { near, far } = clippingPlanesForView({ position, hitDistance: null, scene: box });

  return { position, center, near, far };
}

/** Radius of the sphere enclosing `box` — the scale the far plane follows. */
export function sceneRadius(box: THREE.Box3): number {
  if (box.isEmpty()) return 1;
  return box.getSize(new THREE.Vector3()).length() / 2;
}
