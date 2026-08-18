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
  categoryMenuLabel,
  categoryQuery,
  describeSimilarResult,
  identitiesFromIds,
  sharedSource,
  typeLabel,
  typeMenuLabel,
  typeQuery,
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

describe('sharedSource', () => {
  it('resolves a single element to itself', () => {
    expect(sharedSource([identity()])).toMatchObject({
      modelId: 'model-a',
      ifcClass: 'IfcBeam',
      ifcTypeCode: 1234,
    });
  });

  it('resolves a multi-selection to what its members agree on', () => {
    // Two floors of different types still share a category. Dropping the
    // whole offer because they differ on ONE field would refuse a question
    // that has a perfectly good answer.
    const a = identity({ expressId: 1, predefinedType: 'FLOOR', typeName: 'Betong 300' });
    const b = identity({ expressId: 2, predefinedType: 'FLOOR', typeName: 'Betong 500' });
    const shared = sharedSource([a, b])!;
    expect(shared.predefinedType).toBe('FLOOR');
    expect(shared.typeName).toBeUndefined();
    expect(categoryQuery(shared).label).toBe('all IfcBeam · FLOOR');
    expect(typeQuery(shared)).toBeNull();
  });

  it('keeps the type when every member shares it', () => {
    const t = { typeName: 'SHS100x6.3' };
    const shared = sharedSource([identity({ expressId: 1, ...t }), identity({ expressId: 2, ...t })])!;
    expect(typeLabel(shared)).toBe('SHS100x6.3');
  });

  it('refuses a selection spanning classes or models', () => {
    expect(sharedSource([identity(), identity({ ifcClass: 'IfcColumn', ifcTypeCode: 99 })])).toBeNull();
    expect(sharedSource([identity(), identity({ modelId: 'model-b' })])).toBeNull();
  });

  it('refuses placeholder identities and an empty selection', () => {
    // SelectionManager's placeholder is { ifcClass: '', ifcTypeCode: 0 } —
    // a query built from it enumerates nothing, which is how "No elements
    // match all elements" happened.
    expect(sharedSource([])).toBeNull();
    expect(sharedSource([{ modelId: 'model-a', expressId: 1, ifcClass: '', ifcTypeCode: 0 }])).toBeNull();
    expect(sharedSource([identity({ ifcTypeCode: 0 })])).toBeNull();
  });
});

describe('categoryQuery', () => {
  it('scopes to the element class and model', () => {
    const q = categoryQuery(identity());
    expect(q).toMatchObject({
      kind: 'class',
      modelId: 'model-a',
      ifcClass: 'IfcBeam',
      ifcTypeCode: 1234,
    });
    expect(q.label).toContain('IfcBeam');
  });

  it('degrades to a readable label when the class is unknown', () => {
    expect(categoryQuery(identity({ ifcClass: '' })).label).toBe('all elements');
  });

  it('narrows by PredefinedType when the element has one', () => {
    // A Revit floor and a Revit structural foundation are BOTH IfcSlab,
    // separated only by PredefinedType. Selecting a foundation and getting
    // every floor slab in the model is not what "select all of this kind"
    // means to anyone.
    const q = categoryQuery(identity({ ifcClass: 'IfcSlab', predefinedType: 'BASESLAB' }));
    expect(q.kind).toBe('value');
    if (q.kind === 'value') {
      expect(q.selector.path).toBe('Identity.PredefinedType');
      expect(q.value).toEqual({
        kind: 'single',
        value: 'BASESLAB',
        raw: { typeCode: 0, value: 'BASESLAB' },
      });
      // Still scoped to the class — PredefinedType only discriminates
      // within it.
      expect(q.ifcTypeCode).toBe(1234);
    }
    expect(q.label).toBe('all IfcSlab · BASESLAB');
  });
});

describe('typeQuery', () => {
  const beam = identity({ typeName: 'SHS (EN 10210-2):SHS100x6.3' });

  it('matches the linked type object, scoped to the class', () => {
    const q = typeQuery(beam)!;
    expect(q.kind).toBe('value');
    if (q.kind === 'value') {
      expect(q.selector.path).toBe('Identity.Type');
      expect(q.value).toEqual({
        kind: 'single',
        value: 'SHS (EN 10210-2):SHS100x6.3',
        raw: { typeCode: 0, value: 'SHS (EN 10210-2):SHS100x6.3' },
      });
      expect(q.ifcTypeCode).toBe(1234);
    }
  });

  it('prefers the type object over ObjectType when both exist', () => {
    // RIB.ifc carries both and they agree; Snowdon carries only the type
    // object. Preferring it means one path works everywhere measured.
    const both = identity({ typeName: 'FromTypeObject', objectType: 'FromObjectType' });
    const q = typeQuery(both)!;
    expect(q.kind === 'value' && q.selector.path).toBe('Identity.Type');
    expect(typeLabel(both)).toBe('FromTypeObject');
  });

  it('falls back to ObjectType when there is no type object', () => {
    const q = typeQuery(identity({ objectType: 'FromObjectType' }))!;
    expect(q.kind === 'value' && q.selector.path).toBe('Identity.ObjectType');
  });

  it('is not offered when the element declares neither', () => {
    // An option that can only ever find nothing is worse than no option.
    expect(typeQuery(identity())).toBeNull();
    expect(typeQuery(identity({ objectType: '', typeName: '' }))).toBeNull();
  });

  it('is a strictly narrower question than the category', () => {
    const cat = categoryQuery(beam);
    const type = typeQuery(beam)!;
    expect(cat.label).toBe('all IfcBeam');
    expect(type.label).toBe('all SHS (EN 10210-2):SHS100x6.3');
  });
});

describe('menu labels', () => {
  it('name the value so the row says what it will do', () => {
    const beam = identity({ typeName: 'SHS100x6.3' });
    expect(categoryMenuLabel(beam)).toBe('Select all of this category · IfcBeam');
    expect(typeMenuLabel(beam)).toBe('Select all of this type · SHS100x6.3');
  });

  it('include PredefinedType in the category when present', () => {
    const slab = identity({ ifcClass: 'IfcSlab', predefinedType: 'BASESLAB' });
    expect(categoryMenuLabel(slab)).toBe('Select all of this category · IfcSlab · BASESLAB');
  });

  it('return null for the type row when there is no type', () => {
    expect(typeMenuLabel(identity())).toBeNull();
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

  it('accepts an explicit scope override for a mixed-type source', () => {
    const q = valueQuery(identity(), row, { ifcTypeCode: null });
    expect(q!.ifcTypeCode).toBeNull();
    // The predicate is untouched — only the candidate set widens.
    expect(q!.kind === 'value' && q!.selector.path).toBe('Pset_BeamCommon.Reference');
  });
});

describe('identitiesFromIds', () => {
  it('carries the queried class onto every match', () => {
    // The matches all came from that class, so unlike the marquee path we
    // don't have to leave class/type blank for a later fetch to fill in.
    const ids = identitiesFromIds(categoryQuery(identity()), [1, 2, 3]);
    expect(ids).toEqual([
      { modelId: 'model-a', expressId: 1, ifcClass: 'IfcBeam', ifcTypeCode: 1234 },
      { modelId: 'model-a', expressId: 2, ifcClass: 'IfcBeam', ifcTypeCode: 1234 },
      { modelId: 'model-a', expressId: 3, ifcClass: 'IfcBeam', ifcTypeCode: 1234 },
    ]);
  });

  it('maps an empty result to an empty selection', () => {
    expect(identitiesFromIds(categoryQuery(identity()), [])).toEqual([]);
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

  it('builds the menu query from the same sharedSource the menu displayed', () => {
    // Offering "all of this type" and then running a different query is the
    // failure mode this guards: one resolution, used by both.
    const menu = appSrc.match(/private async openContextMenu\([\s\S]*?\n {2}\}/)![0];
    expect(menu).toMatch(/const similar = state\.kind === 'none' \? null : sharedSource\(state\.identities\)/);
    expect(menu).toMatch(/categoryQuery\(similar\)/);
    expect(menu).toMatch(/typeQuery\(similar\)/);
  });

  it('enriches every selected identity, capped so the menu stays instant', () => {
    // The presets need each member's real class/type; without enrichment the
    // menu sees placeholders and offers nothing.
    const enrich = appSrc.match(/private async enrichSelection\([\s\S]*?\n {2}\}/)![0];
    expect(enrich).toMatch(/SIMILAR_MENU_ENRICH_MAX/);
    expect(enrich).toMatch(/state\.identities\.map\(/);
  });
});
