/**
 * The near plane outside the model is a share of the camera's clearance from
 * the scene box. A point on screen at that distance is at least
 * `clearance * cos(θ)` deep, θ its angle off the view axis — and flying's 70°
 * view on a wide window puts the corners far enough off axis that a fixed
 * half of the clearance cut geometry there (#116).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { clearanceFraction, clippingPlanesForView, cornerCosine } from '../src/viewer/cameraUtils';

const ASPECTS: Array<[string, number]> = [
  ['4:3', 4 / 3],
  ['16:9', 16 / 9],
  ['21:9', 21 / 9],
  ['32:9', 32 / 9],
];

describe('cornerCosine', () => {
  it('matches hand-worked values', () => {
    expect(cornerCosine(45, 16 / 9)).toBeCloseTo(0.764, 3);
    expect(cornerCosine(45, 21 / 9)).toBeCloseTo(0.689, 3);
    expect(cornerCosine(70, 16 / 9)).toBeCloseTo(0.574, 3);
    expect(cornerCosine(70, 21 / 9)).toBeCloseTo(0.490, 3);
    expect(cornerCosine(70, 32 / 9)).toBeCloseTo(0.361, 3);
  });

  it('is the cosine of the angle to a real corner ray', () => {
    const fov = 70;
    const aspect = 32 / 9;
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
    camera.updateMatrixWorld(true);
    const corner = new THREE.Vector3(1, 1, 0.5).unproject(camera).normalize();
    expect(corner.dot(new THREE.Vector3(0, 0, -1))).toBeCloseTo(cornerCosine(fov, aspect), 9);
  });
});

describe('clearanceFraction', () => {
  it('is the old half with no lens, and for orbit on an ordinary window', () => {
    expect(clearanceFraction()).toBe(0.5);
    expect(clearanceFraction({ verticalFovDeg: 45, aspect: 16 / 9 })).toBe(0.5);
    expect(clearanceFraction({ verticalFovDeg: 45, aspect: 4 / 3 })).toBe(0.5);
  });

  it('a half would be too much at 70° on 21:9 and wider', () => {
    expect(cornerCosine(70, 21 / 9)).toBeLessThan(0.5);
    expect(cornerCosine(70, 32 / 9)).toBeLessThan(0.5);
  });

  for (const fov of [45, 57.5, 70]) {
    for (const [name, aspect] of ASPECTS) {
      it(`stays well inside the shallowest on-screen depth at ${fov}° ${name}`, () => {
        const f = clearanceFraction({ verticalFovDeg: fov, aspect });
        expect(f).toBeLessThanOrEqual(0.5);
        expect(f).toBeLessThanOrEqual(0.7 * cornerCosine(fov, aspect) + 1e-12);
      });
    }
  }
});

describe('near plane — geometry at the corner of a wide 70° view', () => {
  it('a box face at the clearance, seen in the corner, is no longer cut', () => {
    const fov = 70;
    const aspect = 32 / 9;
    // Box face at z = 0; the camera 10 m in front of it, outside the box.
    const scene = new THREE.Box3(new THREE.Vector3(-100, -100, -50), new THREE.Vector3(100, 100, 0));
    const position = new THREE.Vector3(0, 0, 10);
    const nearest = new THREE.Vector3(0, 0, 0); // closest point of the box, 10 m away
    const clearance = scene.distanceToPoint(position);
    expect(clearance).toBeCloseTo(10);

    // Aim so the nearest point sits exactly in a corner of the view.
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 1000);
    camera.position.copy(position);
    camera.lookAt(nearest);
    camera.updateMatrixWorld(true);
    const cornerDir = new THREE.Vector3(1, 1, 0.5).unproject(camera).sub(position).normalize();
    const toNearest = nearest.clone().sub(position).normalize();
    camera.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(cornerDir, toNearest));
    camera.updateMatrixWorld(true);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const depth = nearest.clone().sub(position).dot(forward);
    expect(depth).toBeCloseTo(clearance * cornerCosine(fov, aspect), 6);

    // The old fixed half of the clearance would have cut it...
    expect(depth).toBeLessThan(clearance * 0.5);
    // ...the lens-aware near plane does not.
    const { near } = clippingPlanesForView({ position, hitDistance: null, scene, lens: { verticalFovDeg: fov, aspect } });
    expect(near).toBeLessThan(depth);
    const ndc = nearest.clone().project(camera);
    expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1 + 1e-6);
    expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1 + 1e-6);
  });
});
