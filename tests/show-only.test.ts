/**
 * "Show only" (#70): which unit a value must be in to match it in another
 * model, and the status line after a show-only. The hiding itself is tested
 * with the appearance manager (element-appearance.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { crossModelUnitKey, showOnlyStatus } from '../src/inspector/showOnly';
import { ColumnBuilder, columnRowsWithValue } from '../src/inspector/parameterColumn';
import type { ElementProperties, PropertyFlatRow } from '../src/inspector/types';

describe('matching a value in another model', () => {
  const mm = { key: 'si:mm', symbol: 'mm', count: 2 };

  it('no unit applies to text or yes/no', () => {
    expect(crossModelUnitKey({ units: [mm] }, 'Concrete')).toBeUndefined();
    expect(crossModelUnitKey({}, true)).toBeUndefined();
  });

  it('a number keeps its unit: the one of the list, or of the entry in a mixed list', () => {
    expect(crossModelUnitKey({ units: [mm] }, 3)).toBe('si:mm');
    expect(crossModelUnitKey({ units: [mm, { key: 'si:m', symbol: 'm', count: 1 }] }, 3, { key: 'si:m', symbol: 'm' })).toBe('si:m');
    // Plain numbers: the "no unit applies" key, which every model shares.
    expect(crossModelUnitKey({ units: [{ key: '', symbol: '', count: 4 }] }, 3)).toBe('');
  });

  it('a unit the model does not state, or does not say, matches in its own model only', () => {
    expect(crossModelUnitKey({ units: [{ key: '?LENGTHUNIT', symbol: '', count: 2 }] }, 3)).toBeNull();
    expect(crossModelUnitKey({}, 3)).toBeNull();
  });
});

describe('a number among text, asked for in one unit', () => {
  const row = (value: string | number, unitKey?: string): PropertyFlatRow => ({
    path: 'P.M',
    name: 'M',
    rawValue: { kind: 'single', value, raw: { typeCode: 0, value } },
    displayValue: '',
    source: 'pset',
    ...(unitKey !== undefined ? { unitKey } : {}),
  });
  const props = (flat: PropertyFlatRow[]): ElementProperties => ({
    identity: { modelId: 'm', expressId: 1, ifcClass: 'IfcBeam', ifcTypeCode: 0 },
    direct: [], psets: [], qtos: [], materials: [], flat, fetchedAt: 0,
  });

  it('matches only the rows in that unit; without one, every row with the number', () => {
    const b = new ColumnBuilder('P.M', 3);
    b.add(0, props([row(3, 'si:mm')]));
    b.add(1, props([row('three')]));
    b.add(2, props([row(3, 'si:m')]));
    const c = b.finish();
    expect(c.type).toBe('discrete');
    expect(columnRowsWithValue(c, 3)).toEqual([0, 2]);
    expect(columnRowsWithValue(c, 3, 'si:mm')).toEqual([0]);
    expect(columnRowsWithValue(c, 3, 'si:m')).toEqual([2]);
    expect(columnRowsWithValue(c, 3, 'si:km')).toEqual([]);
    expect(columnRowsWithValue(c, 'three', 'si:mm')).toEqual([1]);
  });
});

describe('the status line after a show-only', () => {
  it('says what is shown, and when it started over', () => {
    expect(showOnlyStatus('Material = Concrete', { shown: 40, fresh: false }, false)).toBe(
      'Showing only 40 elements — Material = Concrete',
    );
    expect(showOnlyStatus('Material = Steel', { shown: 1, fresh: true }, false)).toBe(
      'None of the shown elements match Material = Steel: showing all 1 that do',
    );
    expect(showOnlyStatus('Material = Steel', { shown: 1234, fresh: false }, true)).toBe(
      'Also showing 1,234 elements — Material = Steel',
    );
    expect(showOnlyStatus('X = 1', { shown: 0, fresh: false }, false)).toBe('No elements match X = 1');
  });
});
