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
import {
  clippingPlanesForView,
  computeClippingPlanes,
  maxViewDistance,
  sceneRadius,
} from '../src/viewer/cameraUtils';

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

  it('sizes near from the focus and far from the scene centre', () => {
    // The two come apart exactly where it matters: zoomed in at a wall, the
    // wall is centimetres off while the far side of the model is 100 m away.
    // Near must follow the wall; far must still clear the model behind it.
    const planes = computeClippingPlanes(0.05, SNOWDON_RADIUS, 176);
    const centreOnly = computeClippingPlanes(176, SNOWDON_RADIUS);

    expect(planes.near).toBeLessThan(centreOnly.near);
    expect(planes.far).toBeCloseTo(centreOnly.far);
    expect(planes.far).toBeGreaterThan(176 + SNOWDON_RADIUS);
  });

  it('holds the depth cap even when focus and scene centre are far apart', () => {
    // A tiny near taken from the focus against a far taken from a distant
    // scene: the ratio cap has to be applied against the far actually used.
    for (const centre of [1, 100, 10_000, 1_000_000]) {
      for (const focus of [0, 0.001, 0.05, 5]) {
        const { near, far } = computeClippingPlanes(focus, SNOWDON_RADIUS, centre);
        expect(far / near).toBeLessThanOrEqual(200_000);
        expect(near).toBeGreaterThan(0);
      }
    }
  });

  it('puts far just past the far side of the scene, not radii of empty space beyond it', () => {
    // Depth range spent behind the model is depth precision lost in front.
    const { far } = computeClippingPlanes(176, SNOWDON_RADIUS, 176);
    expect(far).toBeGreaterThan(176 + SNOWDON_RADIUS);
    expect(far).toBeLessThan(176 + 1.1 * SNOWDON_RADIUS);
  });

  it('does not push far out for a focus beyond the scene', () => {
    // The focus can be the view anchor, which is not geometry.
    const { far } = computeClippingPlanes(2000, SNOWDON_RADIUS, 176);
    expect(far).toBeLessThan(176 + 1.1 * SNOWDON_RADIUS);
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

/**
 * `clippingPlanesForView` — what the render loop actually feeds in, from the
 * live camera. Issue #87: the far plane used to be sized from the distance to
 * the view anchor, a point on the camera's forward axis that dolly and orbit
 * carry along with the camera. Zooming out left the anchor — and so the far
 * plane — where it was while the model receded, and the far plane sliced
 * through the model.
 */
describe('clippingPlanesForView', () => {
  /** The Snowdon fixture as the running app reports it (bounding sphere). */
  const R = 51.6;
  const CENTRE = new THREE.Vector3(417615.6, 242.0, -78697.6);
  const scene = new THREE.Sphere(CENTRE.clone(), R);

  /** A camera `distance` from the scene centre, on the side `dir` points to. */
  function cameraAt(dir: THREE.Vector3, distance: number): THREE.Vector3 {
    return CENTRE.clone().addScaledVector(dir.clone().normalize(), distance);
  }

  /** The view anchor: a point `distance` in front of the camera, towards `lookAt`. */
  function anchorAhead(position: THREE.Vector3, lookAt: THREE.Vector3, distance: number): THREE.Vector3 {
    const forward = lookAt.clone().sub(position).normalize();
    return position.clone().addScaledVector(forward, distance);
  }

  it('reproduces #87: Fit View, zoom out, and the far side of the model stays inside far', () => {
    // Measured in the running app: after Fit the anchor is 178.4 m out. Nine
    // wheel notches out with the cursor on the model move camera and anchor
    // together, so the anchor is still 178.4 m out while the camera is 381 m
    // from the centre. The planes were near 0.357 / far 384.8 against a model
    // spanning 329.4..432.6 m: 47.8 m of the model cut away.
    const position = cameraAt(new THREE.Vector3(1, 0.7, 1), 381);
    const anchor = anchorAhead(position, CENTRE, 178.4);
    const { near, far } = clippingPlanesForView({ position, anchor, hitDistance: null, scene });

    expect(far).toBeGreaterThan(381 + R);
    expect(near).toBeLessThan(381 - R);
  });

  it('keeps the whole scene between near and far at any distance, orbit angle and anchor depth', () => {
    // Orbit carries the anchor rigidly with the camera and pan re-derives its
    // depth from whatever is under the cursor, so its distance says nothing
    // about where the model is. Sweep all of them independently.
    const dirs = [
      new THREE.Vector3(1, 0.7, 1),
      new THREE.Vector3(-1, 0.2, 0.3),
      new THREE.Vector3(0, 1, 0.001),
      new THREE.Vector3(0.2, -1, 0.5),
      new THREE.Vector3(-0.5, 0.1, -1),
    ];
    // The anchor need not point at the centre: aim it off to one side.
    const lookAt = CENTRE.clone().add(new THREE.Vector3(R * 0.8, 0, 0));
    for (const dir of dirs) {
      for (const distance of [60, 178, 381, 1000, 5000]) {
        const position = cameraAt(dir, distance);
        for (const anchorDistance of [0.5, 10, 178.4, 2000]) {
          const anchor = anchorAhead(position, lookAt, anchorDistance);
          for (const hitDistance of [null, distance - R, distance]) {
            const { near, far } = clippingPlanesForView({ position, anchor, hitDistance, scene });
            expect(far).toBeGreaterThan(distance + R);
            expect(near).toBeLessThan(distance - R);
            expect(far / near).toBeLessThanOrEqual(200_000);
          }
        }
      }
    }
  });

  it('still lets the camera get millimetre-close to what is under the cursor', () => {
    // Inside the model, 5 mm from a wall, the anchor left far away by the dolly.
    const position = cameraAt(new THREE.Vector3(1, 0, 0), 10);
    const anchor = anchorAhead(position, CENTRE, 178.4);
    const { near } = clippingPlanesForView({ position, anchor, hitDistance: 0.005, scene });
    expect(near * 2).toBeLessThanOrEqual(0.005);
  });

  it('sizes far from camera and scene alone, whatever the anchor does', () => {
    const position = cameraAt(new THREE.Vector3(1, 0.7, 1), 381);
    const fars = [0.5, 10, 178.4, 2000].map(
      (d) =>
        clippingPlanesForView({
          position,
          anchor: anchorAhead(position, CENTRE, d),
          hitDistance: null,
          scene,
        }).far,
    );
    for (const far of fars) expect(far).toBeCloseTo(fars[0]);
  });
});

describe('maxViewDistance', () => {
  it('lets the camera back well away from the fit distance', () => {
    // Fit puts the camera about 3.5 radii out. Zoom-out used to stop at the
    // far plane, about twice that, purely as a side effect of #87.
    expect(maxViewDistance(SNOWDON_RADIUS)).toBeGreaterThan(10 * SNOWDON_RADIUS);
  });

  it('scales with the scene', () => {
    expect(maxViewDistance(500)).toBeGreaterThan(maxViewDistance(5));
  });
});
