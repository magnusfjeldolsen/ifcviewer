import * as THREE from 'three';
import { growCoplanarPatch, MAX_PATCH_TRIANGLES, type SnapGeometry } from './snapGeometry';

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
 *   the axis. One edge of the hit triangle's facet is such an edge; the mesh
 *   is cut square to it through the hit triangle, and the cut is followed
 *   round, triangle by triangle, until it closes — stepping across T-junctions,
 *   unwelded seams and duplicate triangles by position where the mesh does not
 *   pair edges up. Where it crosses an axis-parallel edge it is exactly on the
 *   circle, and a circle is fitted to those points (`judgeRing`, which allows
 *   one local defect such as an opening). The surface must also run straight
 *   along the axis (`runsStraight`, which is what tells a cylinder from a
 *   finely cut sphere). The snap then slides along the axis, as far as the
 *   cylinder runs.
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
 * the shape is closed (no gap round the centre wider than one facet, or one
 * local gap of at most a quarter turn) and every point lies on the circle. A
 * rounded rectangle, an I-beam fillet, a curved beam's web, an ellipse, a
 * hexagon and a sphere all fail.
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

/** How many steps of a cut are checked at a time for turning; see `walk` in `cutRing`. */
const TURN_WINDOW = 256;

/** Most triangles a cut round one ring may cross: 4096 segments. */
const MAX_RING_TRIANGLES = 8192;

/** Most edges followed along axis-parallel lines for one ring, to find their runs. */
const MAX_LINE_STEPS = 100_000;

/**
 * How far apart two edges may be and still be stepped across as one where
 * the mesh does not pair them — a T-junction, an unwelded seam, a duplicate
 * triangle — as a fraction of the facet's width.
 */
const DEFECT_TOLERANCE = 1e-3;

/**
 * The largest piece, in triangles plus corners, that gets an index for
 * stepping across defects. About 45 ms to build once on a desktop at this size. Larger
 * pieces are never indexed, whichever hover asks first.
 */
const INDEX_MAX_SIZE = 300_000;

/** The smallest grid cell the defect index uses, in metres: wider than any seam worth bridging. */
const INDEX_MIN_CELL = 1e-4;

/**
 * The widest single gap a ring may have from a local defect (an opening, a
 * notch, a dent), in degrees. See `judgeRing` for the conditions.
 */
const DEFECT_GAP_DEG = 90;

/** How many times `judgeRing` refits after setting an arc aside, before giving up. */
const JUDGE_ROUNDS = 4;

/**
 * The shortest straight run round a ring, as a fraction of the longest,
 * for the surface to count as running along the axis. See `runsStraight`.
 */
const STRAIGHT_RATIO = 0.25;

/** The other way to pass `runsStraight`: every run at least this many radii long. */
const STRAIGHT_RADII = 1;

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
  /** Corner and triangle lookups for stepping across mesh defects; built on first need, null if the piece is too big. */
  index?: MeshIndex | null;
}

const caches = new WeakMap<SnapGeometry, RoundCaches>();

function cachesFor(geo: SnapGeometry): RoundCaches {
  let cache = caches.get(geo);
  if (!cache) {
    cache = { side: new Map(), outline: new Map() };
    caches.set(geo, cache);
  }
  return cache;
}

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
 * across all of them — but only when the whole face was examined; a face
 * larger than the patch limit is cached against the hovered triangle alone,
 * since a different start would see a different part of it.
 */
export function roundFitsAt(
  geo: SnapGeometry,
  triangle: number,
  cost?: { steps: number },
): RoundFit[] {
  if (triangle < 0 || triangle >= geo.triangles.length / 3) return [];
  const cache = cachesFor(geo);
  let used = 0;
  // The curved side and the flat outline each get a budget of their own, so
  // neither's answer depends on how much the other spent.
  const within = <T>(work: () => T): T | null => {
    const spending = { left: STEP_BUDGET, used: 0 };
    spend = spending;
    try {
      return overBudgetIsNull(work);
    } finally {
      spend = null;
      used += spending.used;
    }
  };

  let side = cache.side.get(triangle);
  if (side === undefined) {
    side = within(() => fitCurvedSide(geo, triangle).fit);
    cache.side.set(triangle, side);
  }

  let outline = cache.outline.get(triangle);
  if (outline === undefined) {
    const found = within(() => fitFlatOutlines(geo, triangle));
    if (found?.complete) for (const t of found.triangles) cache.outline.set(t, found.fits);
    outline = found?.fits ?? [];
    cache.outline.set(triangle, outline);
  }

  if (cost) cost.steps = used;
  return side ? [side, ...outline] : outline;
}

/**
 * The most work one `roundFitsAt` call may do on the curved side, and again
 * on the flat outline, in steps: a triangle crossed by a cut, a corner or
 * triangle scanned when stepping across a defect, a point fitted, a triangle
 * looked at following a line, a triangle of a flat face grown. Building a
 * piece's defect index is not counted against any one call (see
 * `meshIndex`), so no answer depends on what was hovered before.
 *
 * 30 000 steps covers the largest round things the cut handles — a ring of
 * 4096 segments, a column 4000 rows tall, a column of 512 segments with a
 * T-junction on every other edge — each in about 9 000–25 000. A call that
 * uses the whole budget took 9–15 ms on a desktop (about 25 ms the first
 * time a piece's defect index is built), and most calls use a few hundred
 * steps. It is counted rather than timed so the answer for a triangle is the
 * same on every machine and at every hover speed: a call that runs out finds
 * nothing, and that nothing is remembered for the triangle like any other
 * answer.
 */
export const STEP_BUDGET = 30_000;

class OverBudget {}

/** The budget of the `roundFitsAt` call in progress, or null outside one (direct calls are unlimited). */
let spend: { left: number; used: number } | null = null;

/** Count `steps` against the current call, abandoning it when it overruns. */
function charge(steps: number): void {
  if (!spend) return;
  spend.used += steps;
  spend.left -= steps;
  if (spend.left < 0) throw new OverBudget();
}


function overBudgetIsNull<T>(work: () => T): T | null {
  try {
    return work();
  } catch (error) {
    if (error instanceof OverBudget) return null;
    throw error;
  }
}

/**
 * Where across the hovered triangle the cut is tried, as fractions of its
 * run along the axis: its centroid first, then towards each end. Openings
 * and notches cut through a column at some heights only, and boolean output
 * triangulates the uncut side into long triangles that reach right across
 * the cut-out band; a second level lets such a triangle still find its
 * ring. The order is fixed, so the answer for a triangle is always the same.
 */
const CUT_LEVELS = [-1, 0.1, 0.9, 0.3, 0.7];

/**
 * Other levels are only tried when the broken cut was short — an opening
 * cut through a modest ring. A cut that ran a long way without closing is
 * on a large open surface (the web of a curved beam), which no other level
 * will close either; retrying it there cost several milliseconds a hover.
 */
const RETRY_RING_LIMIT = 64;

/** How far round a broken cut must have turned to be worth retrying, in degrees. */
const MIN_BROKEN_TURN_DEG = 20;

/**
 * The curved side through `seed`, and the circle it lies on.
 *
 * Each edge of the seed triangle is tried as the axis direction. On a
 * tessellated cylinder one of them runs along the axis; the others produce a
 * cut that does not close, or does not close on a circle.
 *
 * Where more than one fits — a bend is curved two ways, round the tube and
 * round the bend — the smallest circle wins. The tighter curvature is the
 * cross-section of the thing under the cursor (the pipe, the bar); the wider
 * one is the path it follows, which is not what "the centre of this pipe"
 * means. `ring` is the triangles the chosen cut crossed — empty when none
 * fitted.
 */
export function fitCurvedSide(
  geo: SnapGeometry,
  seed: number,
): { fit: RoundFit | null; ring: number[] } {
  let best: { fit: RoundFit | null; ring: number[] } = { fit: null, ring: [] };
  if (seed < 0 || seed >= geo.triangles.length / 3) return best;
  // Whether any cut stopped short near the seed: the mark of a local cut-out,
  // and the only time the rest of the facet's edges are worth trying.
  let shortBreak = false;
  const tryAxis = (axis: THREE.Vector3) => {
    for (const level of CUT_LEVELS) {
      const found = cutRing(geo, seed, axis, level);
      if (found.fit) {
        if (!best.fit || found.fit.radius < best.fit.radius) best = { fit: found.fit, ring: found.ring };
        return;
      }
      if (!found.broken || found.ring.length > RETRY_RING_LIMIT) return;
      shortBreak = true;
      // Another level only for a cut that turned some way round first: one
      // that ran straight into an edge across a flat face is no ring at any
      // level, and retrying it is what made flat-sided elements slow to hover.
      if ((found.turned ?? 0) < MIN_BROKEN_TURN_DEG) return;
    }
  };
  const { own, facet } = candidateAxes(geo, seed);
  for (const axis of own) tryAxis(axis);
  if (!best.fit && shortBreak) for (const axis of facet) tryAxis(axis);
  return best;
}

/** How many triangles of the hovered facet lend their edges as candidate axes. */
const FACET_NEIGHBOURHOOD = 8;

/**
 * Directions that might be the axis: the edges of the hovered triangle
 * (`own`) and, separately, those of the triangles lying flat with it in the
 * same facet (`facet`), without repeats.
 *
 * The hovered triangle's own edges are not always enough. Where an opening
 * or notch has been cut, the facet beside it is re-triangulated as a fan
 * round the cut's corners, and a triangle of that fan may have no edge along
 * the axis at all — its partners in the same flat facet do. They are tried
 * only when the hovered triangle's own edges found nothing and at least one
 * of its cuts stopped short nearby, which is what such a fan looks like; on
 * a large open surface they would only add cost.
 */
function candidateAxes(geo: SnapGeometry, seed: number): { own: THREE.Vector3[]; facet: THREE.Vector3[] } {
  const cosFlat = Math.cos((0.1 * Math.PI) / 180);
  const n = new THREE.Vector3();
  const m = new THREE.Vector3();
  readNormal(geo, seed, n);
  const triangles = [seed];
  const seen = new Set<number>([seed]);
  for (let head = 0; head < triangles.length && triangles.length < FACET_NEIGHBOURHOOD; head++) {
    for (let e = 0; e < 3; e++) {
      const next = geo.neighbours[triangles[head] * 3 + e];
      if (next < 0 || seen.has(next)) continue;
      seen.add(next);
      readNormal(geo, next, m);
      if (n.dot(m) >= cosFlat) triangles.push(next);
    }
  }
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const own: THREE.Vector3[] = [];
  const facet: THREE.Vector3[] = [];
  for (const t of triangles) {
    for (let e = 0; e < 3; e++) {
      readPosition(geo, geo.triangles[t * 3 + e], p);
      readPosition(geo, geo.triangles[t * 3 + ((e + 1) % 3)], q);
      const axis = q.sub(p);
      if (axis.lengthSq() === 0) continue;
      axis.normalize();
      if ([...own, ...facet].some((known) => Math.abs(known.dot(axis)) > 1 - 1e-9)) continue;
      (t === seed ? own : facet).push(axis.clone());
    }
  }
  return { own, facet };
}

/**
 * Cut the mesh square to `axis` through `seed` at `level` (a fraction of the
 * seed's run along the axis, or -1 for its centroid), follow the cut round
 * until it comes back to `seed` — or both ways until it stops — and fit a
 * circle to the points where it crosses edges parallel to the axis.
 */
function cutRing(
  geo: SnapGeometry,
  seed: number,
  axis: THREE.Vector3,
  level: number,
): { fit: RoundFit | null; ring: number[]; broken?: boolean; turned?: number } {
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

  const corners = [0, 1, 2].map((k) => along(geo.triangles[seed * 3 + k]));
  const low = Math.min(...corners);
  const high = Math.max(...corners);
  if (!(high > low)) return none;
  let s0 = level < 0 ? (corners[0] + corners[1] + corners[2]) / 3 : low + level * (high - low);
  // Never cut exactly through a corner of the seed: the cut would leave
  // through a vertex rather than an edge, where "the triangle across" is
  // ambiguous. A centroid lands on a corner's level more often than one
  // might think — a T-junction's midpoint is exactly there.
  if (corners.some((c) => Math.abs(c - s0) <= 1e-6 * (high - low))) s0 += 1e-3 * (high - low);
  // Which side of the cut each corner is on. A corner exactly on the cut
  // counts as above it — any consistent choice makes each triangle cross the
  // cut through exactly two edges, which is what lets the walk continue.
  const above = (vertex: number) => along(vertex) >= s0;

  const sinTol = Math.sin((AXIS_TOLERANCE_DEG * Math.PI) / 180);
  const cosFacet = Math.cos(((MAX_FACET_DEG + FACET_SLACK_DEG) * Math.PI) / 180);
  const slack = FLOAT32_SLACK * spacing;
  // How close two edges must be to count as the same edge where the mesh
  // does not say so: a T-junction, a seam that was not welded, a duplicate.
  const gapTolerance = DEFECT_TOLERANCE * facetWidth(geo, seed, axis) + slack;

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
  /** Per recorded point: the edge it is on, and that edge's run along the axis. */
  const edges: Array<{ t: number; ia: number; ib: number; run: number }> = [];
  const ring: number[] = [seed];
  const visited = new Set<number>([seed]);

  // Where the cut crosses edge `e` of triangle `t`, relative to `origin`.
  const crossing = (t: number, e: number, out: THREE.Vector3): THREE.Vector3 => {
    readPosition(geo, geo.triangles[t * 3 + e], a).sub(origin);
    readPosition(geo, geo.triangles[t * 3 + ((e + 1) % 3)], b).sub(origin);
    const sa = a.dot(axis);
    const sb = b.dot(axis);
    return out.copy(a).lerp(b, (s0 - sa) / (sb - sa));
  };

  // Record where the cut crosses edge `e` of triangle `t`, if that edge runs
  // along the axis. Only those crossings are on the circle; a crossing of a
  // facet's diagonal is on its flat face, inside the circle by the sagitta.
  //
  // An angle test cannot tell the two apart: the diagonal of a long, narrow
  // facet leans off the axis by its width over its length — under a degree on
  // a 3 m column cut 24 ways. What does tell them apart is how far the edge
  // moves sideways, compared with how wide the facet is: an axis-parallel
  // edge does not move at all.
  const point = new THREE.Vector3();
  const record = (t: number, e: number) => {
    const ia = geo.triangles[t * 3 + e];
    const ib = geo.triangles[t * 3 + ((e + 1) % 3)];
    readPosition(geo, ia, a).sub(origin);
    readPosition(geo, ib, b).sub(origin);
    if (sideways(a, b, axis) > PARALLEL_FRACTION * facetWidth(geo, t, axis) + slack) return;
    const run = Math.abs(b.dot(axis) - a.dot(axis));
    crossing(t, e, point);
    xs.push(point.dot(u));
    ys.push(point.dot(v));
    edges.push({ t, ia, ib, run });
  };

  // The triangle on the far side of edge `exit` of `t`, and the edge of it
  // the cut comes in by. Usually the mesh says. Where it does not — the edge
  // is shared by one triangle or by more than two — the far side is found by
  // position: a triangle near the edge's corners that has an edge through
  // the point where the cut leaves, chosen as the flattest continuation.
  const across = (t: number, exit: number): { next: number; entry: number } | null => {
    const ia = geo.triangles[t * 3 + exit];
    const ib = geo.triangles[t * 3 + ((exit + 1) % 3)];
    const known = geo.neighbours[t * 3 + exit];
    if (known >= 0) {
      for (let e = 0; e < 3; e++) if (sharesEdge(geo, known, e, ia, ib)) return { next: known, entry: e };
      return null;
    }
    const index = meshIndex(geo);
    if (!index) return null;
    const exitPoint = crossing(t, exit, new THREE.Vector3()).add(origin);
    readNormal(geo, t, n);
    let best: { next: number; entry: number; flat: number } | null = null;
    const near = index.trianglesNear(geo, [ia, ib], gapTolerance);
    for (const candidate of near) {
      if (candidate === t || sameCorners(geo, candidate, t)) continue;
      // Not back across an edge the mesh already pairs up.
      if (geo.neighbours[t * 3] === candidate || geo.neighbours[t * 3 + 1] === candidate || geo.neighbours[t * 3 + 2] === candidate) continue;
      if (visited.has(candidate) && !isSeed(candidate)) continue;
      readNormal(geo, candidate, m);
      const flat = n.dot(m);
      if (flat < cosFacet) continue;
      for (const e of crossedEdges(candidate)) {
        readPosition(geo, geo.triangles[candidate * 3 + e], a);
        readPosition(geo, geo.triangles[candidate * 3 + ((e + 1) % 3)], b);
        if (distanceToSegment(exitPoint, a, b) > gapTolerance) continue;
        if (!best || flat > best.flat || (flat === best.flat && candidate < best.next)) {
          best = { next: candidate, entry: e, flat };
        }
      }
    }
    return best ? { next: best.next, entry: best.entry } : null;
  };

  // A duplicate of the seed is the seed, for the purpose of coming back round.
  const isSeed = (t: number) => t === seed || sameCorners(geo, t, seed);

  // Walk the cut one way from the seed. Each triangle is left through the
  // crossed edge it was not entered by. Ends 'closed' on re-entering the
  // seed, 'open' where the side stops (an opening, a sharp fold, the end of
  // the mesh) — or 'flat' when it is plainly not going round anything.
  //
  // A ring must turn through 360° in at most MAX_RING_TRIANGLES steps, so
  // over any stretch it turns on average at least 360° / MAX_RING_TRIANGLES
  // a step. A cut running up a flat strip — the wrong candidate axis on a
  // tall, finely rowed column, or any cut across a plane — turns not at all,
  // and is stopped after one window instead of walking thousands of rows.
  let flat = false;
  /** How far the cut has turned in all, both ways round. */
  let totalTurn = 0;
  const walk = (firstExit: number): 'closed' | 'open' => {
    let t = seed;
    let exit = firstExit;
    let turned = 0;
    for (let steps = 0; steps < MAX_RING_TRIANGLES; steps++) {
      if (steps > 0 && steps % TURN_WINDOW === 0) {
        if (turned < (TURN_WINDOW * 180) / MAX_RING_TRIANGLES) {
          flat = true;
          return 'open';
        }
        turned = 0;
      }
      record(t, exit);
      charge(1);
      const step = across(t, exit);
      if (!step) return 'open';
      readNormal(geo, t, n);
      readNormal(geo, step.next, m);
      const fold = n.dot(m);
      // A fold sharper than one facet is a corner, not a curve.
      if (fold < cosFacet) return 'open';
      const turn = (Math.acos(Math.min(1, fold)) * 180) / Math.PI;
      turned += turn;
      totalTurn += turn;
      if (isSeed(step.next)) return 'closed';
      if (visited.has(step.next) || !squareToAxis(step.next)) return 'open';
      const crossings = crossedEdges(step.next);
      if (crossings.length !== 2 || !crossings.includes(step.entry)) return 'open';
      exit = crossings[0] === step.entry ? crossings[1] : crossings[0];
      t = step.next;
      visited.add(t);
      ring.push(t);
    }
    return 'open';
  };

  // Round one way; if that stops short, the other way from the seed too, so
  // a ring broken in one place still gives the arc either side of the break.
  const closed = walk(seedCrossings[0]) === 'closed';
  if (!closed && !flat) walk(seedCrossings[1]);
  // A ring that closed and still failed is not round at any level, and a
  // flat run is not a ring at all; one that was broken might close at
  // another level. `ring` goes back with it so the caller can tell a short
  // break (an opening beside the hovered triangle) from a long open surface.
  const rejected = { fit: null, ring, broken: !closed && !flat, turned: totalTurn };

  // An open cut can only pass the defect rule if it went most of the way
  // round: all but one gap of DEFECT_GAP_DEG and the facet either side of it.
  // A broken cut on a large open surface — a curved façade, a vault — turns
  // through far less, and is turned away here before its thousands of
  // points reach the fit.
  if (!closed && totalTurn < 360 - DEFECT_GAP_DEG - MAX_FACET_DEG - FACET_SLACK_DEG) return rejected;

  const judged = judgeRing(xs, ys, slack);
  if (!judged) return rejected;
  const { circle, kept } = judged;

  if (!runsStraight(geo, edges, kept, axis, origin, slack, circle.r)) return rejected;

  // How far the snap may slide: the straight run this ring is on, measured
  // along the axis-parallel lines the cut crossed (see `runOfRing`).
  // Every recorded line, not only those the fit kept: a ring through an
  // opening or past a dent then picks the same lines as one beside it.
  const [from, to] = runOfRing(geo, edges, xs.map((_, i) => i), xs, ys, circle, axis, u, v, origin, slack);
  const centre = origin
    .clone()
    .addScaledVector(u, circle.cx)
    .addScaledVector(v, circle.cy)
    .addScaledVector(axis, (from + to) / 2);
  return {
    fit: { centre, axis: axis.clone(), radius: circle.r, halfLength: (to - from) / 2, slides: true },
    ring,
  };
}

/** How many of the ring's axis-parallel lines are followed to measure its run. */
const RUN_LINES = 16;

/**
 * The run of the cylinder this ring is on, along `axis` relative to `origin`:
 * the union of the axis-parallel lines through the ring, each followed until
 * it bends or ends.
 *
 * Only `RUN_LINES` of them, picked by angle round the circle — the line
 * nearest each of 16 fixed directions, in a frame that depends only on the
 * axis — so the cost is bounded however finely the cylinder is cut, and any
 * ring at any height on the same cylinder picks the same lines and gets the
 * same run: where the snap sits along the axis depends only on the cursor.
 * Following lines rather than collecting every edge on the cylinder also
 * keeps two pieces on one axis apart (two bars end to end, a column and a
 * coaxial collar), each to its own run.
 */
function runOfRing(
  geo: SnapGeometry,
  edges: ReadonlyArray<{ t: number; ia: number; ib: number; run: number }>,
  kept: readonly number[],
  xs: readonly number[],
  ys: readonly number[],
  circle: Circle2D,
  axis: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  origin: THREE.Vector3,
  slack: number,
): [number, number] {
  // A frame round the axis that does not depend on which way the cut found it.
  const flip = canonicalSign(axis);
  const fu = new THREE.Vector3();
  const fv = new THREE.Vector3();
  canonicalBasis(axis.clone().multiplyScalar(flip), fu, fv);
  const angleOf = (i: number) => {
    // Back from the cut's own (u, v) to 3D, then into the fixed frame.
    const d = u.clone().multiplyScalar(xs[i] - circle.cx).addScaledVector(v, ys[i] - circle.cy);
    return Math.atan2(d.dot(fv), d.dot(fu));
  };
  // Directions in an order that spreads them round the circle early on
  // (0, 8, 4, 12, 2, …), so that if the run budget runs out the lines
  // already followed are still spread round it.
  const order = Array.from({ length: RUN_LINES }, (_, k) => k).sort((p, q) => bitReverse(p) - bitReverse(q));
  // One pass: each point is a candidate for the direction whose sector it
  // falls in, and the nearest to that direction's centre wins it.
  const sector = (2 * Math.PI) / RUN_LINES;
  const winner = new Array<number>(RUN_LINES).fill(-1);
  const winnerOff = new Array<number>(RUN_LINES).fill(Infinity);
  for (const i of kept) {
    const a = angleOf(i) + Math.PI;
    const k = Math.min(RUN_LINES - 1, Math.floor(a / sector));
    const off = Math.abs(a - (k + 0.5) * sector);
    if (off < winnerOff[k] - 1e-12) {
      winnerOff[k] = off;
      winner[k] = i;
    }
  }
  charge(kept.length);
  const chosen = order.map((k) => winner[k]).filter((i) => i >= 0);

  let from = Infinity;
  let to = -Infinity;
  let budget = RUN_STEPS;
  for (const i of chosen) {
    if (budget <= 0) break;
    const { t, ia, ib } = edges[i];
    const [a, b, used] = extentOfLine(geo, t, ia, ib, axis, origin, slack, budget);
    budget -= used;
    from = Math.min(from, a, b);
    to = Math.max(to, a, b);
  }
  return [from, to];
}

/**
 * Most triangles looked at following lines to measure one run. A step along
 * a line looks at the few triangles round a corner — three or four on a
 * plain grid — so this follows about two lines of 2500–3000 rows in full;
 * on a cylinder cut finer than that along its length the run is measured
 * from what was followed, the longest line first reaching furthest, and may
 * be short.
 */
const RUN_STEPS = 20_000;

/** The 4-bit reversal of `k`, for spreading 16 directions round a circle. */
function bitReverse(k: number): number {
  return ((k & 1) << 3) | ((k & 2) << 1) | ((k & 4) >> 1) | ((k & 8) >> 3);
}

/**
 * Whether the points a cut collected lie on a circle, allowing for one local
 * defect. Returns the circle and which points it kept.
 *
 * A clean ring passes `isRound` as it is. Otherwise the defect rule: one
 * contiguous arc of points may be set aside — the run, in order round the
 * circle, of points off it that contains the worst one — and refitted
 * without, a few times over (`JUDGE_ROUNDS`) as the fit settles. What may be
 * set aside is an angle, not a number of points, so a flat planed across 60°
 * of a column is the same defect whether the column is cut 24 ways or 256.
 * The ring passes if, after that,
 *
 * - every remaining point is on the circle,
 * - the set-aside arc and the gap it leaves span at most `DEFECT_GAP_DEG`,
 * - every other gap is still no wider than one facet (`MAX_FACET_DEG`),
 * - at least `360 / MAX_FACET_DEG` points remain.
 *
 * That admits a column with an opening, a notch, a flat or a dented corner on
 * one side, and keeps out what the rule was written against: an open arc (its
 * gap is the rest of the circle), a hexagon (several 60° gaps), an ellipse or
 * a rounded rectangle (its error is spread round the whole outline, not in
 * one place) and an I-section's fillet (a quarter circle). Each round is one
 * fit and one sort, so the cost is a small multiple of the ring's size.
 */
export function judgeRing(
  xs: readonly number[],
  ys: readonly number[],
  slack = 0,
): { circle: Circle2D; kept: number[] } | null {
  const n = xs.length;
  const minPoints = Math.ceil(360 / MAX_FACET_DEG);
  if (n < minPoints) return null;
  const all = xs.map((_, i) => i);
  charge(n);
  const whole = fitCircle2D(xs, ys);
  if (isRound(whole, MAX_FACET_DEG, slack)) return { circle: whole, kept: all };

  const facet = ((MAX_FACET_DEG + FACET_SLACK_DEG) * Math.PI) / 180;
  const defectGap = ((DEFECT_GAP_DEG + FACET_SLACK_DEG) * Math.PI) / 180;
  // One look before any refit: a single local defect, even with the fit it
  // is pulling, puts the points that are well off the circle on one side of
  // it. An ellipse or a rounded rectangle has them all the way round, and is
  // turned away here at the cost of one pass.
  const first = whole as Circle2D | null;
  if (first) {
    const tolerance = ROUND_TOLERANCE * first.r + slack;
    const angles: number[] = [];
    for (let i = 0; i < n; i++) {
      if (Math.abs(Math.hypot(xs[i] - first.cx, ys[i] - first.cy) - first.r) > 2 * tolerance) {
        angles.push(Math.atan2(ys[i] - first.cy, xs[i] - first.cx));
      }
    }
    if (angles.length > 1) {
      angles.sort((p, q) => p - q);
      let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
      for (let k = 1; k < angles.length; k++) gap = Math.max(gap, angles[k] - angles[k - 1]);
      // The smallest arc holding them all is the circle less its widest gap.
      if (2 * Math.PI - gap > Math.PI) return null;
    }
  }
  let circle = whole as Circle2D | null;
  let aside = new Set<number>();
  for (let round = 0; round < JUDGE_ROUNDS; round++) {
    if (!circle) return null;
    const c = circle;
    charge(2 * n);
    const tolerance = ROUND_TOLERANCE * c.r + slack;
    const angleOf = (i: number) => Math.atan2(ys[i] - c.cy, xs[i] - c.cx);
    const order = [...all].sort((p, q) => angleOf(p) - angleOf(q));
    const kept = order.filter((i) => !aside.has(i));

    // The worst point still counted, if any is off.
    let worst = -1;
    let worstOff = tolerance;
    for (const i of kept) {
      const d = Math.abs(Math.hypot(xs[i] - c.cx, ys[i] - c.cy) - c.r);
      if (d > worstOff) {
        worstOff = d;
        worst = i;
      }
    }

    if (worst < 0) {
      // Everything counted is on the circle: the gaps decide, once.
      let widest = 0;
      let second = 0;
      let widestFrom = 0;
      for (let k = 0; k < kept.length; k++) {
        const a = angleOf(kept[k]);
        const b = k + 1 < kept.length ? angleOf(kept[k + 1]) : angleOf(kept[0]) + 2 * Math.PI;
        const size = b - a;
        if (size > widest) {
          second = widest;
          widest = size;
          widestFrom = a;
        } else if (size > second) {
          second = size;
        }
      }
      const inWidest = (i: number) => {
        let d = angleOf(i) - widestFrom;
        while (d < 0) d += 2 * Math.PI;
        while (d >= 2 * Math.PI) d -= 2 * Math.PI;
        return d < widest;
      };
      const ok = widest <= defectGap && second <= facet && [...aside].every(inWidest);
      return ok ? { circle: c, kept } : null;
    }

    // The arc to set aside: from the worst point, out both ways round the
    // circle through points that are off it or already set aside.
    const at = order.indexOf(worst);
    const arc = new Set<number>([worst]);
    // Grown through points off by more than a quarter of the tolerance, so
    // the flank of a flat — just inside the circle, but not far enough to
    // fail it — goes with the flat instead of pulling the centre off.
    const isBad = (i: number) =>
      aside.has(i) || Math.abs(Math.hypot(xs[i] - c.cx, ys[i] - c.cy) - c.r) > tolerance / 4;
    let ahead = 0;
    while (ahead + 1 < n && isBad(order[(at + ahead + 1) % n])) {
      ahead++;
      arc.add(order[(at + ahead) % n]);
    }
    let behind = 0;
    while (behind + ahead + 1 < n && isBad(order[(at - behind - 1 + n) % n])) {
      behind++;
      arc.add(order[(at - behind + n) % n]);
    }
    // Its span, from the first point beyond it on one side to the first on
    // the other: the gap it would leave.
    const before = order[(at - behind - 1 + n) % n];
    const after = order[(at + ahead + 1) % n];
    let span = angleOf(after) - angleOf(before);
    while (span <= 0) span += 2 * Math.PI;
    // Too wide against a fit that the defect itself is still pulling: set
    // aside just the worst point this round, and let the refit settle.
    aside = span > defectGap || n - arc.size < minPoints ? new Set([...aside, worst]) : arc;
    if (n - aside.size < minPoints) return null;
    const keep = all.filter((i) => !aside.has(i));
    circle = fitCircle2D(keep.map((i) => xs[i]), keep.map((i) => ys[i]));
  }
  return null;
}

/**
 * Whether the surface the cut went round runs straight along the axis.
 *
 * A finely cut sphere passes every other test: cut through a meridian, it is
 * a ring of facets whose edges along the cut are all parallel, on a perfect
 * circle. What gives it away is that those edges shrink to nothing towards
 * the poles, and all of them are short against the radius. So every
 * straight run round the ring must be at least `STRAIGHT_RATIO` of the
 * longest, or at least `STRAIGHT_RADII` radii long.
 *
 * - A sphere fails both: its polar runs are a small fraction of its
 *   equatorial ones, and all of them are a small fraction of its radius.
 * - A bend passes the first: its runs vary only between the inside and the
 *   outside of the bend, (R − r) against (R + r).
 * - A column with an opening or a notch passes the second: the runs beside
 *   the cut-out are shorter than the rest, but still long against the radius.
 * - A pipe end cut at an angle passes one or the other unless the pipe is
 *   barely longer than it is wide.
 *
 * Edge lengths settle it in almost every case. Only when they do not (rows
 * of different heights, a split edge, a cut-out) is each short edge followed
 * along its line to measure the straight run it belongs to.
 */
function runsStraight(
  geo: SnapGeometry,
  edges: ReadonlyArray<{ t: number; ia: number; ib: number; run: number }>,
  kept: readonly number[],
  axis: THREE.Vector3,
  origin: THREE.Vector3,
  slack: number,
  radius: number,
): boolean {
  // Every line is at least as long as the longest edge on the ring, so only
  // edges shorter than both bars need following — shortest first, and the
  // first one whose line stays short settles it. On a sphere that is the
  // first edge followed; on a cylinder with uneven rows or a cut-out, a few.
  let longest = 0;
  for (const i of kept) longest = Math.max(longest, edges[i].run);
  const needed = Math.min(STRAIGHT_RATIO * longest, STRAIGHT_RADII * radius);
  const short = kept.filter((i) => edges[i].run < needed).sort((p, q) => edges[p].run - edges[q].run);
  let budget = MAX_LINE_STEPS;
  for (const i of short) {
    const { t, ia, ib } = edges[i];
    const [from, to, steps] = extentOfLine(geo, t, ia, ib, axis, origin, slack, budget);
    budget -= steps;
    if (budget <= 0 || Math.abs(to - from) < needed) return false;
  }
  return true;
}

/**
 * +1 or −1: which way to turn `axis` so it points one fixed way — its
 * largest component positive. Not the first non-zero component, which
 * float noise can flip.
 */
function canonicalSign(axis: THREE.Vector3): number {
  return axis.dot(SIGN_REFERENCE) < 0 ? -1 : 1;
}

/**
 * A reference direction no building axis is likely to be square to, so the
 * sign it picks does not flip on float noise for the axes that matter —
 * unlike "the largest component", which ties for any 45° axis.
 */
const SIGN_REFERENCE = new THREE.Vector3(0.5477, 0.639, 0.5399).normalize();

/**
 * Two unit vectors square to `axis`, chosen the same way for every axis
 * near it. Like `basisAround`, but switching helper only near two oblique
 * directions rather than at 0.9 of the x axis, where a horizontal beam can
 * sit.
 */
function canonicalBasis(axis: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): void {
  const helper = Math.abs(axis.dot(BASIS_HELPER)) < 0.95 ? BASIS_HELPER : BASIS_HELPER_ALT;
  u.crossVectors(axis, helper).normalize();
  v.crossVectors(axis, u).normalize();
}

const BASIS_HELPER = new THREE.Vector3(0.2673, 0.5345, 0.8018).normalize();
const BASIS_HELPER_ALT = new THREE.Vector3(0.8018, -0.2673, 0.5345).normalize();

/**
 * Lookups for stepping across defects: which triangles use each corner, and
 * which corners sit within a small distance of a point. Built once per piece
 * the first time a cut meets an edge the mesh does not pair up.
 */
interface MeshIndex {
  trianglesNear(geo: SnapGeometry, corners: readonly number[], tolerance: number): number[];
}

function meshIndex(geo: SnapGeometry): MeshIndex | null {
  const cache = cachesFor(geo);
  if (cache.index !== undefined) return cache.index;

  const P = geo.positions;
  const T = geo.triangles;
  const cornerCount = P.length / 3;
  // Built once per piece and not counted against any one hover: it is shared,
  // and charging it to whichever hover built it made that hover's answer
  // depend on what had been hovered before. Bounded on its own terms instead
  // — a piece above INDEX_MAX_SIZE is never indexed, whoever asks, so its
  // defects are never stepped across and every hover on it agrees.
  if (T.length / 3 + cornerCount > INDEX_MAX_SIZE) {
    cache.index = null;
    return null;
  }

  // Triangles per corner, as offsets into one flat list.
  const start = new Uint32Array(cornerCount + 1);
  for (let k = 0; k < T.length; k++) start[T[k] + 1]++;
  for (let i = 0; i < cornerCount; i++) start[i + 1] += start[i];
  const fill = start.slice(0, cornerCount);
  const list = new Uint32Array(T.length);
  for (let k = 0; k < T.length; k++) list[fill[T[k]]++] = Math.floor(k / 3);

  // Corners bucketed on a grid sized by the piece's own shortest edges, not
  // its overall size: on a big or offset piece a cell a thousandth of the
  // whole swallowed a column's corners by the hundred, and a piece mixing a
  // fine column with coarse parts must be sized for the column. The 1st
  // percentile of a sample of edges, and never under INDEX_MIN_CELL, so
  // slivers do not shrink it below the gaps it must bridge.
  const lengths: number[] = [];
  const sampleStride = Math.max(1, Math.floor(T.length / 3 / 6000));
  for (let t = 0; t < T.length / 3; t += sampleStride) {
    for (let e = 0; e < 3; e++) {
      const i = T[t * 3 + e];
      const j = T[t * 3 + ((e + 1) % 3)];
      const d = Math.hypot(P[j * 3] - P[i * 3], P[j * 3 + 1] - P[i * 3 + 1], P[j * 3 + 2] - P[i * 3 + 2]);
      if (d > 0) lengths.push(d);
    }
  }
  lengths.sort((p, q) => p - q);
  const cell = Math.max(lengths[Math.floor(lengths.length * 0.01)] ?? 1, INDEX_MIN_CELL);
  const hash = (x: number, y: number, z: number) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;
  const grid = new Map<number, number[]>();
  for (let i = 0; i < cornerCount; i++) {
    const k = hash(Math.floor(P[i * 3] / cell), Math.floor(P[i * 3 + 1] / cell), Math.floor(P[i * 3 + 2] / cell));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }

  const index: MeshIndex = {
    trianglesNear(_geo, corners, tolerance) {
      // Within one cell of a corner — the reach is held to a cell, so the 27
      // cells round it are all that need looking at.
      const reach = Math.min(tolerance, cell);
      const found = new Set<number>();
      for (const c of corners) {
        const x = P[c * 3], y = P[c * 3 + 1], z = P[c * 3 + 2];
        const gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(hash(gx + dx, gy + dy, gz + dz));
          if (!bucket) continue;
          // Every corner looked at is a step, near or not.
          charge(bucket.length);
          for (const other of bucket) {
            const ox = P[other * 3] - x, oy = P[other * 3 + 1] - y, oz = P[other * 3 + 2] - z;
            if (ox * ox + oy * oy + oz * oz > reach * reach) continue;
            charge(start[other + 1] - start[other]);
            for (let k = start[other]; k < start[other + 1]; k++) found.add(list[k]);
          }
        }
      }
      return [...found].sort((p, q) => p - q);
    },
  };
  cache.index = index;
  return index;
}

/** Whether two triangles use the same three corners — a duplicate, either way round. */
function sameCorners(geo: SnapGeometry, s: number, t: number): boolean {
  const a = [geo.triangles[s * 3], geo.triangles[s * 3 + 1], geo.triangles[s * 3 + 2]].sort((p, q) => p - q);
  const b = [geo.triangles[t * 3], geo.triangles[t * 3 + 1], geo.triangles[t * 3 + 2]].sort((p, q) => p - q);
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function distanceToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = b.clone().sub(a);
  const lengthSq = ab.lengthSq();
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / lengthSq));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/**
 * Where an axis-parallel line through edge `ia`–`ib` of triangle `tri` ends,
 * in both directions: the edge is extended through each end while the next
 * edge carries on in the same direction. Also returns how many triangles
 * that looked at, so a caller can bound the total.
 */
function extentOfLine(
  geo: SnapGeometry,
  tri: number,
  ia: number,
  ib: number,
  axis: THREE.Vector3,
  origin: THREE.Vector3,
  slack: number,
  budget = MAX_LINE_STEPS,
): [number, number, number] {
  const p = new THREE.Vector3();
  const along = (vertex: number) => readPosition(geo, vertex, p).sub(origin).dot(axis);
  const ends: number[] = [];
  let used = 0;
  for (const [from, to] of [
    [ia, ib],
    [ib, ia],
  ]) {
    let previous = from;
    let current = to;
    let triangle = tri;
    const direction = Math.sign(along(to) - along(from));
    while (used < budget) {
      const visits = { count: 0 };
      const next = continueLine(geo, triangle, previous, current, axis, direction, slack, visits);
      used += visits.count;
      if (!next) break;
      previous = current;
      current = next.vertex;
      triangle = next.triangle;
    }
    ends.push(along(current));
  }
  return [ends[0], ends[1], used];
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
  visits: { count: number } = { count: 0 },
): { vertex: number; triangle: number } | null {
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  readPosition(geo, current, c);
  const seen = new Set<number>([start]);
  const queue = [start];
  for (let head = 0; head < queue.length && head < 64; head++) {
    charge(1);
    visits.count++;
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
): { fits: RoundFit[]; triangles: number[]; complete: boolean } {
  const patch = growCoplanarPatch(geo, seed);
  charge(patch.triangles.length);
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
  return { fits, triangles: patch.triangles, complete: patch.triangles.length < MAX_PATCH_TRIANGLES };
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
  const a = _a;
  const b = _b;
  const c = _c;
  readPosition(geo, geo.triangles[t * 3], a);
  readPosition(geo, geo.triangles[t * 3 + 1], b);
  readPosition(geo, geo.triangles[t * 3 + 2], c);
  return Math.max(sideways(a, b, axis), sideways(b, c, axis), sideways(c, a, axis));
}

/** Scratch for the small helpers below, which run per triangle on every step of a cut. */
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Roughly how far apart neighbouring float32 values are near `p`. */
function float32Spacing(p: THREE.Vector3): number {
  return Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z), 1) * FLOAT32_EPSILON;
}

function shortestEdge(geo: SnapGeometry, t: number): number {
  const a = _a;
  const b = _b;
  const c = _c;
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
