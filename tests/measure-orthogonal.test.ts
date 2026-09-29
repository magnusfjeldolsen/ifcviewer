import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  footOnPlane,
  measurePointToPlane,
  measurePlaneToPlane,
  planeAngleDeg,
  PARALLEL_TOLERANCE_DEG,
} from '../src/tools/measureMath';

const groundPlane = {
  point: new THREE.Vector3(0, 0, 0),
  normal: new THREE.Vector3(0, 1, 0),
};

/** A plane through `point` whose normal is tilted `deg` off vertical. */
function tilted(deg: number, y = 0) {
  const rad = (deg * Math.PI) / 180;
  return {
    point: new THREE.Vector3(0, y, 0),
    normal: new THREE.Vector3(Math.sin(rad), Math.cos(rad), 0).normalize(),
  };
}

describe('planeAngleDeg', () => {
  it('is zero for identical normals', () => {
    expect(planeAngleDeg(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0))).toBeCloseTo(0, 6);
  });

  // Two walls facing each other across a corridor are parallel, but their
  // outward normals point in opposite directions. Reporting 180 here would
  // refuse the single most common two-surface measurement there is.
  it('is zero for opposed normals, because the planes are still parallel', () => {
    expect(planeAngleDeg(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0))).toBeCloseTo(0, 6);
  });

  it('is 90 for perpendicular planes', () => {
    expect(planeAngleDeg(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0))).toBeCloseTo(90, 6);
  });

  it('measures a small tilt', () => {
    expect(planeAngleDeg(groundPlane.normal, tilted(7).normal)).toBeCloseTo(7, 4);
  });
});

describe('footOnPlane', () => {
  it('drops a point straight onto the plane', () => {
    const foot = footOnPlane(new THREE.Vector3(0, 3, 0), groundPlane);

    expect(foot.x).toBeCloseTo(0, 6);
    expect(foot.y).toBeCloseTo(0, 6);
    expect(foot.z).toBeCloseTo(0, 6);
  });

  it('keeps the point in place along the plane', () => {
    const foot = footOnPlane(new THREE.Vector3(2, 3, 5), groundPlane);

    expect(foot.x).toBeCloseTo(2, 6);
    expect(foot.y).toBeCloseTo(0, 6);
    expect(foot.z).toBeCloseTo(5, 6);
  });

  // A column standing past the end of a wall still has a distance to that
  // wall's line. The plane is infinite; the patch we snapped to is not.
  it('projects onto the infinite plane, not the patch that produced it', () => {
    const wall = { point: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(1, 0, 0) };

    const foot = footOnPlane(new THREE.Vector3(4, 0, 900), wall);

    expect(foot.x).toBeCloseTo(0, 6);
    expect(foot.z).toBeCloseTo(900, 6);
  });
});

describe('measurePointToPlane', () => {
  it('measures along the normal', () => {
    const result = measurePointToPlane(new THREE.Vector3(2, 3, 5), groundPlane);

    expect(result.distance).toBeCloseTo(3, 6);
    expect(result.from.y).toBeCloseTo(3, 6);
    expect(result.to.y).toBeCloseTo(0, 6);
  });

  it('reports a positive distance from either side of the plane', () => {
    const above = measurePointToPlane(new THREE.Vector3(0, 3, 0), groundPlane);
    const below = measurePointToPlane(new THREE.Vector3(0, -3, 0), groundPlane);

    expect(above.distance).toBeCloseTo(3, 6);
    expect(below.distance).toBeCloseTo(3, 6);
  });

  it('measures zero for a point already on the plane', () => {
    expect(measurePointToPlane(new THREE.Vector3(7, 0, 7), groundPlane).distance).toBeCloseTo(0, 6);
  });
});

describe('measurePlaneToPlane', () => {
  it('measures the clear span between two parallel planes', () => {
    const other = { point: new THREE.Vector3(0, 2.4, 0), normal: new THREE.Vector3(0, 1, 0) };

    const result = measurePlaneToPlane(groundPlane, other);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.distance).toBeCloseTo(2.4, 6);
  });

  it('measures between walls whose normals face each other', () => {
    const left = { point: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(1, 0, 0) };
    const right = { point: new THREE.Vector3(3, 0, 0), normal: new THREE.Vector3(-1, 0, 0) };

    const result = measurePlaneToPlane(left, right);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.distance).toBeCloseTo(3, 6);
  });

  it('accepts a tilt inside the tolerance', () => {
    expect(measurePlaneToPlane(groundPlane, tilted(0.5, 2)).ok).toBe(true);
  });

  // The refusal has to name the angle: a measurement that silently returns a
  // number for two non-parallel faces is worse than one that declines.
  it('refuses a tilt outside the tolerance, and says by how much', () => {
    const result = measurePlaneToPlane(groundPlane, tilted(7, 2));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.angleDeg).toBeCloseTo(7, 4);
      expect(result.reason).toMatch(/parallel/i);
    }
  });

  it('takes the tolerance as an argument so it can be tuned', () => {
    expect(measurePlaneToPlane(groundPlane, tilted(5, 2), 10).ok).toBe(true);
    expect(measurePlaneToPlane(groundPlane, tilted(5, 2), 1).ok).toBe(false);
  });

  it('defaults to the documented tolerance', () => {
    expect(PARALLEL_TOLERANCE_DEG).toBe(1);
  });
});
