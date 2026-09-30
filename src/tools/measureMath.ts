import * as THREE from 'three';

/**
 * Pure measurement maths and formatting.
 *
 * `MeasurementTool` needs WebGL and a 2D canvas context, so it has no unit
 * tests; anything here can be tested. Orthogonal mode (Step 3) will add plane
 * projection and world-normal helpers alongside `formatDistance`.
 *
 * The scene is in metres. web-ifc bakes each file's length factor into the
 * mesh placement matrix, so a millimetre model and a metre model already share
 * one world scale — there is nothing to convert here, only to display.
 */

/** Below this many metres a distance reads in millimetres instead. */
const MILLIMETRE_THRESHOLD_M = 1;

/**
 * Render a distance in metres for the measurement label.
 *
 * Sub-metre distances switch to whole millimetres. Under a flat
 * `toFixed(2)` a 3 mm gap rendered as `"0.00 m"` — a measurement that
 * confidently reports zero is worse than one that refuses to answer, and a
 * viewer used for clash-adjacent checks is asked about small gaps often.
 */
export function formatDistance(metres: number): string {
  const value = Math.abs(metres);
  if (value < MILLIMETRE_THRESHOLD_M) {
    const mm = Math.round(value * 1000);
    // 0.9996 m rounds to 1000 mm, which reads as a unit mistake. Anything that
    // rounds up to a whole metre belongs on the metre side of the switch.
    if (mm < MILLIMETRE_THRESHOLD_M * 1000) return `${mm} mm`;
  }
  return `${value.toFixed(2)} m`;
}

// ── Orthogonal measurement ───────────────────────────────────

/**
 * How far two surfaces may be from parallel and still be measured against
 * each other, in degrees.
 *
 * Real IFC surfaces meant to be parallel are exactly parallel, so this only
 * has to absorb tessellation noise. Named rather than inlined because it is
 * the kind of number that wants tuning once someone meets a model that
 * disagrees.
 */
export const PARALLEL_TOLERANCE_DEG = 1;

/** An infinite plane: a point on it, and its unit normal. */
export interface MeasurePlane {
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface OrthogonalMeasurement {
  /** Where the measurement starts — the point being measured. */
  from: THREE.Vector3;
  /** Where it lands on the plane. */
  to: THREE.Vector3;
  distance: number;
}

export type PlaneToPlaneResult =
  | ({ ok: true } & OrthogonalMeasurement)
  | { ok: false; reason: string; angleDeg: number };

/**
 * The angle between two planes, never more than 90°.
 *
 * Two walls facing each other across a corridor are parallel, but their
 * outward normals point in opposite directions — so the raw angle between
 * normals would be 180° and every corridor measurement would be refused.
 * What matters is the angle between the planes, not between the arrows.
 */
export function planeAngleDeg(a: THREE.Vector3, b: THREE.Vector3): number {
  const dot = Math.abs(a.clone().normalize().dot(b.clone().normalize()));
  // Float error can push the dot product a hair past 1, where acos is NaN.
  return (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

/**
 * Where a point lands when dropped perpendicular onto a plane.
 *
 * The plane is infinite. The patch that produced it is not — a column past
 * the end of a wall still has a meaningful distance to that wall's line, and
 * clamping to the patch would quietly answer a different question.
 */
export function footOnPlane(point: THREE.Vector3, plane: MeasurePlane): THREE.Vector3 {
  const normal = plane.normal.clone().normalize();
  const signed = point.clone().sub(plane.point).dot(normal);
  return point.clone().sub(normal.multiplyScalar(signed));
}

/** Measure from a point to a plane, along the plane's normal. */
export function measurePointToPlane(
  point: THREE.Vector3,
  plane: MeasurePlane,
): OrthogonalMeasurement {
  const to = footOnPlane(point, plane);
  return { from: point.clone(), to, distance: point.distanceTo(to) };
}

/**
 * Measure between two planes — the clear span between parallel walls.
 *
 * Refuses when they are not parallel, and says by how much. A measurement
 * that silently returns a number for two skew surfaces is worse than one
 * that declines, because nobody catches it.
 */
export function measurePlaneToPlane(
  a: MeasurePlane,
  b: MeasurePlane,
  toleranceDeg: number = PARALLEL_TOLERANCE_DEG,
): PlaneToPlaneResult {
  const angleDeg = planeAngleDeg(a.normal, b.normal);
  if (angleDeg > toleranceDeg) {
    return {
      ok: false,
      angleDeg,
      reason: `Those surfaces are ${angleDeg.toFixed(1)}° from parallel, so there is no single distance between them. Snap a point instead.`,
    };
  }

  // Measure from a point on `a` straight to `b`. Any point on `a` gives the
  // same answer once they are parallel, so the one we snapped is as good as
  // any and keeps the drawn segment where the user pointed.
  return { ok: true, ...measurePointToPlane(a.point, b) };
}

/** One end of a measurement: where it is, and the plane it caught if it caught one. */
export interface SnapPoint {
  position: THREE.Vector3;
  /** Present only when a surface was snapped. Its presence is what makes a measurement orthogonal. */
  planeNormal?: THREE.Vector3;
}

export type ResolvedMeasurement =
  | {
      ok: true;
      mode: 'direct' | 'orthogonal';
      /** Always the end corresponding to the FIRST pick. */
      from: THREE.Vector3;
      to: THREE.Vector3;
      distance: number;
    }
  | { ok: false; reason: string; angleDeg: number };

/**
 * Turn two picked ends into a measurement. **The first pick is the reference.**
 *
 * | first | second | result |
 * |---|---|---|
 * | vertex / edge / point | anything | straight-line distance |
 * | surface | vertex / edge / point | perpendicular from that surface |
 * | surface | surface | between the planes, refused if not parallel |
 *
 * Order carries the intent, which is what removes the ambiguity: the same two
 * clicks in the other order ask a different question and get a different
 * answer. Nothing is hidden and nothing is guessed — but it does mean the
 * drawing has to show which reading happened, or the ambiguity simply moves
 * from the rule to the screen.
 *
 * `from` always belongs to the first pick. When that pick is a surface,
 * `from` is the point on it that the measurement actually runs to, which is
 * not necessarily where the cursor was: perpendicular means perpendicular.
 */
export function resolveMeasurement(
  a: SnapPoint,
  b: SnapPoint,
  toleranceDeg: number = PARALLEL_TOLERANCE_DEG,
): ResolvedMeasurement {
  // Only the first pick can make a measurement perpendicular. A surface
  // picked second is just a point on a surface.
  if (!a.planeNormal) {
    return {
      ok: true,
      mode: 'direct',
      from: a.position.clone(),
      to: b.position.clone(),
      distance: a.position.distanceTo(b.position),
    };
  }

  const planeA = { point: a.position, normal: a.planeNormal };

  if (b.planeNormal) {
    const result = measurePlaneToPlane(planeA, { point: b.position, normal: b.planeNormal }, toleranceDeg);
    if (!result.ok) return result;
    return { ok: true, mode: 'orthogonal', from: result.from, to: result.to, distance: result.distance };
  }

  // Drop the second point onto the reference plane. The segment that gets
  // drawn is the perpendicular itself, so it explains the number without any
  // extra geometry: it starts on the surface and ends at what was measured.
  const foot = footOnPlane(b.position, planeA);
  return {
    ok: true,
    mode: 'orthogonal',
    from: foot,
    to: b.position.clone(),
    distance: foot.distanceTo(b.position),
  };
}
