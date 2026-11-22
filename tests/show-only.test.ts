/**
 * "Show only" (#70): which unit a value must be in to match it in another
 * model, and the status line after a show-only. The hiding itself is tested
 * with the appearance manager (element-appearance.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { crossModelUnitKey, findAcrossModels, InOrder, Latest, showOnlyStatus } from '../src/inspector/showOnly';
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

  it('says which matches cannot be seen, and why', () => {
    expect(showOnlyStatus('Type = A', { shown: 0, fresh: true, switchedOff: 40, cutAway: 0 }, false)).toBe(
      'Type = A: none can be seen — 40 in a model that is switched off',
    );
    expect(showOnlyStatus('Type = A', { shown: 3, fresh: false, switchedOff: 2, cutAway: 1 }, false)).toBe(
      'Showing only 3 elements — Type = A; 2 in a model that is switched off, 1 behind the section cut',
    );
  });
});

describe('searching every loaded model', () => {
  const later = () => {
    let resolve!: (v: number[]) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<number[]>((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
  };

  it('takes the model list once loads are done, so a model that was loading is searched', async () => {
    let models = ['A'];
    let idle!: () => void;
    const searched: string[] = [];
    const p = findAcrossModels(
      { idle: () => new Promise<void>((r) => (idle = r)), models: () => models, isLoaded: () => true },
      async (m) => (searched.push(m), [1]),
    );
    models = ['A', 'B']; // B finished loading meanwhile
    idle();
    expect(await p).toEqual([{ modelId: 'A', expressId: 1 }, { modelId: 'B', expressId: 1 }]);
    expect(searched).toEqual(['A', 'B']);
  });

  it('drops a model closed during the search, and its failure is not an error', async () => {
    const loaded = new Set(['A', 'B', 'C']);
    const b = later();
    const c = later();
    const p = findAcrossModels(
      { idle: async () => {}, models: () => ['A', 'B', 'C'], isLoaded: (m) => loaded.has(m) },
      (m) => (m === 'A' ? Promise.resolve([1]) : m === 'B' ? b.promise : c.promise),
    );
    await Promise.resolve();
    loaded.delete('B');
    loaded.delete('C');
    b.resolve([2]); // finished, but the model is gone
    c.reject(new Error('model closed'));
    expect(await p).toEqual([{ modelId: 'A', expressId: 1 }]);
  });

  it('any other failure rejects', async () => {
    await expect(
      findAcrossModels({ idle: async () => {}, models: () => ['A'], isLoaded: () => true }, async () => {
        throw new Error('worker broke');
      }),
    ).rejects.toThrow('worker broke');
  });
});

describe('the newest show-only wins, in the order clicked', () => {
  it('a plain request outdates earlier ones; a Ctrl/Shift one joins them', () => {
    const latest = new Latest();
    const a = latest.next();
    const b = latest.current(); // Shift: as well
    expect(latest.isLatest(a) && latest.isLatest(b)).toBe(true);
    const c = latest.next();
    expect(latest.isLatest(a)).toBe(false);
    expect(latest.isLatest(c)).toBe(true);
  });

  it('applies in the order started, however the searches finish', async () => {
    const order = new InOrder();
    const applied: string[] = [];
    let finishFirst!: () => void;
    const first = order.run(() => new Promise<string>((r) => (finishFirst = () => r('narrow'))), (v) => applied.push(v));
    const second = order.run(async () => 'add', (v) => applied.push(v));
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([]); // the add waits for the narrow before it
    finishFirst();
    await Promise.all([first, second]);
    expect(applied).toEqual(['narrow', 'add']);
  });

  it('a request that outdates the earlier ones does not wait for them, and a failure never blocks the queue', async () => {
    const order = new InOrder();
    const applied: string[] = [];
    void order.run(() => new Promise<string>(() => {}), (v) => applied.push(v)); // never finishes
    await order.run(async () => 'plain', (v) => applied.push(v), false);
    expect(applied).toEqual(['plain']);
    await order.run(async () => { throw new Error('x'); }, () => {}).catch(() => {});
    await order.run(async () => 'after', (v) => applied.push(v));
    expect(applied).toEqual(['plain', 'after']);
  });
});
