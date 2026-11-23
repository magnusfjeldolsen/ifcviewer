import * as THREE from 'three';
import { growCoplanarPatch, type SnapGeometry } from './snapGeometry';

/**
 * Finding the centre of something round from its triangles (issue #63).
 *
 * IFC curved geometry reaches the viewer as flat facets — web-ifc cuts a
 * circle into `CIRCLE_SEGMENTS` (12 by default) — so there is no arc left to
 * read a centre from. It is rebuilt from the mesh, in one of two ways
 * depending on what the cursor is on:
 *
 * - **The curved side** of a column, pipe, bar or round hole. A tessellated
 *   cylinder is a ring of flat facets whose shared edges all run parallel to
 *   the axis. One edge of the hit triangle is such an edge; the mesh is cut
 *   square to it through the hit triangle, and the cut is followed round,
 *   triangle by triangle, until it closes. Where it crosses an axis-parallel
 *   edge it is exactly on the circle, and a circle is fitted to those points.
 *   The snap then slides along the axis.
 * - **A flat face whose outline is a circle** — the top of a column seen in
 *   plan, the end of a pipe, the rim of a hole in a plate. The face's boundary
 *   loops are fitted one by one; each loop that is a circle offers its centre.
 *
 * Why a cut and not a surface grown out from the hit: a growing surface has
 * to be told where to stop, and every rule tried leaked — across the seam
 * into a flared capital, round an elbow onto the next leg of a pipe, or into
 * a size cap on a finely cut tank. A cut through one ring is local by
 * construction: it never visits anything outside the ring it started on, so
 * whatever else the element has (a capital, a bend, a thousand rows) cannot
 * spoil it, and the answer cannot depend on which triangle was hovered first.
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
 * point lies on the circle. A rounded rectangle, an I-beam fillet, a curved
 * beam's web, an ellipse and a hexagon all fail one or the other.
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
 * How far a facet may lean out of line with the axis and still be part of
 * the side, in degrees: both its normal out of square, and an edge out of
 * parallel. Real cylinders are exact; this absorbs rounding.
 */
export const AXIS_TOLERANCE_DEG = 2;

/**
 * How far any point may sit off the fitted circle, as a fraction of its
 * radius. Tessellated circles put their corners exactly on the circle, so
 * this is noise allowance — and tight enough to reject a rounded rectangle,
 * whose corners wander about 3% from the best circle through them.
 */
export const ROUND_TOLERANCE = 0.02;

/**
 * Geometry is stored as float32, which far from the chunk's anchor cannot
 * place a corner closer than about `magnitude × 2⁻²⁴`. A 3 mm bar 500 m out
 * has its corners rounded by 1% of its radius, and its facet normals by more
 * than `AXIS_TOLERANCE_DEG`. The tolerances above are widened by this many
 * float32 spacings at the coordinates involved — no more, so a near-origin
 * shape is judged exactly as strictly as before.
 */
const FLOAT32_SLACK = 2;
const FLOAT32_EPSILON = 2 ** -23;

/**
 * How far an edge may move across the axis, as a fraction of the facet's
 * width (or, following a line, of the distance along it), and still count as
 * running along the axis. True axis-parallel edges move by rounding only.
 */
const PARALLEL_FRACTION = 0.01;

/** Most triangles a cut round one ring may cross: 4096 segments. */
const MAX_RING_TRIANGLES = 8192;

/** Most edges an axis-parallel line is followed along, to find the run's length. */
const MAX_LINE_STEPS = 100_000;

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

/**
 * Whether a fitted circle is a closed, true circle by the thresholds above.
 * `slack` is an absolute allowance on top of `ROUND_TOLERANCE`, for points
 * known to carry float32 rounding.
 */
export function isRound(
  circle: Circle2D | null,
  maxFacetDeg = MAX_FACET_DEG,
  slack = 0,
): circle is Circle2D {
  if (!circle) return false;
  return (
    circle.residual * circle.r <= ROUND_TOLERANCE * circle.r + slack &&
    circle.maxGapDeg <= maxFacetDeg + FACET_SLACK_DEG
  );
}

interface RoundCaches {
  /** The curved-side fit through each hovered triangle, or null if there is none. */
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
 * The curved side is cached per triangle and only for the triangle asked
 * about: the cut depends on nothing but that triangle, so caching it against
 * others would make the answer depend on hover order. A cut is one ring of
 * triangles, so recomputing it for a neighbour is cheap. A flat face's
 * outlines are the same from every triangle of the face, and are cached
 * across all of them.
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
    side = fitCurvedSide(geo, triangle).fit;
    cache.side.set(triangle, side);
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
 * The curved side through `seed`, and the circle it lies on.
 *
 * Each edge of the seed triangle is tried as the axis direction. On a
 * tessellated cylinder exactly one of them runs along the axis; the other
 * two (round the ring, and the diagonal of the facet) produce a cut that
 * does not close, or does not close on a circle. `ring` is the triangles the
 * successful cut crossed — empty when none succeeded.
 */
export function fitCurvedSide(
  geo: SnapGeometry,
  seed: number,
): { fit: RoundFit | null; ring: number[] } {
  if (seed < 0 || seed >= geo.triangles.length / 3) return { fit: null, ring: [] };
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (let e = 0; e < 3; e++) {
    readPosition(geo, geo.triangles[seed * 3 + e], p);
    readPosition(geo, geo.triangles[seed * 3 + ((e + 1) % 3)], q);
    const axis = q.sub(p);
    if (axis.lengthSq() === 0) continue;
    const found = cutRing(geo, seed, axis.normalize());
    if (found.fit) return found;
  }
  return { fit: null, ring: [] };
}

/**
 * Cut the mesh square to `axis` through the middle of `seed`, follow the cut
 * round until it comes back to `seed`, and fit a circle to the points where
 * it crosses edges parallel to the axis.
 */
function cutRing(
  geo: SnapGeometry,
  seed: number,
  axis: THREE.Vector3,
): { fit: RoundFit | null; ring: number[] } {
  const none = { fit: null, ring: [] };
  // Work relative to a corner of the seed, so the arithmetic is on small
  // numbers whatever the chunk's coordinates are.
  const origin = new THREE.Vector3();
  readPosition(geo, geo.triangles[seed * 3], origin);
  const spacing = float32Spacing(origin);

  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  basisAround(axis, u, v);
  const p = new THREE.Vector3();
  const along = (vertex: number) => readPosition(geo, vertex, p).sub(origin).dot(axis);

  const s0 = (along(geo.triangles[seed * 3]) + along(geo.triangles[seed * 3 + 1]) + along(geo.triangles[seed * 3 + 2])) / 3;
  // Which side of the cut each corner is on. A corner exactly on the cut
  // counts as above it — any consistent choice makes each triangle cross the
  // cut through exactly two edges, which is what lets the walk continue.
  const above = (vertex: number) => along(vertex) >= s0;

  const sinTol = Math.sin((AXIS_TOLERANCE_DEG * Math.PI) / 180);
  const cosFacet = Math.cos(((MAX_FACET_DEG + FACET_SLACK_DEG) * Math.PI) / 180);
  const slack = FLOAT32_SLACK * spacing;

  const n = new THREE.Vector3();
  const m = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  // A facet belongs to the side if its normal is square to the axis — with
  // room for the rounding a small triangle's normal picks up from float32
  // corners, which grows as the triangle shrinks.
  const squareToAxis = (t: number): boolean => {
    readNormal(geo, t, n);
    return Math.abs(n.dot(axis)) <= sinTol + slack / shortestEdge(geo, t);
  };
  if (!squareToAxis(seed)) return none;

  const crossedEdges = (t: number): number[] => {
    const out: number[] = [];
    for (let e = 0; e < 3; e++) {
      if (above(geo.triangles[t * 3 + e]) !== above(geo.triangles[t * 3 + ((e + 1) % 3)])) out.push(e);
    }
    return out;
  };

  const seedCrossings = crossedEdges(seed);
  if (seedCrossings.length !== 2) return none;

  const xs: number[] = [];
  const ys: number[] = [];
  const lines: Array<[number, number, number]> = [];
  const ring: number[] = [seed];

  // Record where the cut crosses edge `e` of triangle `t`, if that edge runs
  // along the axis. Only those crossings are on the circle; a crossing of a
  // facet's diagonal is on its flat face, inside the circle by the sagitta.
  //
  // An angle test cannot tell the two apart: the diagonal of a long, narrow
  // facet leans off the axis by its width over its length — under a degree on
  // a 3 m column cut 24 ways. What does tell them apart is how far the edge
  // moves sideways, compared with how wide the facet is: an axis-parallel
  // edge does not move at all.
  const record = (t: number, e: number) => {
    const ia = geo.triangles[t * 3 + e];
    const ib = geo.triangles[t * 3 + ((e + 1) % 3)];
    readPosition(geo, ia, a).sub(origin);
    readPosition(geo, ib, b).sub(origin);
    const sa = a.dot(axis);
    const sb = b.dot(axis);
    if (sideways(a, b, axis) > PARALLEL_FRACTION * facetWidth(geo, t, axis) + slack) return;
    const f = (s0 - sa) / (sb - sa);
    a.lerp(b, f);
    xs.push(a.dot(u));
    ys.push(a.dot(v));
    if (lines.length < 2) lines.push([t, ia, ib]);
  };

  // Walk the cut round. Each triangle is left through the crossed edge it
  // was not entered by; the walk ends when it re-enters the seed.
  let t = seed;
  let exit = seedCrossings[0];
  for (let steps = 0; steps < MAX_RING_TRIANGLES; steps++) {
    record(t, exit);
    const next = geo.neighbours[t * 3 + exit];
    if (next < 0) return none;
    readNormal(geo, t, n);
    readNormal(geo, next, m);
    // A fold sharper than one facet is a corner, not a curve.
    if (n.dot(m) < cosFacet) return none;
    if (next === seed) break;
    if (!squareToAxis(next)) return none;

    const ia = geo.triangles[t * 3 + exit];
    const ib = geo.triangles[t * 3 + ((exit + 1) % 3)];
    const crossings = crossedEdges(next);
    if (crossings.length !== 2) return none;
    const entry = crossings.find((e) => sharesEdge(geo, next, e, ia, ib));
    if (entry === undefined) return none;
    exit = crossings[0] === entry ? crossings[1] : crossings[0];
    t = next;
    ring.push(t);
    if (steps === MAX_RING_TRIANGLES - 1) return none;
  }

  if (xs.length < Math.ceil(360 / MAX_FACET_DEG)) return none;
  const circle = fitCircle2D(xs, ys);
  if (!isRound(circle, MAX_FACET_DEG, slack)) return none;

  // How long the straight run is: follow the axis-parallel lines the cut
  // crossed up and down until they bend or end.
  let low = s0;
  let high = s0;
  for (const [tri, ia, ib] of lines) {
    for (const end of extentOfLine(geo, tri, ia, ib, axis, origin, slack)) {
      low = Math.min(low, end);
      high = Math.max(high, end);
    }
  }

  const centre = origin
    .clone()
    .addScaledVector(axis, (low + high) / 2)
    .addScaledVector(u, circle.cx)
    .addScaledVector(v, circle.cy);
  return {
    fit: { centre, axis: axis.clone(), radius: circle.r, halfLength: (high - low) / 2, slides: true },
    ring,
  };
}

/**
 * Where an axis-parallel line through edge `ia`–`ib` of triangle `tri` ends,
 * in both directions: the edge is extended through each end while the next
 * edge carries on in the same direction.
 */
function extentOfLine(
  geo: SnapGeometry,
  tri: number,
  ia: number,
  ib: number,
  axis: THREE.Vector3,
  origin: THREE.Vector3,
  slack: number,
): [number, number] {
  const p = new THREE.Vector3();
  const along = (vertex: number) => readPosition(geo, vertex, p).sub(origin).dot(axis);
  const ends: number[] = [];
  for (const [from, to] of [
    [ia, ib],
    [ib, ia],
  ]) {
    let previous = from;
    let current = to;
    let triangle = tri;
    const direction = Math.sign(along(to) - along(from));
    for (let steps = 0; steps < MAX_LINE_STEPS; steps++) {
      const next = continueLine(geo, triangle, previous, current, axis, direction, slack);
      if (!next) break;
      previous = current;
      current = next.vertex;
      triangle = next.triangle;
    }
    ends.push(along(current));
  }
  return [ends[0], ends[1]];
}

/**
 * The next corner along an axis-parallel line arriving at `current` from
 * `previous`, found among the triangles fanned round `current`.
 */
function continueLine(
  geo: SnapGeometry,
  start: number,
  previous: number,
  current: number,
  axis: THREE.Vector3,
  direction: number,
  slack: number,
): { vertex: number; triangle: number } | null {
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  readPosition(geo, current, c);
  const seen = new Set<number>([start]);
  const queue = [start];
  for (let head = 0; head < queue.length && head < 64; head++) {
    const t = queue[head];
    const corner = cornerIndex(geo, t, current);
    if (corner < 0) continue;
    for (const e of [corner, (corner + 2) % 3]) {
      // The two edges of `t` that meet at `current`.
      const other = geo.triangles[t * 3 + (e === corner ? (corner + 1) % 3 : e)];
      if (other !== previous) {
        readPosition(geo, other, d).sub(c);
        const forward = d.dot(axis) * direction;
        if (forward > 0 && sideways(c, d.add(c), axis) <= PARALLEL_FRACTION * forward + slack) {
          return { vertex: other, triangle: t };
        }
      }
      const across = geo.neighbours[t * 3 + e];
      if (across >= 0 && !seen.has(across)) {
        seen.add(across);
        queue.push(across);
      }
    }
  }
  return null;
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

  const origin = new THREE.Vector3();
  readPosition(geo, corners[0], origin);
  const xs = new Float64Array(corners.length);
  const ys = new Float64Array(corners.length);
  let low = Infinity;
  let high = -Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i < corners.length; i++) {
    readPosition(geo, corners[i], p).sub(origin);
    xs[i] = p.dot(u);
    ys[i] = p.dot(v);
    const along = p.dot(axis);
    low = Math.min(low, along);
    high = Math.max(high, along);
  }

  const circle = fitCircle2D(xs, ys);
  if (!isRound(circle, MAX_FACET_DEG, FLOAT32_SLACK * float32Spacing(origin))) return null;

  const centre = origin
    .clone()
    .addScaledVector(axis, (low + high) / 2)
    .addScaledVector(u, circle.cx)
    .addScaledVector(v, circle.cy);
  return { centre, axis: axis.clone().normalize(), radius: circle.r, halfLength: (high - low) / 2 };
}

/** How far `b` sits from `a` across the axis, ignoring any offset along it. */
function sideways(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const along = dx * axis.x + dy * axis.y + dz * axis.z;
  return Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along));
}

/** The widest a triangle is across the axis. */
function facetWidth(geo: SnapGeometry, t: number, axis: THREE.Vector3): number {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  readPosition(geo, geo.triangles[t * 3], a);
  readPosition(geo, geo.triangles[t * 3 + 1], b);
  readPosition(geo, geo.triangles[t * 3 + 2], c);
  return Math.max(sideways(a, b, axis), sideways(b, c, axis), sideways(c, a, axis));
}

/** Roughly how far apart neighbouring float32 values are near `p`. */
function float32Spacing(p: THREE.Vector3): number {
  return Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z), 1) * FLOAT32_EPSILON;
}

function shortestEdge(geo: SnapGeometry, t: number): number {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  readPosition(geo, geo.triangles[t * 3], a);
  readPosition(geo, geo.triangles[t * 3 + 1], b);
  readPosition(geo, geo.triangles[t * 3 + 2], c);
  return Math.max(Math.min(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)), 1e-12);
}

/** Whether edge `e` of triangle `t` joins corners `ia` and `ib`. */
function sharesEdge(geo: SnapGeometry, t: number, e: number, ia: number, ib: number): boolean {
  const x = geo.triangles[t * 3 + e];
  const y = geo.triangles[t * 3 + ((e + 1) % 3)];
  return (x === ia && y === ib) || (x === ib && y === ia);
}

function cornerIndex(geo: SnapGeometry, t: number, vertex: number): number {
  for (let k = 0; k < 3; k++) if (geo.triangles[t * 3 + k] === vertex) return k;
  return -1;
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
