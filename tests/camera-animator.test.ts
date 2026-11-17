// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { CameraAnimator, easeOutCubic, type FlyToParams } from '../src/viewer/CameraAnimator';

describe('CameraAnimator', () => {
  describe('easeOutCubic', () => {
    it('should return 0 at t=0', () => {
      expect(easeOutCubic(0)).toBe(0);
    });

    it('should return 1 at t=1', () => {
      expect(easeOutCubic(1)).toBe(1);
    });

    it('should be monotonically increasing', () => {
      let prev = 0;
      for (let t = 0.1; t <= 1; t += 0.1) {
        const val = easeOutCubic(t);
        expect(val).toBeGreaterThan(prev);
        prev = val;
      }
    });

    it('should decelerate (second half changes less than first half)', () => {
      const firstHalf = easeOutCubic(0.5) - easeOutCubic(0);
      const secondHalf = easeOutCubic(1) - easeOutCubic(0.5);
      expect(firstHalf).toBeGreaterThan(secondHalf);
    });

    it('should return 0.5 at midpoint (approx 0.875)', () => {
      // ease-out cubic at t=0.5: 1 - (0.5)^3 = 0.875
      expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
    });
  });
});

/**
 * `cancel()` is how a gesture that claims the pointer first (grabbing the
 * section handle) stops a fly-to: the animator's own pointerdown listener
 * never sees that press. The viewer restores `_controlsMode = 'user'` in
 * `onInterrupt`, so cancel must run it — or OrbitControls stays frozen.
 */
describe('CameraAnimator.cancel', () => {
  it('stops a flight in progress through the interrupt path, not the completion path', async () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(0, 0, 10);
    const controls = { target: new THREE.Vector3(), update: () => {} } as unknown as FlyToParams['controls'];
    const onInterrupt = vi.fn();
    const onComplete = vi.fn();
    const animator = new CameraAnimator();
    const flight = animator.flyTo({
      camera,
      controls,
      canvas: document.createElement('canvas'),
      targetPosition: new THREE.Vector3(100, 0, 0),
      targetLookAt: new THREE.Vector3(),
      near: 0.1,
      far: 100,
      durationMs: 10_000,
      onInterrupt,
      onComplete,
    });
    expect(animator.isAnimating()).toBe(true);

    animator.cancel();
    await flight;
    const stoppedAt = camera.position.clone();
    await new Promise((r) => setTimeout(r, 50));

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(animator.isAnimating()).toBe(false);
    expect(camera.position.distanceTo(stoppedAt)).toBe(0);
  });

  it('is a no-op with nothing in flight', () => {
    expect(() => new CameraAnimator().cancel()).not.toThrow();
  });
});

/**
 * The animation's clock. It used to subtract `performance.now()` at the start
 * from the rAF timestamp; in jsdom the two clocks have different origins (the
 * rAF one starts ~1 s later), so elapsed time stayed negative for that long —
 * and past the 5 s test timeout when the suite ran under load.
 */
describe('CameraAnimator clock', () => {
  it('finishes on time whatever clock the rAF timestamp comes from', async () => {
    const realRaf = globalThis.requestAnimationFrame;
    // A frame clock 60 s behind performance.now().
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now() - 60_000), 16) as unknown as number) as typeof requestAnimationFrame;
    try {
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
      const controls = { target: new THREE.Vector3(), update: () => {} } as unknown as FlyToParams['controls'];
      const onComplete = vi.fn();
      const started = performance.now();
      await new CameraAnimator().flyTo({
        camera,
        controls,
        canvas: document.createElement('canvas'),
        targetPosition: new THREE.Vector3(5, 5, 5),
        targetLookAt: new THREE.Vector3(),
        near: 0.1,
        far: 100,
        durationMs: 30,
        onComplete,
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(camera.position.distanceTo(new THREE.Vector3(5, 5, 5))).toBeLessThan(1e-9);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
  }, 2000);
});
