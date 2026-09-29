import * as THREE from 'three';
import type { Candidate, ScreenPoint } from '../inspector/candidateMath';
import { distanceToSegment2D } from '../inspector/candidateMath';
import { snapGeometryFor, growCoplanarPatch } from './snapGeometry';

/**
 * What the cursor could snap to, as candidates for the shared resolver.
 *
 * Registers as one more provider alongside elements and measurements and
 * inherits its ranking, its Tab cycling and its hover display — the resolver
 * was written for this and needs no change.
 */

/** What kind of thing a snap caught. Distinct from `Candidate.kind`, which names the provider. */
export type SnapTarget = 'vertex' | 'edge' | 'face' | 'point';

export const SNAP_KIND = 'snap';

/**
 * Most specific first. The radius does the gating — anything in this list is
 * already within a few pixels of the cursor — so preferring a corner over the
 * edge it sits on, and either over the face they lie in, matches what someone
 * pointing at a corner means. `point` is the deliberate escape hatch: the raw
 * position under the cursor, ranked last, which is why snapping needs no
 * suppression modifier.
 */
export const SNAP_PRIORITY: Record<SnapTarget, number> = {
  vertex: 0,
  edge: 1,
  face: 2,
  point: 3,
};

/** How near the cursor a corner or edge must be, in CSS pixels, to be offered. */
export const SNAP_RADIUS_PX = 12;

export interface SnapPayload {
  target: SnapTarget;
  /** Where the measurement point would go, in world space. */
  position: THREE.Vector3;
  /** An edge's world-space direction, for drawing its glyph. Unit length. */
  edgeDirection?: THREE.Vector3;
  /** A face patch's world-space normal, which is what makes a measurement orthogonal. */
  planeNormal?: THREE.Vector3;
}

export interface SnapQuery {
  mesh: THREE.Mesh;
  /** Index of the hit triangle, as three's raycaster reports it. */
  faceIndex: number;
  /** The raw world-space intersection point. */
  hitPoint: THREE.Vector3;
  cursor: ScreenPoint;
  camera: THREE.PerspectiveCamera;
  canvas: { width: number; height: number };
  radiusPx?: number;
}

export function snapCandidatesAt(query: SnapQuery): Candidate[] {
  const { mesh, faceIndex, hitPoint, cursor, camera, canvas } = query;
  const radius = query.radiusPx ?? SNAP_RADIUS_PX;
  if (canvas.width <= 0 || canvas.height <= 0) return [];

  const geo = snapGeometryFor(mesh.geometry);
  const matrix = mesh.matrixWorld;
  const out: Candidate[] = [];

  const world = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  // Corners. Mesh vertices rather than feature-edge endpoints, because the
  // corner of a box is a mesh vertex and that is what people point at.
  for (let i = 0; i < geo.positions.length / 3; i++) {
    world
      .set(geo.positions[i * 3], geo.positions[i * 3 + 1], geo.positions[i * 3 + 2])
      .applyMatrix4(matrix);
    const screen = project(world, camera, canvas);
    if (!screen) continue;
    const distance = Math.hypot(screen.x - cursor.x, screen.y - cursor.y);
    if (distance > radius) continue;
    out.push({
      kind: SNAP_KIND,
      priority: SNAP_PRIORITY.vertex,
      distance,
      depth: camera.position.distanceTo(world),
      id: `snap:vertex:${i}`,
      payload: { target: 'vertex', position: world.clone() } satisfies SnapPayload,
    });
  }

  // Edges that survived the dihedral filter. A raw mesh edge would include
  // the diagonal of every quad, which is a line across a flat wall that
  // nobody drew.
  for (let e = 0; e < geo.featureEdges.length / 2; e++) {
    const ia = geo.featureEdges[e * 2];
    const ib = geo.featureEdges[e * 2 + 1];
    a.set(geo.positions[ia * 3], geo.positions[ia * 3 + 1], geo.positions[ia * 3 + 2])
      .applyMatrix4(matrix);
    b.set(geo.positions[ib * 3], geo.positions[ib * 3 + 1], geo.positions[ib * 3 + 2])
      .applyMatrix4(matrix);
    const sa = project(a, camera, canvas);
    const sb = project(b, camera, canvas);
    if (!sa || !sb) continue;
    const distance = distanceToSegment2D(cursor, sa, sb);
    if (distance > radius) continue;

    const position = closestPointOnSegment(a, b, hitPoint);
    out.push({
      kind: SNAP_KIND,
      priority: SNAP_PRIORITY.edge,
      distance,
      depth: camera.position.distanceTo(position),
      id: `snap:edge:${e}`,
      payload: {
        target: 'edge',
        position,
        edgeDirection: b.clone().sub(a).normalize(),
      } satisfies SnapPayload,
    });
  }

  // The surface itself. Always offered, because the cursor is on it by
  // definition — and snapping to it is what makes a measurement orthogonal.
  const patch = growCoplanarPatch(geo, faceIndex);
  const planeNormal = patch.normal
    .clone()
    .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(matrix))
    .normalize();
  out.push({
    kind: SNAP_KIND,
    priority: SNAP_PRIORITY.face,
    distance: 0,
    depth: camera.position.distanceTo(hitPoint),
    id: 'snap:face',
    payload: {
      target: 'face',
      position: hitPoint.clone(),
      planeNormal,
    } satisfies SnapPayload,
  });

  // The raw point, ranked last. This is what "no snapping" is, and why there
  // is no modifier key to hold: the escape hatch is a Tab away like any other
  // alternative.
  out.push({
    kind: SNAP_KIND,
    priority: SNAP_PRIORITY.point,
    distance: 0,
    depth: camera.position.distanceTo(hitPoint),
    id: 'snap:point',
    payload: { target: 'point', position: hitPoint.clone() } satisfies SnapPayload,
  });

  return out;
}

/** The snap payload of a candidate, or null if it is not a snap. */
export function snapPayload(candidate: Candidate): SnapPayload | null {
  if (candidate.kind !== SNAP_KIND) return null;
  return (candidate.payload as SnapPayload) ?? null;
}

/** Canvas-space position of a world point, or null when it is behind the camera. */
function project(
  world: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  canvas: { width: number; height: number },
): ScreenPoint | null {
  const ndc = world.clone().project(camera);
  // Behind the camera the projection mirrors, and a point that is not on
  // screen must never win a proximity test against one that is.
  if (ndc.z > 1) return null;
  return {
    x: ((ndc.x + 1) / 2) * canvas.width,
    y: ((1 - ndc.y) / 2) * canvas.height,
  };
}

/** Where on segment a–b the given point lies closest, clamped to the segment. */
function closestPointOnSegment(
  a: THREE.Vector3,
  b: THREE.Vector3,
  point: THREE.Vector3,
): THREE.Vector3 {
  const ab = b.clone().sub(a);
  const lengthSq = ab.lengthSq();
  if (lengthSq === 0) return a.clone();
  const t = Math.max(0, Math.min(1, point.clone().sub(a).dot(ab) / lengthSq));
  return a.clone().add(ab.multiplyScalar(t));
}
