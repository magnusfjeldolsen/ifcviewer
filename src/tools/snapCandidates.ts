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

/**
 * How much closer a less specific target must be before it beats a more
 * specific one, in CSS pixels.
 *
 * Priority alone is too blunt: it lets a corner 11 px away beat the edge the
 * cursor is sitting exactly on, which is what made edges feel unreachable.
 * Distance alone is too blunt the other way: a corner and the edge it
 * terminates are always within a pixel or two of each other, and there the
 * corner is what someone means. So specificity wins, but only among targets
 * that are effectively in the same place.
 */
export const SNAP_TIE_PX = 4;

/** Targets that attract the cursor. The other two are always underfoot. */
const FEATURE_TARGETS: ReadonlySet<SnapTarget> = new Set<SnapTarget>(['vertex', 'edge']);

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
  /**
   * When false, only the raw point is offered. This is the `S` toggle: the
   * tool still resolves a candidate, it is just always the plain one.
   */
  featuresEnabled?: boolean;
  /**
   * Which targets to offer. Omitted means all of them. The raw point is never
   * filtered out — it is the fallback that makes every other setting safe.
   */
  allowed?: ReadonlySet<SnapTarget>;
}

export function snapCandidatesAt(query: SnapQuery): Candidate[] {
  const { mesh, faceIndex, hitPoint, cursor, camera, canvas } = query;
  const radius = query.radiusPx ?? SNAP_RADIUS_PX;
  if (canvas.width <= 0 || canvas.height <= 0) return [];

  const out: Candidate[] = [];
  const allows = (target: SnapTarget) => query.allowed?.has(target) ?? true;

  if (query.featuresEnabled === false) return [plainPoint(hitPoint, camera)];

  const geo = snapGeometryFor(mesh.geometry);
  const matrix = mesh.matrixWorld;

  const world = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  // Corners. Mesh vertices rather than feature-edge endpoints, because the
  // corner of a box is a mesh vertex and that is what people point at.
  for (let i = 0; allows('vertex') && i < geo.positions.length / 3; i++) {
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
  for (let e = 0; allows('edge') && e < geo.featureEdges.length / 2; e++) {
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
  if (allows('face')) {
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
  }

  // The raw point, ranked last. This is what "no snapping" is, and why there
  // is no modifier key to hold: the escape hatch is a Tab away like any other
  // alternative.
  out.push(plainPoint(hitPoint, camera));

  return out;
}

function plainPoint(hitPoint: THREE.Vector3, camera: THREE.PerspectiveCamera): Candidate {
  return {
    kind: SNAP_KIND,
    priority: SNAP_PRIORITY.point,
    distance: 0,
    depth: camera.position.distanceTo(hitPoint),
    id: 'snap:point',
    payload: { target: 'point', position: hitPoint.clone() } satisfies SnapPayload,
  };
}

/**
 * Put snap candidates in the order the cursor should offer them.
 *
 * Not `rankCandidates`, which sorts by priority first. That is right across
 * providers — an element always outranks the annotation drawn over it — but
 * wrong within snapping, where how close a target is matters as much as what
 * kind it is. Face and point report distance zero because the cursor is on
 * them by definition, so a plain distance sort would be wrong too.
 */
export function orderSnapCandidates(
  candidates: readonly Candidate[],
  tiePx: number = SNAP_TIE_PX,
): Candidate[] {
  const features: Candidate[] = [];
  const fallbacks: Candidate[] = [];
  for (const candidate of candidates) {
    const target = (candidate.payload as SnapPayload | undefined)?.target;
    if (target && FEATURE_TARGETS.has(target)) features.push(candidate);
    else fallbacks.push(candidate);
  }

  const byDistance = (a: Candidate, b: Candidate) =>
    a.distance - b.distance || a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  features.sort(byDistance);

  if (features.length > 0) {
    // Everything effectively in the same place as the nearest feature is a
    // contender; among those, the most specific wins.
    const nearest = features[0].distance;
    const contenders = features.filter((c) => c.distance <= nearest + tiePx);
    contenders.sort(
      (a, b) => a.priority - b.priority || byDistance(a, b),
    );
    const winner = contenders[0];
    const rest = features.filter((c) => c !== winner);
    features.length = 0;
    features.push(winner, ...rest);
  }

  // Surface before raw point: the escape hatch is always the last stop.
  fallbacks.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));

  return [...features, ...fallbacks];
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
