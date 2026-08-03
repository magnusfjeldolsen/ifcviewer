/**
 * Unit tests for the `findMatching` value predicate.
 *
 * This module decides which elements "Select similar" pulls in, so the
 * interesting cases are the exclusions: matching too eagerly would silently
 * select the wrong things, which is worse than offering nothing.
 */

import { describe, it, expect } from 'vitest';
import { isMatchable, valuesMatch, elementMatches } from '../src/inspector/matchValue';
import type { ElementProperties, PropertyFlatRow, PropertyValue } from '../src/inspector/types';

function single(value: string | number | boolean | null): PropertyValue {
  return { kind: 'single', value, raw: { typeCode: 0, value } };
}

function enumerated(...values: string[]): PropertyValue {
  return { kind: 'enumerated', values };
}

function propsWith(rows: Array<{ path: string; rawValue: PropertyValue }>): ElementProperties {
  const flat: PropertyFlatRow[] = rows.map((r) => ({
    path: r.path,
    name: r.path.split('.').pop() ?? r.path,
    rawValue: r.rawValue,
    displayValue: String(r.rawValue.kind === 'single' ? r.rawValue.value : ''),
    source: 'pset',
  }));
  return {
    identity: { modelId: 'm', expressId: 7, ifcClass: 'IfcWall', ifcTypeCode: 0 },
    direct: [],
    psets: [],
    qtos: [],
    materials: [],
    flat,
    fetchedAt: 0,
  };
}

describe('isMatchable', () => {
  it('accepts non-null singles and enumerated values', () => {
    expect(isMatchable(single('B12'))).toBe(true);
    expect(isMatchable(single(0))).toBe(true);
    expect(isMatchable(single(false))).toBe(true);
    expect(isMatchable(enumerated('A'))).toBe(true);
  });

  it('rejects a null single — "everything else with no value" is not a useful selection', () => {
    expect(isMatchable(single(null))).toBe(false);
  });

  it('rejects quantities: exact float equality is fragile', () => {
    expect(isMatchable({ kind: 'quantity', quantityKind: 'volume', value: 2.34 })).toBe(false);
  });

  it('rejects kinds with no cheap, well-defined equality', () => {
    expect(isMatchable({ kind: 'list', values: [single(1)] })).toBe(false);
    expect(isMatchable({ kind: 'bounded', lower: 1, upper: 2 })).toBe(false);
    expect(isMatchable({ kind: 'table', defining: [], defined: [] })).toBe(false);
    expect(isMatchable({ kind: 'complex', children: [] })).toBe(false);
    expect(isMatchable({ kind: 'material-ref', materialName: 'Concrete', expressId: 3 })).toBe(
      false,
    );
    expect(isMatchable({ kind: 'varies' })).toBe(false);
  });
});

describe('valuesMatch', () => {
  it('matches equal scalars of the same type', () => {
    expect(valuesMatch(single('B12'), single('B12'))).toBe(true);
    expect(valuesMatch(single(42), single(42))).toBe(true);
    expect(valuesMatch(single(true), single(true))).toBe(true);
  });

  it('does not coerce across types', () => {
    // Both sides came through the same normalizer, so a string "42" and a
    // numeric 42 are genuinely different values — not two spellings of one.
    expect(valuesMatch(single('42'), single(42))).toBe(false);
    expect(valuesMatch(single(1), single(true))).toBe(false);
    expect(valuesMatch(single(''), single(false))).toBe(false);
  });

  it('never matches a null candidate, even against a null target', () => {
    expect(valuesMatch(single(null), single(null))).toBe(false);
    expect(valuesMatch(single(null), single('B12'))).toBe(false);
  });

  it('compares enumerated values as sets, ignoring order', () => {
    expect(valuesMatch(enumerated('A', 'B'), enumerated('B', 'A'))).toBe(true);
    expect(valuesMatch(enumerated('A'), enumerated('A', 'B'))).toBe(false);
    expect(valuesMatch(enumerated('A', 'C'), enumerated('A', 'B'))).toBe(false);
  });

  it('never matches across kinds', () => {
    expect(valuesMatch(enumerated('A'), single('A'))).toBe(false);
    expect(valuesMatch(single('A'), enumerated('A'))).toBe(false);
  });

  it('never matches an unmatchable target', () => {
    const qty: PropertyValue = { kind: 'quantity', quantityKind: 'volume', value: 2.34 };
    expect(valuesMatch(qty, qty)).toBe(false);
  });
});

describe('elementMatches', () => {
  const target = single('B12');

  it('matches on the same flat-row path', () => {
    const props = propsWith([{ path: 'Pset_BeamCommon.Reference', rawValue: single('B12') }]);
    expect(elementMatches(props, { path: 'Pset_BeamCommon.Reference' }, target)).toBe(true);
  });

  it('is present-and-equal: a missing path is not a match', () => {
    const props = propsWith([{ path: 'Pset_BeamCommon.Other', rawValue: single('B12') }]);
    expect(elementMatches(props, { path: 'Pset_BeamCommon.Reference' }, target)).toBe(false);
  });

  it('is exact-path: the same value under a different pset does not match', () => {
    // Cross-class concept matching (a beam's TypeMark vs a column's) is
    // deliberately out of scope — the paths differ.
    const props = propsWith([{ path: 'Pset_ColumnCommon.Reference', rawValue: single('B12') }]);
    expect(elementMatches(props, { path: 'Pset_BeamCommon.Reference' }, target)).toBe(false);
  });

  it('matches identity rows by their path too', () => {
    const props = propsWith([{ path: 'Identity.Tag', rawValue: single('T-1') }]);
    expect(elementMatches(props, { path: 'Identity.Tag' }, single('T-1'))).toBe(true);
  });

  it('an element with a differing value at the path is not a match', () => {
    const props = propsWith([{ path: 'Pset_BeamCommon.Reference', rawValue: single('B14') }]);
    expect(elementMatches(props, { path: 'Pset_BeamCommon.Reference' }, target)).toBe(false);
  });
});
