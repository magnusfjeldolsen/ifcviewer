import * as THREE from 'three';

/**
 * Pure camera math for orbiting and dollying about an arbitrary point.
 *
 * `Viewer` needs a WebGL context and so has no unit tests; the maths lives
 * here instead, the same split as `computeFitPosition` in `cameraUtils.ts`.
 *
 * ## The two points
 *
 * `OrbitControls.target` is overloaded: it is both the orbit centre and the
 * point `update()` makes the camera look at every frame. Storing a pivot
 * there is what made placing a pivot re-centre the view.
 *
 * So we keep them apart:
 *
 * - **target** — a *view anchor*, always on the camera's forward axis. Keeping
 *   it there makes `camera.lookAt(target)` a permanent no-op, which is what
 *   stops OrbitControls from ever re-orienting the camera behind our back.
 * - **pivot** — the rotation centre, anywhere in space.
 *
 * Every function here moves camera and anchor by the *same rigid transform*,
 * which is precisely what keeps the anchor on the forward axis.
 */

/** Camera position plus its view anchor. */
export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/**
 * How close to straight-up/straight-down the view may get, in radians.
 * At the pole the forward vector is parallel to up and `lookAt` loses its roll
 * reference, which reads to the user as the view flipping over.
 */
export const POLAR_EPSILON = 0.000001;

export interface RotateAboutPivotParams {
  position: THREE.Vector3;
  /** The view anchor — assumed to be on the camera's forward axis. */
  target: THREE.Vector3;
  /** Rotation centre. May be anywhere, including off the view axis. */
  pivot: THREE.Vector3;
  /** Rotation about the up axis, radians. Right-handed. */
  azimuth: number;
  /**
   * Rotation in the vertical plane, radians. Positive increases the angle
   * between up and the camera's backward vector — i.e. it lowers the camera.
   */
  polar: number;
  up: THREE.Vector3;
}

/**
 * Rotate the camera *and* its view anchor about `pivot` by the same rotation.
 *
 * Because both points get the identical rigid rotation, the anchor is still on
 * the camera's forward axis at the same distance afterwards — so there is
 * nothing left for `lookAt` to correct, and no snap. The user keeps their exact
 * framing while orbiting about the point they pointed at.
 */
export function rotateAboutPivot(params: RotateAboutPivotParams): CameraPose {
  const { position, target, pivot, azimuth, up } = params;

  const upAxis = up.clone().normalize();
  // The camera's *backward* vector, matching three's spherical convention
  // where phi is measured from the up axis to this vector.
  const back = position.clone().sub(target);
  const phi = back.lengthSq() > 0 ? back.clone().normalize().angleTo(upAxis) : Math.PI / 2;

  // Clamp the destination rather than the delta, so a drag that would sail
  // past the pole stops at it instead of being thrown away wholesale.
  const clampedPhi = clamp(phi + params.polar, POLAR_EPSILON, Math.PI - POLAR_EPSILON);
  const polar = clampedPhi - phi;

  const rotation = new THREE.Quaternion().setFromAxisAngle(upAxis, azimuth);

  // Rotating by +polar about normalize(cross(up, back)) increases phi by
  // exactly that amount. The cross product collapses when the camera looks
  // straight up or down; there is no meaningful vertical rotation to apply in
  // that pose, so azimuth carries the gesture alone rather than emitting NaN.
  const polarAxis = new THREE.Vector3().crossVectors(upAxis, back);
  if (polar !== 0 && polarAxis.lengthSq() > 1e-12) {
    polarAxis.normalize();
    rotation.multiply(new THREE.Quaternion().setFromAxisAngle(polarAxis, polar));
  }

  return {
    position: rotateAround(position, pivot, rotation),
    target: rotateAround(target, pivot, rotation),
  };
}

export interface PivotCandidates {
  /** Surface point under the cursor, if the ray hit anything. */
  hit: THREE.Vector3 | null;
  /** Centre of the current selection, if there is one. */
  selection: THREE.Vector3 | null;
  /** Whether that selection centre is currently within the view frustum. */
  selectionOnScreen: boolean;
  /** The pivot the user placed with the pivot tool, if any. */
  placed: THREE.Vector3 | null;
  /** Whether that placed pivot is currently within the view frustum. */
  placedOnScreen: boolean;
  /** Last resort — the centre of the last fit. */
  fallback: THREE.Vector3;
}

export interface ResolvedPivot {
  point: THREE.Vector3;
  /**
   * True for a cursor pivot, which lasts one gesture only. The pivot the user
   * placed deliberately is never overwritten by an orbit.
   */
  transient: boolean;
}

/**
 * Pick the rotation / zoom centre for one gesture.
 *
 * Whatever is under the cursor wins. Over empty space there is no answer to
 * "how far away did you mean" — ArcGIS Pro puts it well: *"You cannot click the
 * sky to navigate because the tool cannot determine how far away you want to
 * go."* So we fall back, most recently expressed intent first:
 *
 * 1. the centre of the selection — what Revit and Navisworks offer as "centre
 *    pivot on selection". It outranks the placed pivot deliberately: selecting
 *    elements is the fresher statement of "this is what I am working on", and
 *    a pivot dropped earlier in the session should not override it;
 * 2. the pivot they placed by hand;
 * 3. the centre of the last fit.
 *
 * Both 1 and 2 are skipped while off screen — a centre that has drifted out of
 * view makes orbit feel like it is turning about nothing, which is why
 * Navisworks releases its pivot lock in the same situation. Neither is
 * forgotten: each applies again as soon as it is back in view.
 */
export function resolvePivot(candidates: PivotCandidates): ResolvedPivot {
  const { hit, selection, selectionOnScreen, placed, placedOnScreen, fallback } = candidates;
  if (hit) return { point: hit.clone(), transient: true };
  if (selection && selectionOnScreen) return { point: selection.clone(), transient: false };
  if (placed && placedOnScreen) return { point: placed.clone(), transient: false };
  return { point: fallback.clone(), transient: false };
}

export interface DollyTowardPointParams {
  position: THREE.Vector3;
  /** The view anchor — carried along so it stays on the forward axis. */
  target: THREE.Vector3;
  /** What the cursor is over: the raycast hit, or the fallback pivot. */
  focus: THREE.Vector3;
  /** Multiplier on the distance to `focus`. Below 1 moves closer. */
  scale: number;
  /** Never end up nearer than this to `focus` — the near-plane guard. */
  minDistance: number;
  /** Optional ceiling so zooming out cannot run away to infinity. */
  maxDistance?: number;
}

/**
 * Dolly the camera along the line through `focus`, scaling its distance to
 * that point **geometrically**.
 *
 * Geometric, not proportional-to-remaining-distance: the latter is Blender's
 * documented "viewport wall", where the steps shrink until movement stops
 * entirely and the user is stranded short of the surface they were aiming at.
 * Multiplying the distance decelerates in absolute terms — it reads as braking
 * as you approach — while still closing a fixed fraction of the *actual*
 * remaining gap on every notch, so it can never stall.
 *
 * Moving along the camera→focus line leaves the direction to `focus`
 * unchanged, so the point stays under the same pixel: zoom-to-cursor falls out
 * of the geometry. The anchor is translated by the same delta, which leaves
 * the view direction untouched.
 */
export function dollyTowardPoint(params: DollyTowardPointParams): CameraPose {
  const { position, target, focus, scale, minDistance, maxDistance } = params;

  const offset = position.clone().sub(focus);
  const distance = offset.length();
  // Focus sitting exactly on the camera gives no direction to move along.
  if (distance < 1e-9) {
    return { position: position.clone(), target: target.clone() };
  }

  const ceiling = maxDistance ?? Number.POSITIVE_INFINITY;
  const next = clamp(distance * scale, minDistance, ceiling);
  const delta = offset.multiplyScalar(next / distance - 1);

  return {
    position: position.clone().add(delta),
    target: target.clone().add(delta),
  };
}

/**
 * Place the view anchor `distance` in front of the camera along its current
 * forward direction.
 *
 * The anchor's job is to make `lookAt` a no-op, so only its *distance* is ever
 * a free choice. Pan and zoom use this to keep that distance matched to
 * whatever the cursor is over, which is what keeps OrbitControls' pan speed
 * (which scales with the target's depth) in step with the model.
 */
export function anchorInFront(
  position: THREE.Vector3,
  target: THREE.Vector3,
  distance: number,
): THREE.Vector3 {
  const forward = target.clone().sub(position);
  if (forward.lengthSq() < 1e-12) return target.clone();
  return position.clone().addScaledVector(forward.normalize(), Math.max(distance, 1e-6));
}

function rotateAround(
  point: THREE.Vector3,
  pivot: THREE.Vector3,
  rotation: THREE.Quaternion,
): THREE.Vector3 {
  return point.clone().sub(pivot).applyQuaternion(rotation).add(pivot);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
