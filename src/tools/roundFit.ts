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
 * The widest single gap a ring may have from a local defect (an opening, a
 * notch, a dent), in degrees. See `judgeRing` for the conditions.
 */
const DEFECT_GAP_DEG = 90;

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
  /**
   * How far each fitted cylinder runs along its axis, keyed by the cylinder
   * itself (axis line and radius), so every triangle on it gets the same
   * answer whichever was hovered first.
   */
  extent: Map<string, [number, number]>;
  /** Corner and triangle lookups for stepping across mesh defects; built on first need. */
  index?: MeshIndex;
}

const caches = new WeakMap<SnapGeometry, RoundCaches>();

function cachesFor(geo: SnapGeometry): RoundCaches {
  let cache = caches.get(geo);
  if (!cache) {
    cache = { side: new Map(), outline: new Map(), extent: new Map() };
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
export function roundFitsAt(geo: SnapGeometry, triangle: number): RoundFit[] {
  if (triangle < 0 || triangle >= geo.triangles.length / 3) return [];
  const cache = cachesFor(geo);

  let side = cache.side.get(triangle);
  if (side === undefined) {
    side = fitCurvedSide(geo, triangle).fit;
    cache.side.set(triangle, side);
  }

  let outline = cache.outline.get(triangle);
  if (outline === undefined) {
    const found = fitFlatOutlines(geo, triangle);
    if (found.complete) for (const t of found.triangles) cache.outline.set(t, found.fits);
    cache.outline.set(triangle, found.fits);
    outline = found.fits;
  }

  return side ? [side, ...outline] : outline;
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
    const exitPoint = crossing(t, exit, new THREE.Vector3()).add(origin);
    readNormal(geo, t, n);
    let best: { next: number; entry: number; flat: number } | null = null;
    for (const candidate of index.trianglesNear(geo, [ia, ib], gapTolerance)) {
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

  const judged = judgeRing(xs, ys, slack);
  if (!judged) return rejected;
  const { circle, kept } = judged;

  if (!runsStraight(geo, edges, kept, axis, origin, slack, circle.r)) return rejected;

  // The point on the axis level with `origin`, and the run of the whole
  // cylinder along it.
  const base = origin.clone().addScaledVector(u, circle.cx).addScaledVector(v, circle.cy);
  const [from, to] = cylinderExtent(geo, base, axis, circle.r, slack);
  const offset = base.dot(axis);
  const centre = base.addScaledVector(axis, (from + to) / 2 - offset);
  return {
    fit: { centre, axis: axis.clone(), radius: circle.r, halfLength: (to - from) / 2, slides: true },
    ring,
  };
}

/**
 * Whether the points a cut collected lie on a circle, allowing for one local
 * defect. Returns the circle and which points it kept.
 *
 * A clean ring passes `isRound` as it is. Otherwise the defect rule: up to
 * one point in six may be set aside — always the one furthest off the circle,
 * refitting after each — and the ring may have one gap of up to
 * `DEFECT_GAP_DEG`, provided
 *
 * - every other gap is still no wider than one facet (`MAX_FACET_DEG`),
 * - every set-aside point lies inside that one gap, so the defect is local
 *   and the rest of the ring is untouched,
 * - at least `360 / MAX_FACET_DEG` points remain, all on the circle.
 *
 * That admits a column with an opening, a notch or a dented corner on one
 * side, and keeps out what the rule was written against: an open arc (its
 * gap is the rest of the circle), a hexagon (several 60° gaps), a rounded
 * rectangle (its error is spread round the whole outline, not in one place)
 * and an I-section's fillet (a quarter circle).
 */
export function judgeRing(
  xs: readonly number[],
  ys: readonly number[],
  slack = 0,
): { circle: Circle2D; kept: number[] } | null {
  const minPoints = Math.ceil(360 / MAX_FACET_DEG);
  if (xs.length < minPoints) return null;
  const all = xs.map((_, i) => i);
  const whole = fitCircle2D(xs, ys);
  if (isRound(whole, MAX_FACET_DEG, slack)) return { circle: whole, kept: all };

  const maxDrop = Math.floor(xs.length / 6);
  let kept = all;
  const dropped: number[] = [];
  for (let round = 0; round <= maxDrop && kept.length >= minPoints; round++) {
    const circle = fitCircle2D(kept.map((i) => xs[i]), kept.map((i) => ys[i]));
    if (!circle) return null;
    const angleOf = (i: number) => Math.atan2(ys[i] - circle.cy, xs[i] - circle.cx);
    const angles = kept.map(angleOf).sort((p, q) => p - q);
    const gaps: Array<{ from: number; size: number }> = [];
    for (let k = 0; k < angles.length; k++) {
      const next = k + 1 < angles.length ? angles[k + 1] : angles[0] + 2 * Math.PI;
      gaps.push({ from: angles[k], size: next - angles[k] });
    }
    gaps.sort((p, q) => q.size - p.size);
    const widest = gaps[0];
    const second = gaps.length > 1 ? gaps[1].size : 0;
    const inWidest = (i: number) => {
      let d = angleOf(i) - widest.from;
      while (d < 0) d += 2 * Math.PI;
      while (d >= 2 * Math.PI) d -= 2 * Math.PI;
      return d < widest.size;
    };
    const facet = ((MAX_FACET_DEG + FACET_SLACK_DEG) * Math.PI) / 180;
    if (
      circle.residual * circle.r <= ROUND_TOLERANCE * circle.r + slack &&
      widest.size <= ((DEFECT_GAP_DEG + FACET_SLACK_DEG) * Math.PI) / 180 &&
      second <= facet &&
      dropped.every(inWidest)
    ) {
      return { circle, kept };
    }
    // Set aside the point furthest off this circle and try again.
    let worst = -1;
    let worstOff = -1;
    for (const i of kept) {
      const off = Math.abs(Math.hypot(xs[i] - circle.cx, ys[i] - circle.cy) - circle.r);
      if (off > worstOff) {
        worstOff = off;
        worst = i;
      }
    }
    dropped.push(worst);
    kept = kept.filter((i) => i !== worst);
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
 * How far a cylinder runs along its axis, as positions along `axis` measured
 * from the coordinate origin: every edge of the piece that lies on the
 * cylinder and runs along its axis counts. Cached per cylinder, so the slide
 * range is the same whichever triangle of it is under the cursor — on a pipe
 * cut off at an angle, the long side and the short side agree.
 */
function cylinderExtent(
  geo: SnapGeometry,
  base: THREE.Vector3,
  axis: THREE.Vector3,
  radius: number,
  slack: number,
): [number, number] {
  // Measured along the axis pointed one fixed way, so the cache holds one
  // answer per cylinder; flipped back for a caller whose axis points the
  // other way.
  const flip = canonicalSign(axis);
  const forCaller = ([from, to]: [number, number]): [number, number] => (flip > 0 ? [from, to] : [-to, -from]);
  const cache = cachesFor(geo);
  const key = cylinderKey(base, axis, radius, slack);
  const known = cache.extent.get(key);
  if (known) return forCaller(known);

  const ax = axis.x * flip, ay = axis.y * flip, az = axis.z * flip;
  const bx = base.x, by = base.y, bz = base.z;
  const onSurface = ROUND_TOLERANCE * radius + slack;
  const P = geo.positions;
  const T = geo.triangles;
  // Distance of corner `i` from the axis line, and its position along it.
  const radial = (i: number): number => {
    const dx = P[i * 3] - bx, dy = P[i * 3 + 1] - by, dz = P[i * 3 + 2] - bz;
    const s = dx * ax + dy * ay + dz * az;
    return Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - s * s));
  };
  const alongOf = (i: number) => P[i * 3] * ax + P[i * 3 + 1] * ay + P[i * 3 + 2] * az;

  let from = Infinity;
  let to = -Infinity;
  for (let k = 0; k < T.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const i = T[k + e];
      const j = T[k + ((e + 1) % 3)];
      if (i > j) continue; // each edge once from either side
      if (Math.abs(radial(i) - radius) > onSurface || Math.abs(radial(j) - radius) > onSurface) continue;
      const dx = P[j * 3] - P[i * 3], dy = P[j * 3 + 1] - P[i * 3 + 1], dz = P[j * 3 + 2] - P[i * 3 + 2];
      const ds = dx * ax + dy * ay + dz * az;
      const side = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - ds * ds));
      if (ds === 0 || side > PARALLEL_FRACTION * Math.abs(ds) + slack) continue;
      const si = alongOf(i);
      const sj = alongOf(j);
      from = Math.min(from, si, sj);
      to = Math.max(to, si, sj);
    }
  }
  if (!(to >= from)) {
    const s = base.x * ax + base.y * ay + base.z * az;
    from = s;
    to = s;
  }
  const extent: [number, number] = [from, to];
  cache.extent.set(key, extent);
  return forCaller(extent);
}

/**
 * +1 or −1: which way to turn `axis` so it points one fixed way — its
 * largest component positive. Not the first non-zero component, which
 * float noise can flip.
 */
function canonicalSign(axis: THREE.Vector3): number {
  const ax = Math.abs(axis.x), ay = Math.abs(axis.y), az = Math.abs(axis.z);
  const largest = ax >= ay && ax >= az ? axis.x : ay >= az ? axis.y : axis.z;
  return largest < 0 ? -1 : 1;
}

/** A name for a cylinder: its axis line (by the point nearest the origin) and radius, rounded. */
function cylinderKey(base: THREE.Vector3, axis: THREE.Vector3, radius: number, slack: number): string {
  // Point the axis one fixed way, so a cylinder found from either end agrees.
  const a = axis.clone().multiplyScalar(canonicalSign(axis));
  const nearest = base.clone().addScaledVector(a, -base.dot(a));
  const step = Math.max(radius * 1e-3, slack * 4);
  const q = (x: number) => Math.round(x / step);
  const qa = (x: number) => Math.round(x * 1e4);
  return [q(nearest.x), q(nearest.y), q(nearest.z), qa(a.x), qa(a.y), qa(a.z), q(radius)].join(',');
}

/**
 * Lookups for stepping across defects: which triangles use each corner, and
 * which corners sit within a small distance of a point. Built once per piece
 * the first time a cut meets an edge the mesh does not pair up.
 */
interface MeshIndex {
  trianglesNear(geo: SnapGeometry, corners: readonly number[], tolerance: number): number[];
}

function meshIndex(geo: SnapGeometry): MeshIndex {
  const cache = cachesFor(geo);
  if (cache.index) return cache.index;

  const P = geo.positions;
  const T = geo.triangles;
  const cornerCount = P.length / 3;

  // Triangles per corner, as offsets into one flat list.
  const start = new Uint32Array(cornerCount + 1);
  for (let k = 0; k < T.length; k++) start[T[k] + 1]++;
  for (let i = 0; i < cornerCount; i++) start[i + 1] += start[i];
  const fill = start.slice(0, cornerCount);
  const list = new Uint32Array(T.length);
  for (let k = 0; k < T.length; k++) list[fill[T[k]]++] = Math.floor(k / 3);

  // Corners bucketed on a grid a little coarser than any gap worth bridging.
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < P.length; k++) {
    lo = Math.min(lo, P[k]);
    hi = Math.max(hi, P[k]);
  }
  const cell = Math.max((hi - lo) * 1e-3, 1e-6);
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < cornerCount; i++) {
    const k = key(Math.floor(P[i * 3] / cell), Math.floor(P[i * 3 + 1] / cell), Math.floor(P[i * 3 + 2] / cell));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }

  const index: MeshIndex = {
    trianglesNear(_geo, corners, tolerance) {
      const reach = Math.min(tolerance, cell);
      const found = new Set<number>();
      for (const c of corners) {
        const x = P[c * 3], y = P[c * 3 + 1], z = P[c * 3 + 2];
        const gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          for (const other of grid.get(key(gx + dx, gy + dy, gz + dz)) ?? []) {
            const ox = P[other * 3] - x, oy = P[other * 3 + 1] - y, oz = P[other * 3 + 2] - z;
            if (ox * ox + oy * oy + oz * oz > reach * reach) continue;
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
 * edge carries on in the same direction. Also returns how many steps that
 * took, so a caller can bound the total.
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
    for (; used < budget; used++) {
      const next = continueLine(geo, triangle, previous, current, axis, direction, slack);
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
): { fits: RoundFit[]; triangles: number[]; complete: boolean } {
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
