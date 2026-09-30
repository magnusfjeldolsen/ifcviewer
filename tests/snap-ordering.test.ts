import { describe, it, expect } from 'vitest';
import { orderSnapCandidates, SNAP_KIND, SNAP_PRIORITY, SNAP_TIE_PX } from '../src/tools/snapCandidates';
import type { Candidate } from '../src/inspector/candidateMath';
import type { SnapTarget } from '../src/tools/snapCandidates';

/**
 * Which snap wins when several are under the cursor.
 *
 * Priority alone is too blunt: it would let a corner 11 px away beat the edge
 * the cursor is sitting exactly on. Distance alone is too blunt the other way:
 * a corner and the edge it terminates are always within a pixel or two of each
 * other, and there the corner is what someone means.
 */

function candidate(target: SnapTarget, distance: number, id = `${target}:${distance}`): Candidate {
  return {
    kind: SNAP_KIND,
    priority: SNAP_PRIORITY[target],
    distance,
    depth: 10,
    id,
    payload: { target },
  };
}

function order(...candidates: Candidate[]): SnapTarget[] {
  return orderSnapCandidates(candidates).map((c) => (c.payload as { target: SnapTarget }).target);
}

describe('orderSnapCandidates', () => {
  it('prefers a corner to an edge when they are within a few pixels', () => {
    // A corner and the edge it terminates: pointing at one means the corner.
    expect(order(candidate('edge', 0), candidate('vertex', 2), candidate('face', 0))[0]).toBe(
      'vertex',
    );
  });

  // The bug this exists for.
  it('prefers an edge the cursor is on to a corner well away from it', () => {
    expect(order(candidate('edge', 0), candidate('vertex', 11), candidate('face', 0))[0]).toBe(
      'edge',
    );
  });

  it('takes the tie tolerance as the boundary', () => {
    const inside = order(candidate('edge', 0), candidate('vertex', SNAP_TIE_PX - 0.01));
    const outside = order(candidate('edge', 0), candidate('vertex', SNAP_TIE_PX + 0.01));

    expect(inside[0]).toBe('vertex');
    expect(outside[0]).toBe('edge');
  });

  // Face and point are reported at distance zero because the cursor is on
  // them by definition. They must not therefore beat a feature 1 px away.
  it('never lets the surface outrank a feature just for being underfoot', () => {
    expect(order(candidate('face', 0), candidate('vertex', 9))[0]).toBe('vertex');
    expect(order(candidate('face', 0), candidate('edge', 9))[0]).toBe('edge');
  });

  it('falls back to the surface when no feature is in range', () => {
    expect(order(candidate('face', 0), candidate('point', 0))).toEqual(['face', 'point']);
  });

  it('always ends with the raw point, so the escape hatch is the last stop', () => {
    const ranked = order(
      candidate('point', 0),
      candidate('face', 0),
      candidate('edge', 1),
      candidate('vertex', 2),
    );

    expect(ranked[ranked.length - 1]).toBe('point');
  });

  it('orders the runners-up by how close they are', () => {
    const ranked = order(
      candidate('edge', 8, 'far'),
      candidate('edge', 1, 'near'),
      candidate('vertex', 9, 'corner'),
    );

    expect(ranked.slice(0, 2)).toEqual(['edge', 'edge']);
    expect(orderSnapCandidates([
      candidate('edge', 8, 'far'),
      candidate('edge', 1, 'near'),
    ])[0].id).toBe('near');
  });

  it('is stable for identical candidates, so Tab does not jump between frames', () => {
    const a = candidate('edge', 3, 'a');
    const b = candidate('edge', 3, 'b');

    expect(orderSnapCandidates([b, a]).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('handles an empty list', () => {
    expect(orderSnapCandidates([])).toEqual([]);
  });
});
