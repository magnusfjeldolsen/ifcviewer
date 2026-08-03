/**
 * Unit tests for the pure select-similar query layer.
 *
 * The gating rules matter more than the happy path: an offered query that
 * can't match anything is worse than no offer at all, and a query built with
 * the wrong scope silently selects the wrong set.
 */

import { describe, it, expect } from 'vitest';
import {
  canSelectSimilar,
  classQuery,
  describeSimilarResult,
  identitiesFromIds,
  valueQuery,
} from '../src/inspector/selectSimilar';
import type { ElementIdentity, PropertyValue } from '../src/inspector/types';
import appSrc from '../src/core/App.ts?raw';

function identity(over: Partial<ElementIdentity> = {}): ElementIdentity {
  return {
    modelId: 'model-a',
    expressId: 42,
    ifcClass: 'IfcBeam',
    ifcTypeCode: 1234,
    ...over,
  };
}

function single(value: string | number | boolean | null): PropertyValue {
  return { kind: 'single', value, raw: { typeCode: 0, value } };
}

const row = {
  path: 'Pset_BeamCommon.Reference',
  name: 'Reference',
  rawValue: single('B12'),
  displayValue: 'B12',
};

describe('canSelectSimilar', () => {
  it('accepts a matchable value with a path', () => {
    expect(canSelectSimilar(row)).toBe(true);
  });

  it('rejects a row with no path — nothing to match against in other elements', () => {
    expect(canSelectSimilar({ path: '', rawValue: single('B12') })).toBe(false);
  });

  it('rejects unmatchable values', () => {
    expect(canSelectSimilar({ path: 'A.B', rawValue: single(null) })).toBe(false);
    expect(canSelectSimilar({ path: 'A.B', rawValue: { kind: 'varies' } })).toBe(false);
    expect(
      canSelectSimilar({
        path: 'A.B',
        rawValue: { kind: 'quantity', quantityKind: 'volume', value: 2.34 },
      }),
    ).toBe(false);
  });
});

describe('classQuery', () => {
  it('scopes to the elementic class and model', () => {
    const q = classQuery(identity());
    expect(q).toMatchObject({
      kind: 'class',
      modelId: 'model-a',
      ifcClass: 'IfcBeam',
      ifcTypeCode: 1234,
    });
    expect(q.label).toContain('IfcBeam');
  });

  it('degrades to a readable label when the class is unknown', () => {
    expect(classQuery(identity({ ifcClass: '' })).label).toBe('all elements');
  });
});

describe('valueQuery', () => {
  it('builds a value match scoped to the source model and class', () => {
    const q = valueQuery(identity(), row);
    expect(q).toMatchObject({
      kind: 'value',
      modelId: 'model-a',
      ifcClass: 'IfcBeam',
      selector: { path: 'Pset_BeamCommon.Reference' },
      value: single('B12'),
    });
    expect(q!.label).toBe('Reference = B12');
  });

  it('returns null rather than an unmatchable query', () => {
    expect(valueQuery(identity(), { ...row, rawValue: single(null) })).toBeNull();
    expect(valueQuery(identity(), { ...row, rawValue: { kind: 'varies' } })).toBeNull();
  });

  it('labels an empty display value without pretending it is blank', () => {
    const q = valueQuery(identity(), { ...row, displayValue: '' });
    expect(q!.label).toBe('Reference = —');
  });
});

describe('identitiesFromIds', () => {
  it('carries the queried class onto every match', () => {
    // The matches all came from that class, so unlike the marquee path we
    // don't have to leave class/type blank for a later fetch to fill in.
    const ids = identitiesFromIds(classQuery(identity()), [1, 2, 3]);
    expect(ids).toEqual([
      { modelId: 'model-a', expressId: 1, ifcClass: 'IfcBeam', ifcTypeCode: 1234 },
      { modelId: 'model-a', expressId: 2, ifcClass: 'IfcBeam', ifcTypeCode: 1234 },
      { modelId: 'model-a', expressId: 3, ifcClass: 'IfcBeam', ifcTypeCode: 1234 },
    ]);
  });

  it('maps an empty result to an empty selection', () => {
    expect(identitiesFromIds(classQuery(identity()), [])).toEqual([]);
  });
});

describe('describeSimilarResult', () => {
  it('reports a miss distinctly from a hit', () => {
    const q = valueQuery(identity(), row)!;
    expect(describeSimilarResult(q, 0)).toBe('No elements match Reference = B12');
    expect(describeSimilarResult(q, 1)).toBe('Selected 1 element — Reference = B12');
    expect(describeSimilarResult(q, 12)).toBe('Selected 12 elements — Reference = B12');
  });
});

/**
 * App wiring. App isn't mountable in a unit test (WebGL + worker), so the
 * properties a refactor could silently drop are asserted at the source level,
 * following the convention in `context-menu.test.ts`.
 */
describe('App select-similar wiring (source assertions)', () => {
  const runner = (): string => {
    const m = appSrc.match(/private async runSelectSimilar\([\s\S]*?\n {2}\}/);
    expect(m).not.toBeNull();
    return m![0];
  };

  it('cancels in-flight bulk work before starting', () => {
    // Otherwise the new query queues behind whatever the inspector was
    // already reducing, and the user waits for a result nobody wants.
    const body = runner();
    const beforeAwait = body.split('await')[0];
    expect(beforeAwait).toMatch(/cancelBulk\(\)/);
  });

  it('applies the result through selectExactly — one undo step for the whole set', () => {
    expect(runner()).toMatch(/selectExactly\(/);
  });

  it('routes the class preset to enumerateExpressIds and a value match to findMatching', () => {
    const body = runner();
    expect(body).toMatch(/enumerateExpressIds\(/);
    expect(body).toMatch(/findMatching\(/);
  });

  it('treats a cancelled query as a non-event, not an error', () => {
    expect(runner()).toMatch(/BulkRequestCancelled/);
  });

  it('is wired into the inspector panel', () => {
    expect(appSrc).toMatch(/onSelectSimilar:\s*\(query\)\s*=>/);
  });
});
