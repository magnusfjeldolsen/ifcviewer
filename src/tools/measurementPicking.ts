import * as THREE from 'three';
import { distanceToSegment2D, type Candidate, type ScreenPoint } from '../inspector/candidateMath';
import type { MeasurementRecord } from './MeasurementStore';

/**
 * Turn measurements into pickable candidates, in screen space.
 *
 * Deliberately NOT a raycast. Measurement geometry draws with
 * `depthTest: false` and `renderOrder: 1000` so it stays visible through the
 * walls it annotates — which means a raycast "nearest hit wins" is meaningless
 * for it, and dropping measurements into the raycast list would let a
 * measurement inside a wall steal clicks from the wall in front of it.
 * `raycastVisible` therefore keeps filtering them out, and this projects the
 * two endpoints instead and measures pixel distance to the drawn shapes.
 *
 * Only the thin parts are pickable (D9): the line and the two point markers,
 * **never the label sprite**. The label is the one part with real screen area
 * — a world-scaled quad that grows without bound as the camera closes in — and
 * it is the only part that would blanket the elements behind it. Nobody's
 * instinct is to click a number to select the thing it annotates, and the line
 * is right there.
 *
 * Pure apart from `Vector3.project`, which needs only a camera — no renderer,
 * so this is testable in jsdom.
 */

/**
 * Pixels of slack around the drawn line. Deliberately wider than the ~3 px the
 * line is drawn at: forgiving *along* the line, while still occupying
 * essentially no area anywhere else. The standard CAD trick for wire geometry.
 */
export const MEASUREMENT_PICK_THRESHOLD_PX = 8;

/** Extra slack on the endpoint markers, which are the more deliberate target. */
export const MEASUREMENT_MARKER_RADIUS_PX = 10;

/** Elements are 1, so an element under the cursor outranks the annotation. */
export const MEASUREMENT_PRIORITY = 2;

/** Which part of a measurement a candidate refers to. */
export type MeasurementPart = 'line' | 'start' | 'end';

export interface MeasurementCandidatePayload {
  measurementId: string;
  part: MeasurementPart;
}

interface Projected {
  screen: ScreenPoint;
  depth: number;
  /** False when the point is behind the camera, where projection is nonsense. */
  inFront: boolean;
}

/**
 * Candidates for every measurement within the pick threshold of `cursor`.
 *
 * `size` is the canvas's CSS size, matching the units `cursor` is in.
 * At most one candidate per measurement: whichever of its three parts the
 * cursor is nearest. Offering all three would make `Tab` walk the same
 * measurement three times before reaching the next thing.
 */
export function measurementCandidatesAt(
  records: readonly MeasurementRecord[],
  cursor: ScreenPoint,
  camera: THREE.Camera,
  size: { width: number; height: number },
  isVisible: (record: MeasurementRecord) => boolean = () => true,
): Candidate[] {
  if (size.width <= 0 || size.height <= 0) return [];

  const out: Candidate[] = [];

  for (const record of records) {
    if (!isVisible(record)) continue;

    const start = project(record.start, camera, size);
    const end = project(record.end, camera, size);
    // Both ends behind the camera means nothing of this measurement is on
    // screen. One end behind still draws a partial line, but its projected
    // point is mirrored nonsense, so treat the whole thing as unpickable
    // rather than invent a target in the wrong place.
    if (!start.inFront || !end.inFront) continue;

    const toStart = Math.hypot(cursor.x - start.screen.x, cursor.y - start.screen.y);
    const toEnd = Math.hypot(cursor.x - end.screen.x, cursor.y - end.screen.y);
    const toLine = distanceToSegment2D(cursor, start.screen, end.screen);

    // Markers win over the line at equal distance: the user aiming at a marker
    // means the marker, and the line passes through it anyway.
    let part: MeasurementPart = 'line';
    let distance = toLine;
    let depth = (start.depth + end.depth) / 2;
    let limit = MEASUREMENT_PICK_THRESHOLD_PX;

    if (toStart <= toEnd && toStart <= MEASUREMENT_MARKER_RADIUS_PX) {
      part = 'start';
      distance = toStart;
      depth = start.depth;
      limit = MEASUREMENT_MARKER_RADIUS_PX;
    } else if (toEnd < toStart && toEnd <= MEASUREMENT_MARKER_RADIUS_PX) {
      part = 'end';
      distance = toEnd;
      depth = end.depth;
      limit = MEASUREMENT_MARKER_RADIUS_PX;
    }

    if (distance > limit) continue;

    out.push({
      kind: 'measurement',
      priority: MEASUREMENT_PRIORITY,
      distance,
      depth,
      id: `measurement:${record.id}`,
      payload: { measurementId: record.id, part } satisfies MeasurementCandidatePayload,
    });
  }

  return out;
}

/** Read a measurement candidate's payload, or null if it isn't one. */
export function measurementPayload(candidate: Candidate): MeasurementCandidatePayload | null {
  if (candidate.kind !== 'measurement') return null;
  const payload = candidate.payload as MeasurementCandidatePayload | undefined;
  return payload && typeof payload.measurementId === 'string' ? payload : null;
}

function project(
  point: THREE.Vector3,
  camera: THREE.Camera,
  size: { width: number; height: number },
): Projected {
  const ndc = point.clone().project(camera);
  return {
    screen: {
      x: (ndc.x * 0.5 + 0.5) * size.width,
      y: (-ndc.y * 0.5 + 0.5) * size.height,
    },
    depth: camera.position.distanceTo(point),
    // NDC z leaves [-1, 1] behind the camera and beyond the far plane alike.
    inFront: ndc.z > -1 && ndc.z < 1,
  };
}
