/**
 * `computeClippingPlanes` — the near/far planes the render loop recomputes
 * from the live camera distance.
 *
 * Two properties, pulling against each other, and both have a user-visible
 * failure mode:
 *
 *   1. The near plane must shrink as the camera approaches, or close-up work
 *      is impossible. Measured on the Snowdon fixture before this change: the
 *      near plane sat at 1.13 m, the dolly guard (`near * 2`) stopped the
 *      camera 2.26 m from every surface, and 300 further wheel notches moved
 *      it 0.000 m. At that range a millimetre is under a pixel.
 *   2. far/near must stay bounded, or the 24-bit depth buffer z-fights. That
 *      is what rules out simply shrinking the old constant: reaching a 2 mm
 *      near plane with the old 11 307 m far plane would have meant a ratio of
 *      5.6 million.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeClippingPlanes, sceneRadius } from '../src/viewer/cameraUtils';

/** The measured bounds of the tracked Snowdon fixture, near enough. */
const SNOWDON_RADIUS = sceneRadius(
  new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(61, 35, 75)),
);

describe('computeClippingPlanes', () => {
  it('shrinks the near plane as the camera closes in', () => {
    const far = computeClippingPlanes(176, SNOWDON_RADIUS);
    const near = computeClippingPlanes(1, SNOWDON_RADIUS);
    expect(near.near).toBeLessThan(far.near);
  });

  it('lets the camera reach millimetre range', () => {
    // The dolly guard stops at near * 2, so this is the closest approach.
    const planes = computeClippingPlanes(0.01, SNOWDON_RADIUS);
    expect(planes.near * 2).toBeLessThan(0.01);
  });

  it('beats the old fixed plane even at the whole-model view', () => {
    // The old formula gave 1.13 m at the Snowdon fit distance.
    const planes = computeClippingPlanes(176, SNOWDON_RADIUS);
    expect(planes.near).toBeLessThan(1.13);
  });

  it('never lets far/near exceed the depth-precision cap', () => {
    // The guarantee that makes this safe to put in the render loop. Swept
    // across viewing distances and model scales, from a bolt to a city.
    for (const radius of [0.05, 1, 10, SNOWDON_RADIUS, 500, 2000, 50_000]) {
      for (const distance of [0, 0.001, 0.01, 1, 100, 10_000, 1_000_000]) {
        const { near, far } = computeClippingPlanes(distance, radius);
        expect(far / near).toBeLessThanOrEqual(200_000);
      }
    }
  });

  it('keeps near strictly positive and below far, always', () => {
    for (const radius of [0, -5, 0.001, 1000]) {
      for (const distance of [0, -1, 0.5, 5000]) {
        const { near, far } = computeClippingPlanes(distance, radius);
        expect(near).toBeGreaterThan(0);
        expect(far).toBeGreaterThan(near);
        expect(Number.isFinite(near)).toBe(true);
        expect(Number.isFinite(far)).toBe(true);
      }
    }
  });

  it('keeps the whole scene inside the far plane from any distance', () => {
    // Backing away must never clip the model's far side out of the view.
    for (const distance of [0, 10, 176, 5000]) {
      const { far } = computeClippingPlanes(distance, SNOWDON_RADIUS);
      expect(far).toBeGreaterThan(distance + SNOWDON_RADIUS);
    }
  });

  it('raises the near plane on a huge model rather than letting the ratio run', () => {
    // A 2 km site cannot also have a 2 mm near plane on a 24-bit buffer. The
    // cap gives up closeness at that scale, which is the right trade — nobody
    // measures millimetres and kilometres in the same breath.
    const planes = computeClippingPlanes(1, 2000);
    expect(planes.near).toBeGreaterThan(0.002);
    expect(planes.far / planes.near).toBeLessThanOrEqual(200_000);
  });

  it('sizes near from the focus and far from the view anchor', () => {
    // The two come apart exactly where it matters: dollying at a wall moves
    // camera and view anchor together, so the anchor stays far away while the
    // wall is centimetres off. Near must follow the wall; far must still clear
    // the model behind it.
    const planes = computeClippingPlanes(0.05, SNOWDON_RADIUS, 176);
    const anchorOnly = computeClippingPlanes(176, SNOWDON_RADIUS);

    expect(planes.near).toBeLessThan(anchorOnly.near);
    expect(planes.far).toBeCloseTo(anchorOnly.far);
  });

  it('holds the depth cap even when focus and view are far apart', () => {
    // The case the split introduces, and the one a naive two-call version got
    // wrong: a tiny near taken from the focus against a far taken from a
    // distant anchor.
    for (const view of [1, 100, 10_000, 1_000_000]) {
      for (const focus of [0, 0.001, 0.05, 5]) {
        const { near, far } = computeClippingPlanes(focus, SNOWDON_RADIUS, view);
        expect(far / near).toBeLessThanOrEqual(200_000);
        expect(near).toBeGreaterThan(0);
      }
    }
  });

  it('ignores a view anchor nearer than the focus', () => {
    const { far } = computeClippingPlanes(50, SNOWDON_RADIUS, 1);
    expect(far).toBeGreaterThan(50);
  });

  it('grows the far plane with the scene, not with one historical fit', () => {
    const small = computeClippingPlanes(10, 5);
    const large = computeClippingPlanes(10, 500);
    expect(large.far).toBeGreaterThan(small.far);
  });
});

describe('sceneRadius', () => {
  it('is the half-diagonal of the box', () => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0));
    expect(sceneRadius(box)).toBeCloseTo(1);
  });

  it('falls back to 1 for an empty box, so nothing divides by zero', () => {
    expect(sceneRadius(new THREE.Box3())).toBe(1);
  });
});
