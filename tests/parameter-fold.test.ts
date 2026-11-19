import { describe, it, expect } from 'vitest';
import { firstRowPerPath } from '../src/inspector/repository/flatRows';
import { elementMatches } from '../src/inspector/matchValue';
import { ParameterFold, parameterValueOf } from '../src/inspector/parameterFold';
import type { ElementProperties, PropertyFlatRow, PropertyValue } from '../src/inspector/types';

function single(value: string | number | boolean | null): PropertyValue {
  return { kind: 'single', value, raw: { typeCode: 0, value } };
}

function row(path: string, value: PropertyValue, extra: Partial<PropertyFlatRow> = {}): PropertyFlatRow {
  return {
    path,
    name: path.split('.').pop()!,
    rawValue: value,
    displayValue: value.kind === 'single' ? String(value.value ?? '') : '',
    source: 'pset',
    ...extra,
  };
}

function props(flat: PropertyFlatRow[]): ElementProperties {
  return {
    identity: { modelId: 'm', expressId: 1, ifcClass: 'IfcBeam', ifcTypeCode: 0 },
    direct: [],
    psets: [],
    qtos: [],
    materials: [],
    flat,
    fetchedAt: 0,
  };
}

describe('firstRowPerPath', () => {
  it('keeps the first row at each path (the instance value, which sorts first)', () => {
    const rows = [
      row('Pset_A.X', single('instance')),
      row('Pset_A.X', single('type'), { inheritedFromType: true }),
      row('Pset_A.Y', single(1)),
    ];
    const byPath = firstRowPerPath(rows);
    expect([...byPath.keys()]).toEqual(['Pset_A.X', 'Pset_A.Y']);
    expect(byPath.get('Pset_A.X')!.rawValue).toEqual(single('instance'));
  });

  it('is the rule matching uses: the type value at a shared path does not match', () => {
    const p = props([
      row('Pset_A.X', single('instance')),
      row('Pset_A.X', single('type'), { inheritedFromType: true }),
    ]);
    expect(elementMatches(p, { path: 'Pset_A.X' }, single('instance'))).toBe(true);
    expect(elementMatches(p, { path: 'Pset_A.X' }, single('type'))).toBe(false);
  });
});

describe('parameterValueOf', () => {
  it('keeps the normalised type of single values and quantities', () => {
    expect(parameterValueOf(single(2.5), '2.5')).toBe(2.5);
    expect(parameterValueOf(single(true), 'true')).toBe(true);
    expect(parameterValueOf(single('A'), 'A')).toBe('A');
    expect(parameterValueOf({ kind: 'quantity', quantityKind: 'volume', value: 3 }, '3')).toBe(3);
  });

  it('joins enumerations as the inspector shows them', () => {
    expect(parameterValueOf({ kind: 'enumerated', values: ['A', 'B'] }, 'A, B')).toBe('A, B');
  });

  it('treats null and non-finite numbers as no value', () => {
    expect(parameterValueOf(single(null), '')).toBeNull();
    expect(parameterValueOf(single(NaN), 'NaN')).toBeNull();
  });
});

describe('ParameterFold', () => {
  it('counts each element once per path, with the instance value, when instance and type share it', () => {
    const fold = new ParameterFold();
    fold.add(props([
      row('Pset_A.LoadBearing', single(true)),
      row('Pset_A.LoadBearing', single(false), { inheritedFromType: true }),
    ]));
    fold.add(props([row('Pset_A.LoadBearing', single(false), { inheritedFromType: true })]));
    const [p] = fold.result('m', 2).parameters;
    expect(p).toMatchObject({ key: 'Pset_A.LoadBearing', count: 2, kind: 'boolean', distinct: 2 });
    expect(p.values).toEqual([
      { value: false, count: 1 },
      { value: true, count: 1 },
    ]);
  });

  it('gives counts out of the scope, sorted by key, and skips empty values', () => {
    const fold = new ParameterFold();
    fold.add(props([row('B.x', single('a')), row('A.y', single(null))]));
    fold.add(props([row('B.x', single('a'))]));
    fold.add(props([]));
    const r = fold.result('m', 3);
    expect(r.scopeSize).toBe(3);
    expect(r.parameters.map((p) => [p.key, p.count])).toEqual([['B.x', 2]]);
  });

  it('decides the kind from the value type, and says mixed when elements disagree', () => {
    const fold = new ParameterFold();
    fold.add(props([row('P.n', single(1)), row('P.t', single('x')), row('P.m', single(1))]));
    fold.add(props([row('P.n', single(2)), row('P.t', single('y')), row('P.m', single('one'))]));
    const kinds = Object.fromEntries(fold.result('m', 2).parameters.map((p) => [p.key, p.kind]));
    expect(kinds).toEqual({ 'P.m': 'mixed', 'P.n': 'numeric', 'P.t': 'text' });
  });

  it('keeps min, max and sum over numeric values, with the unit as shown', () => {
    const fold = new ParameterFold();
    for (const v of [4, -1, 2.5]) {
      fold.add(props([row('Qto.Length', { kind: 'quantity', quantityKind: 'length', value: v }, { unit: 'mm' })]));
    }
    const [p] = fold.result('m', 3).parameters;
    expect(p.numeric).toEqual({ min: -1, max: 4, sum: 5.5 });
    expect(p.unit).toBe('mm');
    expect(p.unitsDiffer).toBeUndefined();
  });

  it('notes when the unit differs between elements, and counts each unit', () => {
    const fold = new ParameterFold();
    fold.add(props([row('Q.L', single(1), { unit: 'mm', unitKey: 'si:mm' })]));
    fold.add(props([row('Q.L', single(2), { unit: 'm', unitKey: 'si:m' })]));
    fold.add(props([row('Q.L', single(3), { unit: 'm', unitKey: 'si:m' })]));
    const [p] = fold.result('m', 3).parameters;
    expect(p.unitsDiffer).toBe(true);
    // No single unit to show when they differ.
    expect(p.unit).toBeUndefined();
    expect(p.units).toEqual([
      { key: 'si:m', symbol: 'm', count: 2 },
      { key: 'si:mm', symbol: 'mm', count: 1 },
    ]);
  });

  it('tells units apart by key, not by symbol', () => {
    const fold = new ParameterFold();
    fold.add(props([row('Q.L', single(1), { unit: 'ft', unitKey: 'conv:foot*0.3048 si:m' })]));
    fold.add(props([row('Q.L', single(2), { unit: 'ft', unitKey: 'conv:foot*0.3048006 si:m' })]));
    expect(fold.result('m', 2).parameters[0].unitsDiffer).toBe(true);
  });

  it('keeps a unit the model does not state apart from a stated one', () => {
    const fold = new ParameterFold();
    fold.add(props([row('Q.T', single(1), { unitKey: '?TIMEUNIT' })]));
    fold.add(props([row('Q.T', single(2), { unitKey: '?TIMEUNIT' })]));
    const [p] = fold.result('m', 2).parameters;
    expect(p.units).toEqual([{ key: '?TIMEUNIT', symbol: '', count: 2 }]);
    expect(p.unit).toBeUndefined();
    expect(p.unitsDiffer).toBeUndefined();
  });

  it('counts units over numbers only: text has no unit', () => {
    const fold = new ParameterFold();
    fold.add(props([row('P.X', single('a'))]));
    fold.add(props([row('P.X', single(2), { unit: 'mm', unitKey: 'si:mm' })]));
    const [p] = fold.result('m', 2).parameters;
    expect(p.kind).toBe('mixed');
    expect(p.units).toEqual([{ key: 'si:mm', symbol: 'mm', count: 1 }]);
    expect(fold.result('m', 2).parameters.every((x) => x.unitsDiffer === undefined)).toBe(true);
  });

  it('has no units for a text parameter', () => {
    const fold = new ParameterFold();
    fold.add(props([row('P.X', single('a'))]));
    expect(fold.result('m', 1).parameters[0].units).toBeUndefined();
  });

  it('lists distinct values most common first, up to the cap', () => {
    const fold = new ParameterFold(3);
    for (const v of ['b', 'a', 'b', 'c']) fold.add(props([row('P.v', single(v))]));
    const [p] = fold.result('m', 4).parameters;
    expect(p.distinct).toBe(3);
    expect(p.values).toEqual([
      { value: 'b', count: 2 },
      { value: 'a', count: 1 },
      { value: 'c', count: 1 },
    ]);
    expect(p.uniquePerElement).toBe(false);
  });

  it('drops the values past the cap rather than show a partial tally', () => {
    const fold = new ParameterFold(3);
    for (const v of ['a', 'a', 'b', 'c', 'd']) fold.add(props([row('P.v', single(v))]));
    const [p] = fold.result('m', 5).parameters;
    expect(p.distinct).toBeNull();
    expect(p.values).toBeUndefined();
    expect(p.count).toBe(5);
    expect(p.uniquePerElement).toBe(false);
  });

  it('flags unique per element when no value repeats, below and past the cap', () => {
    const small = new ParameterFold(10);
    const big = new ParameterFold(3);
    for (let i = 0; i < 6; i++) {
      small.add(props([row('Identity.GlobalId', single(`g${i}`))]));
      big.add(props([row('Identity.GlobalId', single(`g${i}`))]));
    }
    expect(small.result('m', 6).parameters[0]).toMatchObject({ uniquePerElement: true, distinct: 6 });
    expect(big.result('m', 6).parameters[0]).toMatchObject({ uniquePerElement: true, distinct: null });
  });

  it('spots a repeat that comes after the cap was passed', () => {
    const fold = new ParameterFold(3);
    for (const v of ['a', 'b', 'c', 'd', 'e', 'b']) fold.add(props([row('P.v', single(v))]));
    expect(fold.result('m', 6).parameters[0].uniquePerElement).toBe(false);
  });

  it('does not call a parameter on one element unique', () => {
    const fold = new ParameterFold();
    fold.add(props([row('P.v', single('only'))]));
    expect(fold.result('m', 1).parameters[0].uniquePerElement).toBe(false);
  });
});
