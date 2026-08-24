import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  rotateAboutPivot,
  dollyTowardPoint,
  resolvePivot,
  POLAR_EPSILON,
} from '../src/viewer/orbitMath';

const UP = new THREE.Vector3(0, 1, 0);
const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Angle from the up axis to the camera's backward vector — three's spherical phi. */
const phiOf = (position: THREE.Vector3, target: THREE.Vector3): number =>
  position.clone().sub(target).normalize().angleTo(UP);

describe('rotateAboutPivot', () => {
  it('leaves the pose untouched for a zero delta', () => {
    const pose = rotateAboutPivot({
      position: v(0, 0, 10),
      target: v(0, 0, 0),
      pivot: v(1, 2, 3),
      azimuth: 0,
      polar: 0,
      up: UP,
    });
    expect(pose.position.distanceTo(v(0, 0, 10))).toBeCloseTo(0, 10);
    expect(pose.target.distanceTo(v(0, 0, 0))).toBeCloseTo(0, 10);
  });

  it('preserves the camera distance to the pivot', () => {
    const pivot = v(3, -1, 2);
    const pose = rotateAboutPivot({
      position: v(0, 5, 10),
      target: v(0, 0, 0),
      pivot,
      azimuth: 0.7,
      polar: -0.3,
      up: UP,
    });
    expect(pose.position.distanceTo(pivot)).toBeCloseTo(v(0, 5, 10).distanceTo(pivot), 10);
  });

  /**
   * The whole point of the two-point design: because camera and view anchor
   * get the same rigid rotation, the anchor is still on the camera's forward
   * axis at the same distance afterwards — so `camera.lookAt(target)` cannot
   * move anything, and there is no snap.
   */
  it('keeps the view anchor on the forward axis at the same distance', () => {
    const position = v(0, 5, 10);
    const target = v(0, 0, 0);
    const before = position.distanceTo(target);

    const pose = rotateAboutPivot({
      position,
      target,
      pivot: v(-4, 1, 6),
      azimuth: 1.1,
      polar: -0.4,
      up: UP,
    });

    expect(pose.position.distanceTo(pose.target)).toBeCloseTo(before, 10);
  });

  it('rotates the view direction by exactly the requested rotation', () => {
    const position = v(0, 0, 10);
    const target = v(0, 0, 0);
    // Pivot off the view axis, so a naive implementation that only moved the
    // camera would change the view direction by a different amount.
    const pose = rotateAboutPivot({
      position,
      target,
      pivot: v(0, 0, 5),
      azimuth: -Math.PI / 2,
      polar: 0,
      up: UP,
    });

    const dirBefore = target.clone().sub(position).normalize();
    const dirAfter = pose.target.clone().sub(pose.position).normalize();
    expect(dirBefore.angleTo(dirAfter)).toBeCloseTo(Math.PI / 2, 10);
  });

  it('orbits about a pivot that is not the view anchor', () => {
    // Camera at +Z looking at the origin, pivot halfway between them.
    // A quarter turn about world-up swings both points around that pivot.
    const pose = rotateAboutPivot({
      position: v(0, 0, 10),
      target: v(0, 0, 0),
      pivot: v(0, 0, 5),
      azimuth: -Math.PI / 2,
      polar: 0,
      up: UP,
    });

    expect(pose.position.x).toBeCloseTo(-5, 10);
    expect(pose.position.z).toBeCloseTo(5, 10);
    expect(pose.target.x).toBeCloseTo(5, 10);
    expect(pose.target.z).toBeCloseTo(5, 10);
  });

  it('turns the camera the CAD way for a rightward drag', () => {
    // A rightward drag feeds a negative azimuth (see onPointerMove); the
    // camera must swing to -X so the model appears to turn to the right,
    // matching what OrbitControls did before we took rotation over.
    const pose = rotateAboutPivot({
      position: v(0, 0, 10),
      target: v(0, 0, 0),
      pivot: v(0, 0, 0),
      azimuth: -Math.PI / 2,
      polar: 0,
      up: UP,
    });
    expect(pose.position.x).toBeCloseTo(-10, 10);
    expect(pose.position.y).toBeCloseTo(0, 10);
    expect(pose.position.z).toBeCloseTo(0, 10);
  });

  it('changes the polar angle by exactly the requested delta', () => {
    const position = v(0, 0, 10);
    const target = v(0, 0, 0);
    const before = phiOf(position, target);
    const pose = rotateAboutPivot({
      position, target, pivot: target.clone(), azimuth: 0, polar: 0.4, up: UP,
    });
    // phi grows away from the up axis, so a positive delta lowers the camera;
    // the Viewer feeds -dy for exactly this reason.
    expect(phiOf(pose.position, pose.target)).toBeCloseTo(before + 0.4, 10);
  });

  it('clamps at the poles instead of flipping the view', () => {
    const position = v(0, 0, 10);
    const target = v(0, 0, 0);
    for (const polar of [-10, 10]) {
      const pose = rotateAboutPivot({
        position, target, pivot: target.clone(), azimuth: 0, polar, up: UP,
      });
      const phi = phiOf(pose.position, pose.target);
      expect(phi).toBeGreaterThanOrEqual(POLAR_EPSILON - 1e-9);
      expect(phi).toBeLessThanOrEqual(Math.PI - POLAR_EPSILON + 1e-9);
    }
  });

  it('still applies azimuth when the polar delta is clamped away', () => {
    // Clamping one axis must not silently swallow the other, or orbit locks
    // up whenever the user drags to the top of the model.
    const pose = rotateAboutPivot({
      position: v(0, 0, 10),
      target: v(0, 0, 0),
      pivot: v(0, 0, 0),
      azimuth: -Math.PI / 2,
      polar: -100,
      up: UP,
    });
    expect(pose.position.length()).toBeCloseTo(10, 10);
    expect(pose.position.x).toBeLessThan(0);
  });

  it('survives a pivot sitting exactly on the camera', () => {
    const pose = rotateAboutPivot({
      position: v(0, 0, 10),
      target: v(0, 0, 0),
      pivot: v(0, 0, 10),
      azimuth: 0.3,
      polar: 0.2,
      up: UP,
    });
    expect(Number.isFinite(pose.position.x)).toBe(true);
    expect(Number.isFinite(pose.target.x)).toBe(true);
    expect(pose.position.distanceTo(v(0, 0, 10))).toBeCloseTo(0, 10);
  });

  it('survives a camera pointing straight down the up axis', () => {
    // A top view makes cross(up, dir) degenerate; polar must fall back
    // rather than emit NaN and blank the viewport.
    const pose = rotateAboutPivot({
      position: v(0, 10, 0),
      target: v(0, 0, 0),
      pivot: v(0, 0, 0),
      azimuth: 0.5,
      polar: 0.3,
      up: UP,
    });
    expect(Number.isFinite(pose.position.x)).toBe(true);
    expect(Number.isFinite(pose.position.y)).toBe(true);
    expect(Number.isFinite(pose.position.z)).toBe(true);
    expect(pose.position.length()).toBeCloseTo(10, 6);
  });
});

describe('dollyTowardPoint', () => {
  const base = { position: v(0, 0, 10), target: v(0, 0, 0), minDistance: 0.01 };

  it('moves the camera toward the focus without turning it', () => {
    const pose = dollyTowardPoint({ ...base, focus: v(0, 0, 0), scale: 0.9 });
    expect(pose.position.z).toBeCloseTo(9, 10);
    const dir = pose.target.clone().sub(pose.position).normalize();
    expect(dir.distanceTo(v(0, 0, -1))).toBeCloseTo(0, 10);
  });

  it('keeps the focus point on the same view ray, so it stays under the cursor', () => {
    // Focus off the view axis — the cursor is rarely at screen centre.
    const focus = v(3, 2, 1);
    const dirBefore = focus.clone().sub(base.position).normalize();
    const pose = dollyTowardPoint({ ...base, focus, scale: 0.6 });
    const dirAfter = focus.clone().sub(pose.position).normalize();
    expect(dirAfter.distanceTo(dirBefore)).toBeCloseTo(0, 10);
  });

  it('carries the view anchor along so it stays on the forward axis', () => {
    const focus = v(3, 2, 1);
    const offsetBefore = base.target.clone().sub(base.position);
    const pose = dollyTowardPoint({ ...base, focus, scale: 0.6 });
    const offsetAfter = pose.target.clone().sub(pose.position);
    expect(offsetAfter.distanceTo(offsetBefore)).toBeCloseTo(0, 10);
  });

  it('scales the distance to the focus geometrically', () => {
    const focus = v(0, 0, 0);
    const pose = dollyTowardPoint({ ...base, focus, scale: 0.5 });
    expect(pose.position.distanceTo(focus)).toBeCloseTo(5, 10);
  });

  /**
   * Blender's documented "viewport wall": a dolly step proportional to the
   * remaining distance shrinks until "movement appears to stop entirely" and
   * the user is stranded short of the surface. Geometric stepping must keep
   * closing the gap on every single notch.
   */
  it('keeps closing the gap and never stalls short of the surface', () => {
    const focus = v(0, 0, 0);
    let pose = { position: base.position.clone(), target: base.target.clone() };
    let previous = pose.position.distanceTo(focus);

    for (let i = 0; i < 60; i += 1) {
      pose = dollyTowardPoint({ ...pose, focus, scale: 0.9, minDistance: 1e-6 });
      const distance = pose.position.distanceTo(focus);
      expect(distance).toBeLessThan(previous);
      previous = distance;
    }
    expect(previous).toBeLessThan(0.1);
  });

  it('never crosses the near-plane guard however hard the user scrolls', () => {
    const focus = v(0, 0, 0);
    let pose = { position: base.position.clone(), target: base.target.clone() };
    for (let i = 0; i < 200; i += 1) {
      pose = dollyTowardPoint({ ...pose, focus, scale: 0.5, minDistance: 0.25 });
    }
    expect(pose.position.distanceTo(focus)).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(pose.position.distanceTo(focus)).toBeCloseTo(0.25, 6);
  });

  it('backs out again with the reciprocal scale', () => {
    const focus = v(1, 2, 3);
    const inward = dollyTowardPoint({ ...base, focus, scale: 0.8 });
    const back = dollyTowardPoint({ ...base, ...inward, focus, scale: 1 / 0.8 });
    expect(back.position.distanceTo(base.position)).toBeCloseTo(0, 8);
    expect(back.target.distanceTo(base.target)).toBeCloseTo(0, 8);
  });

  it('honours a maximum distance when zooming out', () => {
    const focus = v(0, 0, 0);
    let pose = { position: base.position.clone(), target: base.target.clone() };
    for (let i = 0; i < 50; i += 1) {
      pose = dollyTowardPoint({ ...pose, focus, scale: 2, minDistance: 0.01, maxDistance: 500 });
    }
    expect(pose.position.distanceTo(focus)).toBeCloseTo(500, 6);
  });

  it('does nothing when the focus coincides with the camera', () => {
    const pose = dollyTowardPoint({ ...base, focus: base.position.clone(), scale: 0.5 });
    expect(pose.position.distanceTo(base.position)).toBeCloseTo(0, 10);
    expect(pose.target.distanceTo(base.target)).toBeCloseTo(0, 10);
  });
});

describe('resolvePivot', () => {
  const HIT = v(1, 1, 1);
  const PLACED = v(2, 2, 2);
  const SELECTION = v(3, 3, 3);
  const FALLBACK = v(4, 4, 4);
  const all = {
    hit: HIT, placed: PLACED, placedOnScreen: true, selection: SELECTION, fallback: FALLBACK,
  };

  it('prefers whatever is under the cursor', () => {
    const resolved = resolvePivot(all);
    expect(resolved.point.equals(HIT)).toBe(true);
  });

  it('marks a cursor pivot transient so it cannot replace the placed one', () => {
    expect(resolvePivot(all).transient).toBe(true);
    expect(resolvePivot({ ...all, hit: null }).transient).toBe(false);
  });

  it('falls back to the placed pivot over empty space', () => {
    const resolved = resolvePivot({ ...all, hit: null });
    expect(resolved.point.equals(PLACED)).toBe(true);
  });

  it('skips a placed pivot that has drifted off screen', () => {
    // Orbiting about a point behind the camera reads as turning about
    // nothing; Navisworks releases its pivot lock for the same reason.
    const resolved = resolvePivot({ ...all, hit: null, placedOnScreen: false });
    expect(resolved.point.equals(SELECTION)).toBe(true);
  });

  it('falls back to the selection when no pivot was ever placed', () => {
    const resolved = resolvePivot({ ...all, hit: null, placed: null });
    expect(resolved.point.equals(SELECTION)).toBe(true);
  });

  it('falls back to the fit centre when there is nothing else to go on', () => {
    const resolved = resolvePivot({
      hit: null, placed: null, placedOnScreen: false, selection: null, fallback: FALLBACK,
    });
    expect(resolved.point.equals(FALLBACK)).toBe(true);
  });

  it('returns copies, so a gesture cannot mutate the stored pivots', () => {
    const resolved = resolvePivot({ ...all, hit: null });
    resolved.point.set(9, 9, 9);
    expect(PLACED.equals(v(2, 2, 2))).toBe(true);
  });
});
