import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  footOnPlane,
  measurePointToPlane,
  measurePlaneToPlane,
  planeAngleDeg,
  PARALLEL_TOLERANCE_DEG,
  resolveMeasurement,
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

describe('resolveMeasurement', () => {
  const point = (x: number, y: number, z: number) => ({ position: new THREE.Vector3(x, y, z) });
  const onPlane = (x: number, y: number, z: number, normal: THREE.Vector3) => ({
    position: new THREE.Vector3(x, y, z),
    planeNormal: normal,
  });
  const up = () => new THREE.Vector3(0, 1, 0);
  const acrossX = () => new THREE.Vector3(1, 0, 0);

  it('measures point to point directly', () => {
    const result = resolveMeasurement(point(0, 0, 0), point(3, 4, 0));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('direct');
      expect(result.distance).toBeCloseTo(5, 6);
    }
  });

  // "How far is that column from the wall?" — pick the wall, pick the column.
  it('goes orthogonal when the first end is a surface', () => {
    const result = resolveMeasurement(onPlane(0, 0, 0, acrossX()), point(2.5, 0, 9));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('orthogonal');
      expect(result.distance).toBeCloseTo(2.5, 6);
    }
  });

  // Clicking in the other order asks the same question, so it gets the same answer.
  it('goes orthogonal when the second end is a surface', () => {
    const result = resolveMeasurement(point(2.5, 0, 9), onPlane(0, 0, 0, acrossX()));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.distance).toBeCloseTo(2.5, 6);
  });

  it('measures between two parallel surfaces', () => {
    const result = resolveMeasurement(onPlane(0, 0, 0, up()), onPlane(0, 2.7, 0, up()));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('orthogonal');
      expect(result.distance).toBeCloseTo(2.7, 6);
    }
  });

  it('refuses two surfaces that are not parallel', () => {
    const tiltedNormal = new THREE.Vector3(Math.sin(0.3), Math.cos(0.3), 0).normalize();
    const result = resolveMeasurement(onPlane(0, 0, 0, up()), onPlane(0, 2, 0, tiltedNormal));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.angleDeg).toBeGreaterThan(1);
  });

  it('lands the measurement on the plane, not at the picked spot', () => {
    // A column well past the end of the wall still measures to the wall line.
    const result = resolveMeasurement(onPlane(0, 0, 0, acrossX()), point(4, 0, 900));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.to.x).toBeCloseTo(0, 6);
      expect(result.to.z).toBeCloseTo(900, 6);
    }
  });
});

describe('which end the drawn segment starts from', () => {
  const up = new THREE.Vector3(0, 1, 0);

  it('starts at the picked point when the surface was picked first', () => {
    // Orthogonal to the FIRST surface means dropping the second point onto
    // it, so the segment runs from the second pick back to the plane.
    const result = resolveMeasurement(
      { position: new THREE.Vector3(0, 0, 0), planeNormal: up },
      { position: new THREE.Vector3(0, 3, 0) },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fromEnd).toBe('b');
      expect(result.from.y).toBeCloseTo(3, 6);
      expect(result.to.y).toBeCloseTo(0, 6);
    }
  });

  it('starts at the first pick when the surface was picked second', () => {
    const result = resolveMeasurement(
      { position: new THREE.Vector3(0, 3, 0) },
      { position: new THREE.Vector3(0, 0, 0), planeNormal: up },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.fromEnd).toBe('a');
  });
});
