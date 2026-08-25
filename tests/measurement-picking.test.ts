/**
 * Screen-space measurement picking (D9).
 *
 * The design constraint the user set: selecting a measurement must be trivial
 * AND must not make elements near it unselectable. That rules out a raycast —
 * measurement geometry draws with `depthTest: false`, so it paints over
 * geometry in front of it and "nearest hit wins" is meaningless for it. Hence
 * projecting the two endpoints and measuring pixels, with the label excluded
 * because it is the one part with real screen area.
 *
 * Needs only a camera, not a renderer, so it runs here rather than in a
 * manual smoke test.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  MEASUREMENT_MARKER_RADIUS_PX,
  MEASUREMENT_PICK_THRESHOLD_PX,
  MEASUREMENT_PRIORITY,
  measurementCandidatesAt,
  measurementPayload,
} from '../src/tools/measurementPicking';
import { ELEMENT_PRIORITY } from '../src/inspector/elementCandidates';
import type { MeasurementRecord } from '../src/tools/MeasurementStore';

const SIZE = { width: 800, height: 600 };

/** Looks down -Z from (0, 0, 10); the z = 0 plane fills the view. */
function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(45, SIZE.width / SIZE.height, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function record(
  id: string,
  start: [number, number, number],
  end: [number, number, number],
  modelIds: string[] = ['model-a'],
): MeasurementRecord {
  return {
    id,
    start: new THREE.Vector3(...start),
    end: new THREE.Vector3(...end),
    modelIds,
  };
}

/** Where a world point lands in canvas pixels, for aiming the test cursor. */
function screenOf(point: THREE.Vector3, camera: THREE.Camera): { x: number; y: number } {
  const ndc = point.clone().project(camera);
  return {
    x: (ndc.x * 0.5 + 0.5) * SIZE.width,
    y: (-ndc.y * 0.5 + 0.5) * SIZE.height,
  };
}

describe('measurementCandidatesAt', () => {
  const camera = makeCamera();
  const horizontal = record('m1', [-3, 0, 0], [3, 0, 0]);

  it('offers a candidate for a cursor sitting on the line', () => {
    const mid = screenOf(new THREE.Vector3(0, 0, 0), camera);
    const found = measurementCandidatesAt([horizontal], mid, camera, SIZE);
    expect(found).toHaveLength(1);
    expect(measurementPayload(found[0])?.measurementId).toBe('m1');
  });

  it('offers nothing for a cursor beyond the threshold', () => {
    const mid = screenOf(new THREE.Vector3(0, 0, 0), camera);
    const far = { x: mid.x, y: mid.y + MEASUREMENT_MARKER_RADIUS_PX + 40 };
    expect(measurementCandidatesAt([horizontal], far, camera, SIZE)).toEqual([]);
  });

  it('still offers a candidate just inside the line threshold', () => {
    const mid = screenOf(new THREE.Vector3(0, 0, 0), camera);
    const near = { x: mid.x, y: mid.y + MEASUREMENT_PICK_THRESHOLD_PX - 1 };
    expect(measurementCandidatesAt([horizontal], near, camera, SIZE)).toHaveLength(1);
  });

  it('does not pick a measurement the cursor is merely aligned with', () => {
    // Straight off the end of the line: an infinite-line test would say 0 px.
    const end = screenOf(new THREE.Vector3(3, 0, 0), camera);
    const past = { x: end.x + 120, y: end.y };
    expect(measurementCandidatesAt([horizontal], past, camera, SIZE)).toEqual([]);
  });

  it('names the nearer endpoint marker when the cursor is on it', () => {
    const start = screenOf(new THREE.Vector3(-3, 0, 0), camera);
    const found = measurementCandidatesAt([horizontal], start, camera, SIZE);
    expect(measurementPayload(found[0])?.part).toBe('start');

    const end = screenOf(new THREE.Vector3(3, 0, 0), camera);
    const atEnd = measurementCandidatesAt([horizontal], end, camera, SIZE);
    expect(measurementPayload(atEnd[0])?.part).toBe('end');
  });

  it('names the line when the cursor is between the markers', () => {
    const mid = screenOf(new THREE.Vector3(0, 0, 0), camera);
    const found = measurementCandidatesAt([horizontal], mid, camera, SIZE);
    expect(measurementPayload(found[0])?.part).toBe('line');
  });

  it('offers at most ONE candidate per measurement', () => {
    // Otherwise Tab would walk the same measurement three times (line, start,
    // end) before reaching the next thing under the cursor.
    const start = screenOf(new THREE.Vector3(-3, 0, 0), camera);
    expect(measurementCandidatesAt([horizontal], start, camera, SIZE)).toHaveLength(1);
  });

  it('never produces a candidate for the label', () => {
    // D9 — the label is a world-scaled quad at the midpoint that grows without
    // bound as the camera closes in; it is the only part that would blanket
    // the elements behind it. Only line / start / end are ever named.
    const cursors = [
      screenOf(new THREE.Vector3(0, 0, 0), camera),
      screenOf(new THREE.Vector3(-3, 0, 0), camera),
      screenOf(new THREE.Vector3(3, 0, 0), camera),
      screenOf(new THREE.Vector3(1.5, 0, 0), camera),
    ];
    for (const cursor of cursors) {
      for (const candidate of measurementCandidatesAt([horizontal], cursor, camera, SIZE)) {
        expect(['line', 'start', 'end']).toContain(measurementPayload(candidate)?.part);
      }
    }
  });

  it('ranks below an element, so elements win ties', () => {
    expect(MEASUREMENT_PRIORITY).toBeGreaterThan(ELEMENT_PRIORITY);
  });

  it('skips a measurement behind the camera', () => {
    const behind = record('m2', [-3, 0, 60], [3, 0, 60]);
    const centre = { x: SIZE.width / 2, y: SIZE.height / 2 };
    expect(measurementCandidatesAt([behind], centre, camera, SIZE)).toEqual([]);
  });

  it('skips a measurement whose model is hidden (D15)', () => {
    const mid = screenOf(new THREE.Vector3(0, 0, 0), camera);
    const hidden = measurementCandidatesAt([horizontal], mid, camera, SIZE, () => false);
    expect(hidden).toEqual([]);
  });

  it('offers each overlapping measurement separately, for Tab to walk', () => {
    const second = record('m2', [-3, 0.02, 0], [3, 0.02, 0]);
    const mid = screenOf(new THREE.Vector3(0, 0, 0), camera);
    const found = measurementCandidatesAt([horizontal, second], mid, camera, SIZE);
    expect(found.map((c) => measurementPayload(c)?.measurementId).sort()).toEqual(['m1', 'm2']);
  });

  it('offers nothing on a zero-sized canvas', () => {
    expect(
      measurementCandidatesAt([horizontal], { x: 0, y: 0 }, camera, { width: 0, height: 0 }),
    ).toEqual([]);
  });
});

describe('measurementPayload', () => {
  it('returns null for a candidate from another provider', () => {
    expect(
      measurementPayload({ kind: 'element', priority: 1, distance: 0, depth: 1, id: 'e' }),
    ).toBeNull();
  });
});
