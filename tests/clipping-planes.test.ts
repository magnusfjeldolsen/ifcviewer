/**
 * `clippingPlanesForView` — the near/far planes the render loop recomputes
 * from the live camera on every drawn frame.
 *
 * Three properties pull against each other, and each has a user-visible
 * failure mode:
 *
 *   1. Nothing in view may be cut. Far must clear the back of the model from
 *      anywhere (#87: sizing it from the view anchor cut the model as soon as
 *      you zoomed out), and near must clear whatever is in front of the camera
 *      — whatever the cursor is over. Near used to follow the view anchor when
 *      the cursor was over empty space; after close-up work a click on the sky
 *      put it at 0.35 m and cut a slab 0.28 m away.
 *   2. The near plane must shrink as the camera approaches, or close-up work
 *      is impossible. Measured on the Snowdon fixture before the planes became
 *      dynamic: near sat at 1.13 m, the dolly guard (`near * 2`) stopped the
 *      camera 2.26 m from every surface, and 300 further wheel notches moved
 *      it 0.000 m.
 *   3. far/near must stay bounded, or the 24-bit depth buffer z-fights.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  clippingPlanesForView,
  computeFitPosition,
  maxViewDistance,
  sceneRadius,
  type ClippingView,
} from '../src/viewer/cameraUtils';

const MAX_RATIO = 200_000;

/** The Snowdon fixture as the running app reports it: georeferenced, far from the origin. */
const CENTRE = new THREE.Vector3(417615.6, 242.0, -78697.6);
const HALF = new THREE.Vector3(61, 35, 75).multiplyScalar(0.5);
const SNOWDON = new THREE.Box3(CENTRE.clone().sub(HALF), CENTRE.clone().add(HALF));
const R = sceneRadius(SNOWDON);

function planes(position: THREE.Vector3, hitDistance: number | null, scene = SNOWDON, extra: Partial<ClippingView> = {}) {
  return clippingPlanesForView({ position, hitDistance, scene, ...extra });
}

/** A camera `distance` from the scene centre, on the side `dir` points to. */
function cameraAt(dir: THREE.Vector3, distance: number, centre = CENTRE): THREE.Vector3 {
  return centre.clone().addScaledVector(dir.clone().normalize(), distance);
}

/** Every corner of `box`, the points farthest from anything outside it. */
function corners(box: THREE.Box3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) out.push(new THREE.Vector3(x, y, z));
    }
  }
  return out;
}

const DIRS = [
  new THREE.Vector3(1, 0.7, 1),
  new THREE.Vector3(-1, 0.2, 0.3),
  new THREE.Vector3(0, 1, 0.001),
  new THREE.Vector3(0.2, -1, 0.5),
  new THREE.Vector3(-0.5, 0.1, -1),
];

describe('clippingPlanesForView — far', () => {
  it('reproduces #87: zoomed out with the anchor left behind, the back of the model stays inside far', () => {
    // Measured: after Fit and nine notches out the camera was 381 m from the
    // centre and the planes were near 0.357 / far 384.8 — 47.8 m of model cut.
    const position = cameraAt(new THREE.Vector3(1, 0.7, 1), 381);
    const { far } = planes(position, null);
    for (const c of corners(SNOWDON)) expect(far).toBeGreaterThan(position.distanceTo(c));
  });

  it('clears every corner of the model from anywhere, inside or out', () => {
    for (const dir of DIRS) {
      for (const distance of [0, 10, 60, 178, 381, 1000, 5000]) {
        const position = cameraAt(dir, distance);
        for (const hit of [null, 0.005, distance]) {
          const { far } = planes(position, hit);
          for (const c of corners(SNOWDON)) expect(far).toBeGreaterThan(position.distanceTo(c));
        }
      }
    }
  });

  it('puts far just past the far side of the scene, not radii of empty space beyond it', () => {
    // Depth range spent behind the model is depth precision lost in front.
    const { far } = planes(cameraAt(DIRS[0], 176), null);
    expect(far).toBeLessThan(176 + 1.1 * R);
  });

  it('ignores the cursor', () => {
    const position = cameraAt(DIRS[0], 381);
    const fars = [null, 0.01, 10, 2000].map((hit) => planes(position, hit).far);
    for (const far of fars) expect(far).toBeCloseTo(fars[0]);
  });

  it('grows with the scene, not with one historical fit', () => {
    const small = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(5, 5, 5));
    const large = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(500, 500, 500));
    const position = new THREE.Vector3(10, 0, 0);
    expect(planes(position, null, large).far).toBeGreaterThan(planes(position, null, small).far);
  });
});

describe('clippingPlanesForView — near', () => {
  /**
   * The reviewer's reproduction: wheel-zoom into a slab edge, click the slab,
   * click the sky. The click on the sky made the raycast miss, near fell back
   * to the view anchor 178 m ahead, and became 0.353 m, cutting the slab
   * 0.28 m away.
   */
  it('does not cut nearby geometry when the cursor moves to empty space', () => {
    // Just outside a face, and just inside the box.
    const outside = new THREE.Vector3(SNOWDON.max.x + 0.28, CENTRE.y, CENTRE.z);
    const inside = new THREE.Vector3(SNOWDON.max.x - 0.5, CENTRE.y, CENTRE.z);
    for (const position of [outside, inside]) {
      const onSlab = planes(position, 0.28).near;
      const onSky = planes(position, null).near;
      // Anything 0.28 m away and on screen is at least 0.28 · cos(40°) deep.
      expect(onSky).toBeLessThan(0.28 * Math.cos((40 * Math.PI) / 180));
      expect(onSlab).toBeLessThan(0.28 * Math.cos((40 * Math.PI) / 180));
    }
  });

  it('keeps near inside the clearance, wherever the cursor is', () => {
    // Nothing loaded is closer than the distance to its box, and on screen a
    // point that far away is at least ~0.7 of it deep. Swept over positions
    // inside and outside, and over hits from millimetres to beyond the model.
    for (const dir of DIRS) {
      for (const distance of [0, 10, 30, 52, 60, 178, 381, 1000]) {
        const position = cameraAt(dir, distance);
        const clearance = SNOWDON.distanceToPoint(position);
        for (const hit of [null, 0.005, 1, clearance, distance + R, 1e6]) {
          const { near } = planes(position, hit);
          if (clearance > 0.1) expect(near).toBeLessThanOrEqual(clearance * 0.5 + 1e-9);
          else expect(near).toBeLessThanOrEqual(0.002 + 1e-12);
        }
      }
    }
  });

  it('drops to its floor inside the model, so the camera can be millimetres from anything', () => {
    const position = cameraAt(DIRS[1], 10);
    expect(planes(position, null).near).toBeCloseTo(0.002, 9);
    expect(planes(position, 50).near).toBeCloseTo(0.002, 9);
    expect(planes(position, 0.005).near * 2).toBeLessThanOrEqual(0.005);
  });

  it('lets the dolly guard reach a facade from outside', () => {
    // 1 cm off the face, cursor on it: the guard (`near * 2`) must not stop
    // the camera short of it.
    const position = new THREE.Vector3(SNOWDON.max.x + 0.01, CENTRE.y, CENTRE.z);
    expect(planes(position, 0.01).near * 2).toBeLessThan(0.01);
    // Further out, the clearance alone would park the guard at the face.
    const farther = new THREE.Vector3(SNOWDON.max.x + 10, CENTRE.y, CENTRE.z);
    expect(planes(farther, 10).near * 2).toBeLessThan(0.1);
  });

  it('shrinks as the camera closes in', () => {
    const far = planes(cameraAt(DIRS[0], 176), 120).near;
    const close = planes(new THREE.Vector3(SNOWDON.max.x + 1, CENTRE.y, CENTRE.z), 1).near;
    expect(close).toBeLessThan(far);
  });

  it('spends little depth range on a view of the whole model', () => {
    // A small near on a far view is what brings z-fighting back.
    const position = cameraAt(DIRS[0], 176);
    const overSky = planes(position, null);
    expect(overSky.far / overSky.near).toBeLessThan(10);
    const overModel = planes(position, 150);
    expect(overModel.far / overModel.near).toBeLessThan(1000);
  });

  it('keeps out of the ground grid as well as the model', () => {
    // A small model, the camera low over the grid beside it.
    const model = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 3, 2));
    const grid = new THREE.Box3(new THREE.Vector3(-25, 0, -25), new THREE.Vector3(25, 0, 25));
    const position = new THREE.Vector3(20, 1.5, 0);
    const { near } = planes(position, null, model, { clearOf: [grid] });
    expect(near).toBeLessThanOrEqual(1.5 * 0.5 + 1e-9);
  });

  it('ignores a grid far from a georeferenced model', () => {
    const grid = new THREE.Box3(new THREE.Vector3(-25, 0, -25), new THREE.Vector3(25, 0, 25));
    const position = cameraAt(DIRS[0], 176);
    expect(planes(position, null, SNOWDON, { clearOf: [grid] }).near).toBeCloseTo(planes(position, null).near);
  });
});

describe('clippingPlanesForView — depth precision', () => {
  it('never lets far/near exceed the cap, from a bolt to a city', () => {
    for (const size of [0.05, 1, 10, 100, 1000, 4000, 100_000]) {
      const box = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(size, size, size));
      for (const distance of [0, 0.001, 1, 100, 10_000, 1_000_000]) {
        for (const hit of [null, 0, 0.001, 1, 1000]) {
          const { near, far } = planes(new THREE.Vector3(distance, 0, 0), hit, box);
          expect(far / near).toBeLessThanOrEqual(MAX_RATIO);
        }
      }
    }
  });

  it('raises near on a huge model rather than letting the ratio run', () => {
    // A 4 km site cannot also have a 2 mm near plane on a 24-bit buffer.
    const site = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(4000, 50, 4000));
    const { near, far } = planes(new THREE.Vector3(10, 10, 10), 1, site);
    expect(near).toBeGreaterThan(0.002);
    expect(far / near).toBeLessThanOrEqual(MAX_RATIO);
  });

  it('keeps near strictly positive and below far, even for degenerate scenes', () => {
    const scenes = [
      new THREE.Box3(),
      new THREE.Box3(new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 1)),
      SNOWDON,
    ];
    for (const scene of scenes) {
      for (const hit of [null, -1, 0, 5000]) {
        const { near, far } = planes(new THREE.Vector3(3, 4, 5), hit, scene);
        expect(near).toBeGreaterThan(0);
        expect(far).toBeGreaterThan(near);
        expect(Number.isFinite(near)).toBe(true);
        expect(Number.isFinite(far)).toBe(true);
      }
    }
  });
});

describe('computeFitPosition planes', () => {
  it('installs what the render loop computes a frame later, so the two do not fight', () => {
    const fit = computeFitPosition(SNOWDON)!;
    const live = planes(fit.position, null);
    expect(fit.near).toBeCloseTo(live.near);
    expect(fit.far).toBeCloseTo(live.far);
  });
});

describe('maxViewDistance', () => {
  it('lets the camera back well away from the fit distance', () => {
    // Fit puts the camera about 3.5 radii out.
    expect(maxViewDistance(R)).toBeGreaterThan(10 * R);
  });

  it('scales with the scene', () => {
    expect(maxViewDistance(500)).toBeGreaterThan(maxViewDistance(5));
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
