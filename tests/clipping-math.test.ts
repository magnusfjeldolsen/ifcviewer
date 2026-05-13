import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { computePlaneDelta } from '../src/tools/ClippingTool';

describe('computePlaneDelta', () => {
  let camera: THREE.PerspectiveCamera;
  const canvasRect = { width: 1600, height: 900 };

  beforeEach(() => {
    camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  });

  it('1. vertical wall, normal +X, cursor +100 px X → forward', () => {
    const handlePos = new THREE.Vector3(0, 0, 0);
    const planeNormal = new THREE.Vector3(1, 0, 0);
    const worldDelta = computePlaneDelta({
      handlePos,
      planeNormal,
      camera,
      canvasRect,
      cursorDeltaPx: { x: 100, y: 0 },
    });
    expect(worldDelta).toBeGreaterThan(0);
    // Expected ≈ 100 * (2 * 10 * tan(30°)) / 900 ≈ 1.283
    expect(worldDelta).toBeCloseTo(1.283, 2);
  });

  it('2. vertical wall, normal +X, cursor -100 px X → retreat', () => {
    const handlePos = new THREE.Vector3(0, 0, 0);
    const planeNormal = new THREE.Vector3(1, 0, 0);
    const worldDelta = computePlaneDelta({
      handlePos,
      planeNormal,
      camera,
      canvasRect,
      cursorDeltaPx: { x: -100, y: 0 },
    });
    expect(worldDelta).toBeLessThan(0);
    expect(worldDelta).toBeCloseTo(-1.283, 2);
  });

  it('3. vertical wall, normal +X, cursor +100 px Y → orthogonal, ≈ 0', () => {
    const handlePos = new THREE.Vector3(0, 0, 0);
    const planeNormal = new THREE.Vector3(1, 0, 0);
    const worldDelta = computePlaneDelta({
      handlePos,
      planeNormal,
      camera,
      canvasRect,
      cursorDeltaPx: { x: 0, y: 100 },
    });
    expect(worldDelta).toBeCloseTo(0, 5);
  });

  it('4. horizontal slab, normal +Y, cursor +100 px Y (screen down) → retreat (this is the bug)', () => {
    // Pre-fix: dragging down would push the plane up. The fix gives the correct
    // sign: normal +Y projects to -Y_screen (because screen-Y is flipped vs NDC-Y),
    // so cursor +Y_screen is anti-parallel to the normal's screen direction.
    const handlePos = new THREE.Vector3(0, 0, 0);
    const planeNormal = new THREE.Vector3(0, 1, 0);
    const worldDelta = computePlaneDelta({
      handlePos,
      planeNormal,
      camera,
      canvasRect,
      cursorDeltaPx: { x: 0, y: 100 },
    });
    expect(worldDelta).toBeLessThan(0);
    expect(worldDelta).toBeCloseTo(-1.283, 2);
  });

  it('5. horizontal slab, normal -Y (post-negate runtime), cursor +100 px Y (down) → forward (down in world)', () => {
    // After `.negate()` in onPlaceDown, clicking top-of-slab gives a -Y normal.
    // Dragging down on screen should move the plane down in world.
    const handlePos = new THREE.Vector3(0, 0, 0);
    const planeNormal = new THREE.Vector3(0, -1, 0);
    const worldDelta = computePlaneDelta({
      handlePos,
      planeNormal,
      camera,
      canvasRect,
      cursorDeltaPx: { x: 0, y: 100 },
    });
    expect(worldDelta).toBeGreaterThan(0);
    expect(worldDelta).toBeCloseTo(1.283, 2);
  });

  it('6. diagonal normal in XY, cursor along matching diagonal moves plane; orthogonal does not', () => {
    const handlePos = new THREE.Vector3(0, 0, 0);
    const planeNormal = new THREE.Vector3(0.707, 0.707, 0).normalize();

    // Normal projects to roughly (+, -) in screen-pixel space due to the Y-flip.
    // Matching diagonal cursor: same direction.
    const matchingDiag = computePlaneDelta({
      handlePos,
      planeNormal,
      camera,
      canvasRect,
      cursorDeltaPx: { x: 70.71, y: -70.71 },
    });
    expect(matchingDiag).toBeGreaterThan(0);

    // Orthogonal diagonal: perpendicular in screen space.
    const orthogonalDiag = computePlaneDelta({
      handlePos,
      planeNormal,
      camera,
      canvasRect,
      cursorDeltaPx: { x: 70.71, y: 70.71 },
    });
    expect(orthogonalDiag).toBeCloseTo(0, 5);
  });

  it('7. normal parallel to view direction → returns 0, no NaN', () => {
    // Camera at (0,0,10) looking -Z. Normal +Z is roughly along the view ray
    // from the handle at origin. Its screen projection length is near zero.
    const handlePos = new THREE.Vector3(0, 0, 0);
    const planeNormal = new THREE.Vector3(0, 0, 1);
    const worldDelta = computePlaneDelta({
      handlePos,
      planeNormal,
      camera,
      canvasRect,
      cursorDeltaPx: { x: 100, y: 100 },
    });
    expect(worldDelta).toBe(0);
    expect(Number.isFinite(worldDelta)).toBe(true);
  });

  it('8. distance invariance: doubling camera distance doubles worldDelta for same cursor delta', () => {
    const handlePos = new THREE.Vector3(0, 0, 0);
    const planeNormal = new THREE.Vector3(1, 0, 0);
    const cursorDeltaPx = { x: 100, y: 0 };

    const atZ10 = computePlaneDelta({ handlePos, planeNormal, camera, canvasRect, cursorDeltaPx });

    camera.position.set(0, 0, 20);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const atZ20 = computePlaneDelta({ handlePos, planeNormal, camera, canvasRect, cursorDeltaPx });

    expect(atZ20 / atZ10).toBeCloseTo(2, 2);
  });

  it('9. FOV invariance: halving FOV roughly halves worldDelta at the same distance', () => {
    const handlePos = new THREE.Vector3(0, 0, 0);
    const planeNormal = new THREE.Vector3(1, 0, 0);
    const cursorDeltaPx = { x: 100, y: 0 };

    const atFov60 = computePlaneDelta({ handlePos, planeNormal, camera, canvasRect, cursorDeltaPx });

    // Narrower FOV: each pixel covers less world. Ratio = tan(15°)/tan(30°).
    camera.fov = 30;
    camera.updateProjectionMatrix();
    const atFov30 = computePlaneDelta({ handlePos, planeNormal, camera, canvasRect, cursorDeltaPx });

    const expectedRatio = Math.tan((30 * Math.PI) / 180 / 2) / Math.tan((60 * Math.PI) / 180 / 2);
    expect(atFov30 / atFov60).toBeCloseTo(expectedRatio, 2);
  });
});
