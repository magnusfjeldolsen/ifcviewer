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

  // A densely tessellated piece seen from afar puts hundreds of thousands of
  // corners inside the snap radius. Spreading them into one call overflowed
  // the stack, and the click that asked for them did nothing at all.
  it('orders a very large number of candidates without overflowing', () => {
    const many: Candidate[] = [];
    for (let i = 0; i < 300_000; i++) many.push(candidate('vertex', (i % 1000) / 100, `v${i}`));
    many.push(candidate('face', 0));

    const ranked = orderSnapCandidates(many);

    expect(ranked).toHaveLength(300_001);
    expect(ranked[ranked.length - 1].id).toBe('face:0');
  });

  // Issue #63. A round column is striped with facet edges; the one down its
  // middle is always about as near the cursor as the centre is.
  it('prefers a round centre to a facet edge in the same place', () => {
    expect(order(candidate('edge', 0), candidate('centre', 3), candidate('face', 0))[0]).toBe('centre');
  });

  it('still prefers an edge the cursor is on to a centre well away from it', () => {
    expect(order(candidate('edge', 0), candidate('centre', 10), candidate('face', 0))[0]).toBe('edge');
  });

  it('prefers a corner to a centre that coincides with it', () => {
    expect(order(candidate('centre', 0), candidate('vertex', 1))[0]).toBe('vertex');
  });

  it('keeps the surface and raw point after a centre', () => {
    expect(order(candidate('point', 0), candidate('face', 0), candidate('centre', 8))).toEqual([
      'centre',
      'face',
      'point',
    ]);
  });
});
