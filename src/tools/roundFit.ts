import * as THREE from 'three';
import { DEFAULT_DIHEDRAL_DEG, growCoplanarPatch, type SnapGeometry } from './snapGeometry';

/**
 * Finding the centre of something round from its triangles (issue #63).
 *
 * IFC curved geometry reaches the viewer as flat facets — web-ifc cuts a
 * circle into `CIRCLE_SEGMENTS` (12 by default) — so there is no arc left to
 * read a centre from. It is rebuilt from the mesh, in one of two ways
 * depending on what the cursor is on:
 *
 * - **The curved side** of a column, pipe, bar or round hole. Neighbouring
 *   facets turn by a few degrees about a common axis, and every facet normal
 *   is square to that axis. The side is grown out from the hit triangle while
 *   that stays true, its corners are projected onto the plane square to the
 *   axis, and a circle is fitted to them. The snap then slides along the axis.
 * - **A flat face whose outline is a circle** — the top of a column seen in
 *   plan, the end of a pipe, the rim of a hole in a plate. The face's boundary
 *   loops are fitted one by one; each loop that is a circle offers its centre.
 *
 * Why geometry rather than the IFC profile: the profile is not on the main
 * thread (parsing lives in workers), it describes the element before any
 * boolean cut or mapped transform, and a model can make a round column from
 * an `IfcCircleProfileDef`, an arbitrary closed profile, a swept disk or a
 * faceted brep and all four look identical here. Triangles are what the cursor
 * actually hit.
 *
 * False positives are the risk the issue names, so a fit is only accepted when
 * the shape is closed (no gap round the centre wider than one facet) and every
 * corner lies on the circle. A rounded rectangle, an I-beam fillet, a curved
 * beam's web and a hexagon all fail one or the other.
 */

/**
 * The widest facet a round shape may have, in degrees — 8 segments to a
 * circle. Also the widest angle two neighbouring facets may turn through and
 * still be one curved surface. web-ifc's default of 12 segments is 30°;
 * a hexagon (60°) or a square (90°) is a polygon, not something round.
 */
export const MAX_FACET_DEG = 45;

/** Slack on `MAX_FACET_DEG` so a regular octagon is not lost to rounding. */
const FACET_SLACK_DEG = 0.5;

/**
 * How far a facet normal may lean out of square with the axis and still be
 * part of the side, in degrees. Real cylinders are exact; this absorbs float32
 * noise on small bars, and it is what stops the side growing round a bend.
 */
export const AXIS_TOLERANCE_DEG = 2;

/**
 * How far any corner may sit off the fitted circle, as a fraction of its
 * radius. Tessellated circles put their corners exactly on the circle, so
 * this is noise allowance — and tight enough to reject a rounded rectangle,
 * whose corners wander about 3% from the best circle through them.
 */
export const ROUND_TOLERANCE = 0.02;

/** Ceiling on how many triangles one curved side may grow to. */
const MAX_SIDE_TRIANGLES = 4096;

/** A centre found on a round shape, in the geometry's own (local) space. */
export interface RoundFit {
  /**
   * A point on the axis, midway along the shape's length — for a flat
   * outline, the circle's centre itself.
   */
  centre: THREE.Vector3;
  /** The axis direction, unit length. For a flat outline, the face normal. */
  axis: THREE.Vector3;
  radius: number;
  /** How far the shape runs either side of `centre` along the axis. Zero for an outline. */
  halfLength: number;
  /**
   * True for a curved side: the snap slides along the axis to wherever the
   * cursor is. False for a flat outline, whose centre is a single point.
   */
  slides: boolean;
}

export interface Circle2D {
  cx: number;
  cy: number;
  r: number;
  /** Largest distance of any point from the circle, as a fraction of `r`. */
  residual: number;
  /** Widest angle round the centre with no point in it, in degrees. */
  maxGapDeg: number;
}

/**
 * Least-squares circle through 2D points (Kåsa's algebraic fit), with the two
 * numbers that say whether it is any good.
 *
 * Points are taken relative to their mean first; far from the origin the
 * squared terms otherwise swamp the float64 mantissa.
 */
export function fitCircle2D(xs: ArrayLike<number>, ys: ArrayLike<number>): Circle2D | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;

  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;

  // Normal equations for x² + y² + D·x + E·y + F = 0.
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx;
    const y = ys[i] - my;
    const z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  const solved = solve3(
    [sxx, sxy, sx, sxy, syy, sy, sx, sy, n],
    [-sxz, -syz, -sz],
  );
  if (!solved) return null;
  const [d, e, f] = solved;
  const cx = -d / 2;
  const cy = -e / 2;
  const r2 = cx * cx + cy * cy - f;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);

  let worst = 0;
  const angles = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx - cx;
    const y = ys[i] - my - cy;
    worst = Math.max(worst, Math.abs(Math.hypot(x, y) - r));
    angles[i] = Math.atan2(y, x);
  }
  angles.sort();
  let gap = angles[0] + 2 * Math.PI - angles[n - 1];
  for (let i = 1; i < n; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);

  return { cx: cx + mx, cy: cy + my, r, residual: worst / r, maxGapDeg: (gap * 180) / Math.PI };
}

/** Whether a fitted circle is a closed, true circle by the thresholds above. */
export function isRound(circle: Circle2D | null, maxFacetDeg = MAX_FACET_DEG): circle is Circle2D {
  if (!circle) return false;
  return circle.residual <= ROUND_TOLERANCE && circle.maxGapDeg <= maxFacetDeg + FACET_SLACK_DEG;
}

interface RoundCaches {
  /** The curved-side fit each triangle belongs to, or null if it is not on one. */
  side: Map<number, RoundFit | null>;
  /** The round outlines of the flat face each triangle belongs to. */
  outline: Map<number, RoundFit[]>;
}

const caches = new WeakMap<SnapGeometry, RoundCaches>();

/**
 * Every round centre the triangle under the cursor belongs to, in local space.
 *
 * Usually zero or one. A flat face can have several round outlines (a plate
 * with holes; the inner and outer rim of a pipe end).
 *
 * Cached for every triangle of the side or face that was examined, so the
 * cursor moving across one column or one plate pays for the fit once.
 */
export function roundFitsAt(geo: SnapGeometry, triangle: number): RoundFit[] {
  if (triangle < 0 || triangle >= geo.triangles.length / 3) return [];
  let cache = caches.get(geo);
  if (!cache) {
    cache = { side: new Map(), outline: new Map() };
    caches.set(geo, cache);
  }

  let side = cache.side.get(triangle);
  if (side === undefined) {
    const found = fitCurvedSide(geo, triangle);
    for (const t of found.triangles) cache.side.set(t, found.fit);
    cache.side.set(triangle, found.fit);
    side = found.fit;
  }

  let outline = cache.outline.get(triangle);
  if (outline === undefined) {
    const found = fitFlatOutlines(geo, triangle);
    for (const t of found.triangles) cache.outline.set(t, found.fits);
    cache.outline.set(triangle, found.fits);
    outline = found.fits;
  }

  return side ? [side, ...outline] : outline;
}

/**
 * The curved side through `seed`, and the circle its corners lie on.
 *
 * Returns the triangles examined either way, so a failure is cached across
 * the whole surface too and a wall of fillets is not re-fitted on every move.
 */
export function fitCurvedSide(
  geo: SnapGeometry,
  seed: number,
): { fit: RoundFit | null; triangles: number[] } {
  const axis = seedAxis(geo, seed);
  if (!axis) return { fit: null, triangles: [] };

  const sinTol = Math.sin((AXIS_TOLERANCE_DEG * Math.PI) / 180);
  const cosFacet = Math.cos(((MAX_FACET_DEG + FACET_SLACK_DEG) * Math.PI) / 180);
  const cosFlat = Math.cos((DEFAULT_DIHEDRAL_DEG * Math.PI) / 180);
  const n = new THREE.Vector3();
  const m = new THREE.Vector3();
  const cross = new THREE.Vector3();

  readNormal(geo, seed, n);
  if (Math.abs(n.dot(axis)) > sinTol) return { fit: null, triangles: [] };

  // Grow the side: across edges that bend by no more than one facet, onto
  // triangles still square to the axis. The end caps meet it at 90° and the
  // start of a bend leans out of square, so both stop the growth.
  const seen = new Set<number>([seed]);
  const queue = [seed];
  const triangles: number[] = [];
  const refined = new THREE.Vector3();
  for (let head = 0; head < queue.length && triangles.length < MAX_SIDE_TRIANGLES; head++) {
    const t = queue[head];
    triangles.push(t);
    readNormal(geo, t, n);
    for (let e = 0; e < 3; e++) {
      const next = geo.neighbours[t * 3 + e];
      if (next < 0 || seen.has(next)) continue;
      readNormal(geo, next, m);
      const dot = n.dot(m);
      if (dot < cosFacet || Math.abs(m.dot(axis)) > sinTol) continue;
      seen.add(next);
      queue.push(next);
      // Each true bend is a fresh estimate of the axis; summing them averages
      // out the float noise of any single pair.
      if (dot < cosFlat) {
        cross.crossVectors(n, m).normalize();
        refined.add(cross.dot(axis) < 0 ? cross.negate() : cross);
      }
    }
  }
  if (refined.lengthSq() > 0) axis.copy(refined.normalize());

  const corners = cornersOf(geo, triangles);
  const fit = fitCircleAround(geo, corners, axis);
  if (!fit) return { fit: null, triangles };
  return { fit: { ...fit, slides: true }, triangles };
}

/**
 * The round outlines of the flat face through `seed`: each closed loop of its
 * boundary that is a circle.
 */
export function fitFlatOutlines(
  geo: SnapGeometry,
  seed: number,
): { fits: RoundFit[]; triangles: number[] } {
  const patch = growCoplanarPatch(geo, seed);
  const inPatch = new Set(patch.triangles);

  // Boundary edges: those whose far side is not in the face. Grouped into
  // loops by shared corners (union–find), since a face may have several.
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let root = v;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let walk = v;
    while (walk !== root) {
      const up = parent.get(walk)!;
      parent.set(walk, root);
      walk = up;
    }
    return root;
  };
  const link = (a: number, b: number) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const t of patch.triangles) {
    for (let e = 0; e < 3; e++) {
      const next = geo.neighbours[t * 3 + e];
      if (next >= 0 && inPatch.has(next)) continue;
      link(geo.triangles[t * 3 + e], geo.triangles[t * 3 + ((e + 1) % 3)]);
    }
  }

  const loops = new Map<number, number[]>();
  for (const v of parent.keys()) {
    const root = find(v);
    const loop = loops.get(root);
    if (loop) loop.push(v);
    else loops.set(root, [v]);
  }

  const fits: RoundFit[] = [];
  const minCorners = Math.ceil(360 / MAX_FACET_DEG);
  for (const loop of loops.values()) {
    if (loop.length < minCorners) continue;
    const fit = fitCircleAround(geo, loop, patch.normal);
    if (fit) fits.push({ ...fit, slides: false });
  }
  return { fits, triangles: patch.triangles };
}

/**
 * Fit a circle to `corners` seen down `axis`, and place its centre in 3D
 * midway along the corners' run of the axis.
 */
function fitCircleAround(
  geo: SnapGeometry,
  corners: readonly number[],
  axis: THREE.Vector3,
): Omit<RoundFit, 'slides'> | null {
  if (corners.length < 3) return null;
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  basisAround(axis, u, v);

  const xs = new Float64Array(corners.length);
  const ys = new Float64Array(corners.length);
  let low = Infinity;
  let high = -Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i < corners.length; i++) {
    readPosition(geo, corners[i], p);
    xs[i] = p.dot(u);
    ys[i] = p.dot(v);
    const along = p.dot(axis);
    low = Math.min(low, along);
    high = Math.max(high, along);
  }

  const circle = fitCircle2D(xs, ys);
  if (!isRound(circle)) return null;

  const centre = axis.clone().multiplyScalar((low + high) / 2)
    .addScaledVector(u, circle.cx)
    .addScaledVector(v, circle.cy);
  return { centre, axis: axis.clone().normalize(), radius: circle.r, halfLength: (high - low) / 2 };
}

/**
 * An axis estimate from the first real bend near the seed: the cross product
 * of two neighbouring facet normals is the line they fold along, which on a
 * tessellated cylinder runs parallel to the axis.
 *
 * Searches outward a little because the seed may be half of a flat quad whose
 * other half is the one touching the next facet.
 */
function seedAxis(geo: SnapGeometry, seed: number): THREE.Vector3 | null {
  const cosFacet = Math.cos(((MAX_FACET_DEG + FACET_SLACK_DEG) * Math.PI) / 180);
  const cosFlat = Math.cos((DEFAULT_DIHEDRAL_DEG * Math.PI) / 180);
  const n = new THREE.Vector3();
  const m = new THREE.Vector3();
  const seen = new Set<number>([seed]);
  const queue = [seed];
  for (let head = 0; head < queue.length && head < 16; head++) {
    const t = queue[head];
    readNormal(geo, t, n);
    for (let e = 0; e < 3; e++) {
      const next = geo.neighbours[t * 3 + e];
      if (next < 0 || seen.has(next)) continue;
      readNormal(geo, next, m);
      const dot = n.dot(m);
      if (dot < cosFacet) continue;
      if (dot < cosFlat) return new THREE.Vector3().crossVectors(n, m).normalize();
      seen.add(next);
      queue.push(next);
    }
  }
  return null;
}

function cornersOf(geo: SnapGeometry, triangles: readonly number[]): number[] {
  const set = new Set<number>();
  for (const t of triangles) {
    set.add(geo.triangles[t * 3]);
    set.add(geo.triangles[t * 3 + 1]);
    set.add(geo.triangles[t * 3 + 2]);
  }
  return [...set];
}

/** Two unit vectors square to `axis` and to each other. */
function basisAround(axis: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): void {
  const helper = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  u.crossVectors(axis, helper).normalize();
  v.crossVectors(axis, u).normalize();
}

function readNormal(geo: SnapGeometry, t: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(geo.normals[t * 3], geo.normals[t * 3 + 1], geo.normals[t * 3 + 2]);
}

function readPosition(geo: SnapGeometry, i: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(geo.positions[i * 3], geo.positions[i * 3 + 1], geo.positions[i * 3 + 2]);
}

/** Solve a 3×3 linear system (row-major) by Cramer's rule; null if singular. */
function solve3(a: readonly number[], b: readonly number[]): [number, number, number] | null {
  const det3 = (m: readonly number[]) =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  const det = det3(a);
  const scale = Math.abs(a[0]) + Math.abs(a[4]) + Math.abs(a[8]);
  if (!(Math.abs(det) > 1e-12 * scale * scale * scale)) return null;
  const col = (k: number) => a.map((value, i) => (i % 3 === k ? b[Math.floor(i / 3)] : value));
  return [det3(col(0)) / det, det3(col(1)) / det, det3(col(2)) / det];
}
