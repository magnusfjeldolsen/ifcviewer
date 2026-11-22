import * as THREE from 'three';
import {
  DEFAULT_FLY_SPEED,
  TURN_RATE,
  clampSpeed,
  easeToward,
  easedDistance,
  lookRadiansPerPixel,
  moveFactor,
  stepFlySpeed,
  turnFactor,
  turnForward,
  worldDisplacement,
} from './flyMath';

/**
 * The keys flying listens to, by `KeyboardEvent.code` — the physical key, so
 * W A S D sit under the left hand on AZERTY and Dvorak keyboards too.
 */
export const FLY_KEY_CODES: ReadonlySet<string> = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'Space',
  'KeyZ', 'KeyX',
]);

/** Keys that change the cruising speed by one step each press. */
const SPEED_UP_CODE = 'KeyX';
const SPEED_DOWN_CODE = 'KeyZ';

/** Held keys that ask for motion; the modifiers alone do not. */
const DRIVE_CODES = [
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
] as const;

/** Below this, an eased velocity or turn rate is treated as stopped. */
const REST = 1e-4;

/**
 * Flying state: which keys are held, the eased velocity and turn rate, and the
 * cruising speed. Knows nothing of the DOM or the render loop — `Viewer` feeds
 * it key codes, pointer deltas and frame times and asks it to move a camera.
 *
 * Nothing here allocates per frame.
 */
export class FlyController {
  private held = new Set<string>();
  private speed = DEFAULT_FLY_SPEED;

  /** Eased velocity in the view's frame, metres per second. */
  private vel = { forward: 0, right: 0, up: 0 };
  /** Eased turn rate, radians per second. */
  private turn = { yaw: 0, pitch: 0 };
  /** This frame's distances in the view's frame, metres (reused). */
  private dist = { forward: 0, right: 0, up: 0 };

  private speedListeners: Array<(speed: number) => void> = [];

  private readonly forward = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  /** Cruising speed, metres per second, before Shift / Space. */
  getSpeed(): number {
    return this.speed;
  }

  setSpeed(speed: number): void {
    const next = clampSpeed(speed);
    if (next === this.speed) return;
    this.speed = next;
    for (const cb of this.speedListeners) cb(next);
  }

  /** One step faster (`direction` > 0) or slower (< 0). */
  stepSpeed(direction: number): void {
    this.setSpeed(stepFlySpeed(this.speed, direction));
  }

  onSpeedChange(cb: (speed: number) => void): () => void {
    this.speedListeners.push(cb);
    return () => {
      this.speedListeners = this.speedListeners.filter((l) => l !== cb);
    };
  }

  /**
   * A fly key went down. Returns true when it is one of ours. Repeats from a
   * held key are harmless for movement keys; the speed keys step once per
   * press, not per auto-repeat, so holding X does not race to 50 m/s.
   */
  keyDown(code: string, repeat = false): boolean {
    if (!FLY_KEY_CODES.has(code)) return false;
    if (code === SPEED_UP_CODE || code === SPEED_DOWN_CODE) {
      if (!repeat) this.stepSpeed(code === SPEED_UP_CODE ? 1 : -1);
      return true;
    }
    this.held.add(code);
    return true;
  }

  keyUp(code: string): boolean {
    if (!FLY_KEY_CODES.has(code)) return false;
    this.held.delete(code);
    return true;
  }

  /** Let go of every key, e.g. on window blur or leaving the mode. */
  releaseAll(): void {
    this.held.clear();
  }

  /** Drop all motion at once — leaving the mode should not coast. */
  stop(): void {
    this.held.clear();
    this.vel.forward = this.vel.right = this.vel.up = 0;
    this.turn.yaw = this.turn.pitch = 0;
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  /** True while any key is held or motion is still easing out. */
  isMoving(): boolean {
    if (this.held.size > 0 && this.hasDrive()) return true;
    return (
      Math.abs(this.vel.forward) > REST ||
      Math.abs(this.vel.right) > REST ||
      Math.abs(this.vel.up) > REST ||
      Math.abs(this.turn.yaw) > REST ||
      Math.abs(this.turn.pitch) > REST
    );
  }

  /** Speed actually in effect right now, Shift / Space included. */
  effectiveSpeed(): number {
    return this.speed * moveFactor(this.modifiers());
  }

  /**
   * Turn the camera by a pointer drag of (dx, dy) pixels in a view `height`
   * pixels tall. Drag right turns right, drag up looks up.
   */
  look(camera: THREE.PerspectiveCamera, dx: number, dy: number, height: number): void {
    const k = lookRadiansPerPixel(height);
    camera.getWorldDirection(this.forward);
    turnForward(this.forward, camera.up, this.rightOf(camera), -dx * k, -dy * k, this.forward);
    this.aim(camera);
  }

  /**
   * Advance one frame of `dt` seconds: ease toward what the keys ask for,
   * then move and turn the camera. Returns true when the camera moved.
   */
  tick(camera: THREE.PerspectiveCamera, dt: number): boolean {
    if (dt <= 0) return false;
    // A long stall (tab in the background, a GC pause) should not fling the
    // camera across the site on the next frame.
    const step = Math.min(dt, 0.1);
    const h = this.held;
    const mods = this.modifiers();
    const move = this.speed * moveFactor(mods);
    const rate = TURN_RATE * turnFactor(mods);

    const wantF = (h.has('KeyW') ? 1 : 0) - (h.has('KeyS') ? 1 : 0);
    const wantR = (h.has('KeyD') ? 1 : 0) - (h.has('KeyA') ? 1 : 0);
    const wantU = (h.has('KeyE') ? 1 : 0) - (h.has('KeyQ') ? 1 : 0);
    const wantYaw = (h.has('ArrowLeft') ? 1 : 0) - (h.has('ArrowRight') ? 1 : 0);
    const wantPitch = (h.has('ArrowUp') ? 1 : 0) - (h.has('ArrowDown') ? 1 : 0);

    // Distances are the exact integral of the eased velocity over the step,
    // so how the time is cut into frames does not change how far you go.
    const v = this.vel;
    const d = this.dist;
    d.forward = easedDistance(v.forward, wantF * move, step);
    d.right = easedDistance(v.right, wantR * move, step);
    d.up = easedDistance(v.up, wantU * move, step);
    v.forward = settle(easeToward(v.forward, wantF * move, step), wantF);
    v.right = settle(easeToward(v.right, wantR * move, step), wantR);
    v.up = settle(easeToward(v.up, wantU * move, step), wantU);
    const t = this.turn;
    const yaw = easedDistance(t.yaw, wantYaw * rate, step);
    const pitch = easedDistance(t.pitch, wantPitch * rate, step);
    t.yaw = settle(easeToward(t.yaw, wantYaw * rate, step), wantYaw);
    t.pitch = settle(easeToward(t.pitch, wantPitch * rate, step), wantPitch);

    let moved = false;
    if (yaw !== 0 || pitch !== 0) {
      camera.getWorldDirection(this.forward);
      turnForward(this.forward, camera.up, this.rightOf(camera), yaw, pitch, this.forward);
      this.aim(camera);
      moved = true;
    }
    if (d.forward !== 0 || d.right !== 0 || d.up !== 0) {
      camera.getWorldDirection(this.forward);
      worldDisplacement(this.forward, camera.up, d, this.delta);
      camera.position.add(this.delta);
      camera.updateMatrixWorld();
      moved = true;
    }
    return moved;
  }

  /** Held modifiers, written into one reused object (called per frame). */
  private modifiers(): { boost: boolean; precise: boolean } {
    this.mods.boost = this.held.has('ShiftLeft') || this.held.has('ShiftRight');
    this.mods.precise = this.held.has('Space');
    return this.mods;
  }

  private readonly mods = { boost: false, precise: false };

  /** Whether any held key asks for motion (modifiers alone do not). */
  private hasDrive(): boolean {
    for (let i = 0; i < DRIVE_CODES.length; i++) {
      if (this.held.has(DRIVE_CODES[i])) return true;
    }
    return false;
  }

  /** The camera's right vector in world space, which keeps the heading even looking straight down. */
  private rightOf(camera: THREE.PerspectiveCamera): THREE.Vector3 {
    return this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  }

  /** Point the camera along `this.forward` with no roll. */
  private aim(camera: THREE.PerspectiveCamera): void {
    this.delta.copy(camera.position).add(this.forward);
    camera.lookAt(this.delta);
    camera.updateMatrixWorld();
  }
}

/** Snap an easing-out value to zero once it is negligible and nothing drives it. */
function settle(value: number, want: number): number {
  return want === 0 && Math.abs(value) < REST ? 0 : value;
}
