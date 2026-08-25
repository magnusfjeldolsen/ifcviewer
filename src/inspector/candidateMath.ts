/**
 * Pure maths behind the candidate system.
 *
 * `CandidateResolver` owns the providers and the cycle state; everything here
 * is side-effect free so it can be unit-tested without a WebGL context. The
 * split mirrors `orbitMath.ts` / `Viewer.ts` and `PivotState.ts`.
 *
 * Phase 1 (measurement picking) uses all of it. Phase 3 (snapping) registers
 * another provider and reuses the same ranking and cycling.
 */

/** A point in CSS pixels, relative to the canvas's top-left corner. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * One thing the cursor could act on. Providers produce these; the resolver
 * ranks them.
 *
 * Deliberately open on `kind` and `payload` so a new provider (snap points,
 * in Phase 3) needs no change here.
 */
export interface Candidate {
  /** Provider kind — `'element'`, `'measurement'`, later `'snap'`. */
  kind: string;
  /**
   * Lower wins. Elements are 1 and measurements 2, so an element under the
   * cursor always outranks the annotation drawn over it (D9: "elements win
   * ties"); `Tab` is the escape hatch to the measurement.
   */
  priority: number;
  /** Distance from the cursor in CSS pixels. 0 for a direct raycast hit. */
  distance: number;
  /** Distance from the camera, for a stable tiebreak within one kind. */
  depth: number;
  /** Unique within one resolve pass. The final tiebreak, and the cycle key. */
  id: string;
  /** Provider-owned payload (a raycast intersection, a measurement record…). */
  payload?: unknown;
}

/**
 * Shortest distance in pixels from `p` to the segment `a`–`b`.
 *
 * Clamped to the segment, not the infinite line: a cursor well past the end of
 * a measurement must not pick it just because it is aligned with it. A
 * zero-length segment degrades to point distance rather than dividing by zero
 * (two measurement points can coincide if the user double-clicks one spot).
 */
export function distanceToSegment2D(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;

  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);

  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/**
 * Rank candidates for the cursor: kind priority first, then how close they
 * are, then how near the camera, then id.
 *
 * The id tiebreak is not cosmetic. `Tab` cycles by index, so two candidates
 * that compare equal on every other field must still land in a fixed order —
 * otherwise the list reshuffles between frames and `Tab` jumps somewhere the
 * user did not expect. Returns a new array; the input is left alone.
 */
export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Step `index` by `step` places around a list of `length`, wrapping both ways.
 * Returns 0 for an empty list so callers never index into nothing.
 */
export function cycleIndex(index: number, length: number, step: number): number {
  if (length <= 0) return 0;
  return (((index + step) % length) + length) % length;
}

/**
 * Do two ranked lists refer to the same things, in the same order?
 *
 * The resolver keeps the user's `Tab` position only while this holds. Once the
 * candidate set changes the offset is meaningless — index 2 of the old list is
 * not index 2 of the new one — so it resets.
 */
export function sameCandidates(a: readonly Candidate[], b: readonly Candidate[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}
