import { describe, it, expect } from 'vitest';
import {
  boxesMatch,
  cameraPoses,
  classifyArea,
  compareSignatures,
  pixelVerdict,
  type ElementSignature,
  type Signature,
} from '../bench/compareLogic.mjs';

const element = (over: Partial<ElementSignature> = {}): ElementSignature => ({
  pieces: 2,
  tris: 24,
  verts: 16,
  area: 10,
  box: [0, 0, 0, 1, 1, 1],
  colors: '0.5,0.5,0.5,1|0.5,0.5,0.5,1',
  ...over,
});

const signature = (elements: Record<string, ElementSignature>): Signature => ({
  models: [
    {
      pieces: 0,
      elementCount: Object.keys(elements).length,
      tris: 0,
      verts: 0,
      emptyPieces: 0,
      elements,
    },
  ],
  sceneBox: { min: [0, 0, 0], max: [1, 1, 1] },
});

describe('classifyArea', () => {
  it('calls equal areas the same', () => {
    expect(classifyArea(12.5, 12.5)).toBe('same');
    expect(classifyArea(0, 0)).toBe('same');
  });

  it('reports a difference below a relative 1e-3 as rounding only', () => {
    expect(classifyArea(100, 100.05)).toBe('rounding');
  });

  it('reports a difference of 1e-3 or more as different', () => {
    expect(classifyArea(100, 100.2)).toBe('different');
    expect(classifyArea(0, 5)).toBe('different');
  });
});

describe('boxesMatch', () => {
  it('accepts boxes within the tolerance and rejects beyond it', () => {
    expect(boxesMatch([0, 0, 0, 1, 1, 1], [0.0005, 0, 0, 1, 1, 1])).toBe(true);
    expect(boxesMatch([0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1.01, 1])).toBe(false);
  });

  it('matches two empty boxes but not an empty one against a real one', () => {
    const empty = [null, null, null, null, null, null];
    expect(boxesMatch(empty, [...empty])).toBe(true);
    expect(boxesMatch(empty, [0, 0, 0, 1, 1, 1])).toBe(false);
  });
});

describe('compareSignatures', () => {
  it('counts identical elements and passes', () => {
    const r = compareSignatures(signature({ '1': element(), '2': element() }), signature({ '1': element(), '2': element() }));
    expect(r.identical).toBe(true);
    expect(r.summary.perModel[0].elementsIdentical).toBe(2);
    expect(r.differences).toEqual([]);
  });

  it('keeps rounding-only elements apart and does not fail on them', () => {
    const r = compareSignatures(signature({ '1': element({ area: 100 }) }), signature({ '1': element({ area: 100.05 }) }));
    expect(r.identical).toBe(true);
    expect(r.roundingOnly).toHaveLength(1);
    expect(r.summary.perModel[0]).toMatchObject({ elementsIdentical: 0, elementsRoundingOnly: 1, elementsDifferent: 0 });
  });

  it('reports a missing element, naming the side that has it', () => {
    const r = compareSignatures(signature({ '1': element(), '2': element() }), signature({ '1': element() }));
    expect(r.identical).toBe(false);
    expect(r.differences).toEqual(['#2: only in A']);
  });

  it('reports a doubled piece through piece, triangle and vertex counts', () => {
    const r = compareSignatures(
      signature({ '7': element() }),
      signature({ '7': element({ pieces: 4, tris: 48, verts: 32 }) }),
    );
    expect(r.identical).toBe(false);
    expect(r.differences[0]).toContain('pieces 2 vs 4');
    expect(r.differences[0]).toContain('tris 24 vs 48');
    expect(r.differences[0]).toContain('verts 16 vs 32');
  });

  it('reports a colour or opacity change', () => {
    const r = compareSignatures(
      signature({ '1': element() }),
      signature({ '1': element({ colors: '0.5,0.5,0.5,0.4|0.5,0.5,0.5,0.4' }) }),
    );
    expect(r.differences[0]).toContain('colour/opacity');
  });

  it('reports a real area change even when the rest matches', () => {
    const r = compareSignatures(signature({ '1': element({ area: 10 }) }), signature({ '1': element({ area: 11 }) }));
    expect(r.identical).toBe(false);
    expect(r.differences[0]).toContain('area 10 vs 11');
  });

  it('reports a different scene box and a different model count', () => {
    const a = signature({ '1': element() });
    const b = { ...signature({ '1': element() }), sceneBox: { min: [0, 0, 0], max: [2, 1, 1] } };
    expect(compareSignatures(a, b).differences).toHaveLength(1);
    expect(compareSignatures(a, { ...a, models: [] }).identical).toBe(false);
  });
});

describe('pixelVerdict', () => {
  it('passes a small share of differing pixels and fails a large one', () => {
    expect(pixelVerdict(0.01)).toBe('same');
    expect(pixelVerdict(3)).toBe('different');
  });

  it('never calls a missing measurement the same', () => {
    expect(pixelVerdict(NaN)).toBe('different');
  });
});

describe('cameraPoses', () => {
  it('gives three poses that all look at the centre of the box', () => {
    const poses = cameraPoses({ min: [0, 0, 0], max: [10, 4, 6] });
    expect(poses).toHaveLength(3);
    for (const p of poses) expect(p.target).toEqual([5, 2, 3]);
  });
});
