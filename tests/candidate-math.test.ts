/**
 * The pure maths the candidate system rests on.
 *
 * Two properties matter more than the arithmetic. First, the segment distance
 * must be *segment* distance, not infinite-line distance — a cursor well past
 * the end of a measurement must not pick it. Second, the ranking must be a
 * total order: `Tab` cycles by index, so two candidates that tie on every
 * field still have to land in a fixed position or the list reshuffles between
 * frames and `Tab` jumps somewhere the user did not aim.
 */
import { describe, it, expect } from 'vitest';
import {
  cycleIndex,
  distanceToSegment2D,
  rankCandidates,
  sameCandidates,
  type Candidate,
} from '../src/inspector/candidateMath';

function candidate(over: Partial<Candidate> & { id: string }): Candidate {
  return { kind: 'measurement', priority: 2, distance: 0, depth: 0, ...over };
}

describe('distanceToSegment2D', () => {
  it('measures perpendicular distance beside the segment', () => {
    expect(distanceToSegment2D({ x: 50, y: 10 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(10);
  });

  it('clamps to the endpoints rather than answering for the infinite line', () => {
    // Straight off the end of a horizontal segment: the infinite line would
    // say 0, which is exactly the false pick this guards against.
    expect(distanceToSegment2D({ x: 140, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(40);
    expect(distanceToSegment2D({ x: -30, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(30);
  });

  it('returns zero on the segment itself', () => {
    expect(distanceToSegment2D({ x: 40, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(0);
  });

  it('treats a zero-length segment as a point instead of dividing by zero', () => {
    // Two measurement points coincide if the user clicks the same spot twice.
    const d = distanceToSegment2D({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 });
    expect(d).toBe(5);
  });
});

describe('rankCandidates', () => {
  it('puts the lower priority first even when it is further from the cursor', () => {
    // D9: an element under the cursor beats a measurement drawn on top of it.
    const ranked = rankCandidates([
      candidate({ id: 'm', kind: 'measurement', priority: 2, distance: 0 }),
      candidate({ id: 'e', kind: 'element', priority: 1, distance: 7 }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(['e', 'm']);
  });

  it('orders same-priority candidates by screen distance', () => {
    const ranked = rankCandidates([
      candidate({ id: 'far', distance: 6 }),
      candidate({ id: 'near', distance: 1 }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(['near', 'far']);
  });

  it('breaks a distance tie by depth, then by id — a total order', () => {
    const ranked = rankCandidates([
      candidate({ id: 'b', distance: 3, depth: 10 }),
      candidate({ id: 'a', distance: 3, depth: 10 }),
      candidate({ id: 'c', distance: 3, depth: 2 }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('is stable across calls for the same input, so Tab cannot jitter', () => {
    const input = [
      candidate({ id: 'z', distance: 4, depth: 1 }),
      candidate({ id: 'y', distance: 4, depth: 1 }),
    ];
    expect(rankCandidates(input).map((c) => c.id)).toEqual(
      rankCandidates([...input].reverse()).map((c) => c.id),
    );
  });

  it('does not mutate the input array', () => {
    const input = [candidate({ id: 'b', distance: 9 }), candidate({ id: 'a', distance: 1 })];
    rankCandidates(input);
    expect(input.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('cycleIndex', () => {
  it('advances and wraps forward', () => {
    expect(cycleIndex(0, 3, 1)).toBe(1);
    expect(cycleIndex(2, 3, 1)).toBe(0);
  });

  it('wraps backward for Shift+Tab', () => {
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(1, 3, -1)).toBe(0);
  });

  it('returns 0 for an empty list so callers never index into nothing', () => {
    expect(cycleIndex(0, 0, 1)).toBe(0);
  });
});

describe('sameCandidates', () => {
  it('is true for the same ids in the same order', () => {
    const a = [candidate({ id: '1' }), candidate({ id: '2' })];
    const b = [candidate({ id: '1' }), candidate({ id: '2' })];
    expect(sameCandidates(a, b)).toBe(true);
  });

  it('is false when the order changes — the Tab offset would point elsewhere', () => {
    const a = [candidate({ id: '1' }), candidate({ id: '2' })];
    const b = [candidate({ id: '2' }), candidate({ id: '1' })];
    expect(sameCandidates(a, b)).toBe(false);
  });

  it('is false when the set grows or shrinks', () => {
    expect(sameCandidates([candidate({ id: '1' })], [])).toBe(false);
    expect(
      sameCandidates([candidate({ id: '1' })], [candidate({ id: '1' }), candidate({ id: '2' })]),
    ).toBe(false);
  });
});
