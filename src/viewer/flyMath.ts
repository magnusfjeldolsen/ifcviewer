import * as THREE from 'three';

/**
 * Pure maths for flying through the model (#98). `FlyController` holds the
 * state and `Viewer` owns the camera; everything that can be tested without
 * either lives here, the same split as `orbitMath.ts`.
 *
 * Units: the scene is in metres (web-ifc converts every model to metres when
 * it builds geometry), so a speed here is metres per second of model.
 */

/** Cruising speed on entering flying for the first time, m/s. */
export const DEFAULT_FLY_SPEED = 5;
/** Slowest cruising speed the wheel or the speed keys can set, m/s. */
export const MIN_FLY_SPEED = 0.5;
/** Fastest cruising speed the wheel or the speed keys can set, m/s. */
export const MAX_FLY_SPEED = 50;
/** One speed step at and above 1 m/s. */
const COARSE_STEP = 1;
/** One speed step below 1 m/s, so a slow walk is reachable. */
const FINE_STEP = 0.25;

/** Held Shift multiplies movement speed by this. Turning is not boosted. */
export const BOOST_FACTOR = 4;
/** Held Space multiplies movement and turning speed by this. */
export const PRECISE_FACTOR = 0.25;

/** Turning rate for the arrow keys, radians per second (90°/s). */
export const TURN_RATE = Math.PI / 2;

/**
 * Time constant of the ease, seconds. Velocity closes 1 − e^(−dt/τ) of the gap
 * to its target per step, so it is 95 % there after 3τ = 120 ms whatever the
 * frame rate.
 */
export const EASE_TAU = 0.04;

/**
 * How close to straight up or down the view may pitch, radians (~1°). At the
 * pole forward is parallel to up and `lookAt` loses its roll reference.
 */
export const PITCH_MARGIN = 0.0175;

/**
 * Next cruising speed after one step up (`direction` > 0) or down (< 0).
 *
 * Linear, not a factor: 1 m/s per step from 1 m/s up, 0.25 m/s per step
 * below, so every speed the steps visit is a tidy number — 0.5, 0.75, 1, 2,
 * 3 … 50. A speed between those (there should not be one) snaps onto the grid
 * in the direction asked.
 */
export function stepFlySpeed(speed: number, direction: number): number {
  if (direction === 0) return clampSpeed(speed);
  let next: number;
  if (direction > 0) {
    next = speed < 1 - 1e-9 ? snapUp(speed, FINE_STEP) : snapUp(speed, COARSE_STEP);
  } else {
    next = speed > 1 + 1e-9 ? snapDown(speed, COARSE_STEP) : snapDown(speed, FINE_STEP);
  }
  return clampSpeed(next);
}

/** The next multiple of `step` strictly above `value`. */
function snapUp(value: number, step: number): number {
  return (Math.floor(value / step + 1e-9) + 1) * step;
}

/** The next multiple of `step` strictly below `value`. */
function snapDown(value: number, step: number): number {
  return (Math.ceil(value / step - 1e-9) - 1) * step;
}

export function clampSpeed(speed: number): number {
  return Math.min(Math.max(speed, MIN_FLY_SPEED), MAX_FLY_SPEED);
}

/** What the held keys ask for, each component −1, 0 or 1. */
export interface FlyInput {
  /** +1 forward (W), −1 back (S). */
  forward: number;
  /** +1 right (D), −1 left (A). */
  right: number;
  /** +1 up (E), −1 down (Q). */
  up: number;
  /** +1 turn left (←), −1 turn right (→). Positive is anticlockwise seen from above. */
  yaw: number;
  /** +1 look up (↑), −1 look down (↓). */
  pitch: number;
  boost: boolean;
  precise: boolean;
}

/**
 * Speed multiplier for movement under the held modifiers. Both held cancel
 * towards a gentle boost (4 × 0.25 = 1): neither wins outright, which is the
 * least surprising answer to a combination nobody means.
 */
export function moveFactor(input: Pick<FlyInput, 'boost' | 'precise'>): number {
  return (input.boost ? BOOST_FACTOR : 1) * (input.precise ? PRECISE_FACTOR : 1);
}

/** Turning multiplier: Space slows it for precision, Shift does not speed it up. */
export function turnFactor(input: Pick<FlyInput, 'precise'>): number {
  return input.precise ? PRECISE_FACTOR : 1;
}

/**
 * Move `current` toward `target` by an exponential ease over `dt` seconds.
 * Frame-rate independent: two steps of dt/2 land where one step of dt does.
 */
export function easeToward(current: number, target: number, dt: number, tau = EASE_TAU): number {
  if (dt <= 0) return current;
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}

/**
 * Distance covered over `dt` seconds while velocity eases from `current`
 * toward `target` — the exact integral of `easeToward`, so the distance
 * travelled does not depend on how the time is cut into frames.
 */
export function easedDistance(current: number, target: number, dt: number, tau = EASE_TAU): number {
  if (dt <= 0) return 0;
  return target * dt + (current - target) * tau * (1 - Math.exp(-dt / tau));
}

/**
 * The view's yaw/pitch frame: `horizontal` is the unit forward direction
 * flattened onto the ground plane, `pitch` the angle above it.
 */
export function pitchOf(forward: THREE.Vector3, up: THREE.Vector3): number {
  const f = forward.dot(up) / (forward.length() || 1);
  return Math.asin(Math.min(Math.max(f, -1), 1));
}

/**
 * Turn a forward direction by `yaw` about `up` and tilt it by `pitch`,
 * clamping the result just short of straight up or down. There is never roll:
 * the camera is aimed with `lookAt`, which keeps its right vector horizontal.
 *
 * Writes into `out` (which may be `forward`) and returns it — called every
 * frame while turning, so it allocates nothing.
 */
export function turnForward(
  forward: THREE.Vector3,
  up: THREE.Vector3,
  yaw: number,
  pitch: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const currentPitch = pitchOf(forward, up);
  const limit = Math.PI / 2 - PITCH_MARGIN;
  const nextPitch = Math.min(Math.max(currentPitch + pitch, -limit), limit);

  // Horizontal heading: forward with its up component removed.
  scratchH.copy(forward).addScaledVector(up, -forward.dot(up));
  if (scratchH.lengthSq() < 1e-12) {
    // Looking straight up or down (only reachable from outside flying):
    // there is no heading, so pick one perpendicular to up.
    scratchH.set(1, 0, 0).addScaledVector(up, -up.x);
    if (scratchH.lengthSq() < 1e-12) scratchH.set(0, 0, 1).addScaledVector(up, -up.z);
  }
  scratchH.normalize();
  if (yaw !== 0) scratchH.applyAxisAngle(up, yaw);

  return out
    .copy(scratchH)
    .multiplyScalar(Math.cos(nextPitch))
    .addScaledVector(up, Math.sin(nextPitch));
}

const scratchH = new THREE.Vector3();

/**
 * World displacement for a velocity given in the view's frame: `forward`
 * along the view direction (pitch included — W flies where you look), `right`
 * horizontal, `up` along the model's up axis whatever the tilt.
 *
 * Writes into `out` and returns it.
 */
export function worldDisplacement(
  forward: THREE.Vector3,
  up: THREE.Vector3,
  local: { forward: number; right: number; up: number },
  out: THREE.Vector3,
): THREE.Vector3 {
  // right = forward × up, flattened by construction; degenerate only at the pole.
  scratchR.crossVectors(forward, up);
  if (scratchR.lengthSq() > 1e-12) scratchR.normalize();
  else scratchR.set(0, 0, 0);
  return out
    .copy(forward)
    .normalize()
    .multiplyScalar(local.forward)
    .addScaledVector(scratchR, local.right)
    .addScaledVector(up, local.up);
}

const scratchR = new THREE.Vector3();

/**
 * Radians of look per pixel dragged: dragging the full height of the view
 * turns half a turn. Mouse look is driven by pointer deltas, never by time,
 * so it is frame-rate independent by construction.
 */
export function lookRadiansPerPixel(viewHeightPx: number): number {
  return Math.PI / Math.max(viewHeightPx, 1);
}

/**
 * How far in front of the camera to put the view anchor when flying ends.
 *
 * The anchor must be on the forward axis (so OrbitControls' `lookAt` is a
 * no-op and the view cannot jump); only its distance is free. Use what is
 * straight ahead when there is something, otherwise a few metres — close
 * enough that an orbit over empty space turns about something near you, not
 * about the far side of the site.
 */
export function exitAnchorDistance(hitDistance: number | null): number {
  if (hitDistance !== null && Number.isFinite(hitDistance) && hitDistance > 0) {
    return Math.min(Math.max(hitDistance, 0.05), 1000);
  }
  return EXIT_ANCHOR_FALLBACK;
}

/** Anchor distance when nothing is straight ahead, metres. */
export const EXIT_ANCHOR_FALLBACK = 10;
