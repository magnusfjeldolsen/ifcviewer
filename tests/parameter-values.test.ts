/**
 * Values of one parameter: the matcher target the Parameters list's
 * counts agree with, the value column the list now counts and selects from
 * (see `parameterColumn.ts`), and the worker job that builds a column
 * (chunked on the queue, stopped when the model goes away).
 */

import { describe, it, expect } from 'vitest';
import { elementMatches } from '../src/inspector/matchValue';
import { ParameterFold } from '../src/inspector/parameterFold';
import {
  ColumnBuilder,
  columnIdsWithValue,
  columnRowsWithValue,
  columnUnits,
  columnValueCounts,
  columnBytes,
  columnTransferables,
  type ColumnData,
  type ParameterColumn,
} from '../src/inspector/parameterColumn';
import { canSum } from '../src/inspector/units';
import { SerialQueue } from '../src/parser/serialQueue';
import { ParameterDiscoveries } from '../src/parser/parameterDiscovery';
import type { FromWorker } from '../src/parser/ifcMessages';
import type { ElementProperties, PropertyFlatRow, PropertyValue } from '../src/inspector/types';

function single(value: string | number | boolean | null): PropertyValue {
  return { kind: 'single', value, raw: { typeCode: 0, value } };
}

function row(path: string, value: PropertyValue, extra: Partial<PropertyFlatRow> = {}): PropertyFlatRow {
  return { path, name: path.split('.').pop()!, rawValue: value, displayValue: '', source: 'pset', ...extra };
}

function props(expressId: number, flat: PropertyFlatRow[]): ElementProperties {
  return {
    identity: { modelId: 'm', expressId, ifcClass: 'IfcBeam', ifcTypeCode: 0 },
    direct: [],
    psets: [],
    qtos: [],
    materials: [],
    flat,
    fetchedAt: 0,
  };
}

describe('matching a value as the Parameters list counts it', () => {
  const target = (value: string | number | boolean) => ({ kind: 'parameter-value' as const, value });

  it('matches quantities by number, which select-similar cannot', () => {
    const p = props(1, [row('Qto.Length', { kind: 'quantity', quantityKind: 'length', value: 2.5 })]);
    expect(elementMatches(p, { path: 'Qto.Length' }, target(2.5))).toBe(true);
    expect(elementMatches(p, { path: 'Qto.Length' }, target(2.6))).toBe(false);
  });

  it('matches an enumeration by its joined text, and a yes/no by its boolean', () => {
    const p = props(1, [
      row('P.E', { kind: 'enumerated', values: ['A', 'B'] }),
      row('P.B', single(false)),
    ]);
    expect(elementMatches(p, { path: 'P.E' }, target('A, B'))).toBe(true);
    expect(elementMatches(p, { path: 'P.B' }, target(false))).toBe(true);
    expect(elementMatches(p, { path: 'P.B' }, target('false'))).toBe(false);
  });

  it('uses the instance value where instance and type share a path', () => {
    const p = props(1, [row('P.X', single('inst')), row('P.X', single('type'), { inheritedFromType: true })]);
    expect(elementMatches(p, { path: 'P.X' }, target('inst'))).toBe(true);
    expect(elementMatches(p, { path: 'P.X' }, target('type'))).toBe(false);
  });

  it('selects exactly as many elements as the list counted for each value', () => {
    const elements = [
      props(1, [row('P.X', single('a')), row('P.X', single('b'), { inheritedFromType: true })]),
      props(2, [row('P.X', single('b'), { inheritedFromType: true })]),
      props(3, [row('P.X', single('b'))]),
      props(4, [row('P.Y', single('a'))]),
    ];
    const fold = new ParameterFold();
    for (const e of elements) fold.add(e);
    const x = fold.result('m', 4).parameters.find((p) => p.key === 'P.X')!;
    for (const { value, count } of x.values!) {
      const selected = elements.filter((e) => elementMatches(e, { path: 'P.X' }, target(value)));
      expect(selected.length).toBe(count);
    }
  });
});

/** Build a column from elements, row i being elements[i]. */
function build(key: string, elements: ElementProperties[]): ColumnData {
  const b = new ColumnBuilder(key, elements.length);
  elements.forEach((e, i) => b.add(i, e));
  return b.finish();
}

const withIds = (c: ColumnData, ids: number[]): ParameterColumn => ({ ...c, modelId: 'm', ids: Int32Array.from(ids) });

describe('value columns', () => {
  it('keeps numbers in a Float64Array, NaN where an element has none', () => {
    const c = build('Q.L', [
      props(1, [row('Q.L', single(2.5), { unit: 'mm', unitKey: 'si:mm' })]),
      props(2, [row('Q.Other', single(1))]),
      props(3, [row('Q.L', single(4), { unit: 'mm', unitKey: 'si:mm' })]),
    ]);
    expect(c.type).toBe('numeric');
    if (c.type !== 'numeric') return;
    expect([...c.values]).toEqual([2.5, NaN, 4]);
    expect(c.count).toBe(2);
    expect(c.units).toEqual([{ key: 'si:mm', symbol: 'mm' }]);
    // One unit: no per-row index.
    expect(c.unitIndex).toBeNull();
    expect(columnBytes(c)).toBe(24);
  });

  it('records the unit of each row when the values are in more than one', () => {
    const c = build('Q.L', [
      props(1, [row('Q.L', single(200), { unit: 'mm', unitKey: 'si:mm' })]),
      props(2, [row('Q.L', single(0.3), { unit: 'm', unitKey: 'si:m' })]),
      props(3, [row('Q.L', single(250), { unit: 'mm', unitKey: 'si:mm' })]),
    ]);
    if (c.type !== 'numeric') throw new Error('expected numeric');
    expect(c.units.map((u) => u.key)).toEqual(['si:mm', 'si:m']);
    expect([...c.unitIndex!]).toEqual([0, 1, 0]);
    // The units of a sub-scope decide whether it can be added up.
    expect(canSum({ kind: 'numeric', units: columnUnits(c) }).ok).toBe(false);
    expect(columnUnits(c, [0, 2])).toEqual([{ key: 'si:mm', symbol: 'mm', count: 2 }]);
    expect(canSum({ kind: 'numeric', units: columnUnits(c, [0, 2]) })).toMatchObject({ ok: true, unit: { key: 'si:mm' } });
  });

  it('keeps the unit of every row right even past 65,536 distinct units', () => {
    const n = 0x10000 + 3;
    const b = new ColumnBuilder('Q.L', n);
    for (let i = 0; i < n; i++) b.add(i, props(i, [row('Q.L', single(1), { unitKey: `u${i}` })]));
    const c = b.finish();
    if (c.type !== 'numeric') throw new Error('expected numeric');
    expect(c.unitIndex).toBeInstanceOf(Uint32Array);
    expect(c.units[c.unitIndex![n - 1]].key).toBe(`u${n - 1}`);
    expect(c.units[c.unitIndex![5]].key).toBe('u5');
  });

  it('codes text, yes/no and enumerations into a dictionary, -1 where an element has none', () => {
    const c = build('P.S', [
      props(1, [row('P.S', single('a'))]),
      props(2, [row('P.S', { kind: 'enumerated', values: ['b', 'c'] })]),
      props(3, []),
      props(4, [row('P.S', single('a'))]),
    ]);
    if (c.type !== 'discrete') throw new Error('expected discrete');
    expect(c.dictionary).toEqual(['a', 'b, c']);
    expect([...c.codes]).toEqual([0, 1, -1, 0]);
    expect(columnUnits(c)).toEqual([]);
  });

  it('a parameter with numbers and text is discrete, and keeps the numbers as numbers', () => {
    const c = build('P.M', [props(1, [row('P.M', single(3))]), props(2, [row('P.M', single('three'))])]);
    if (c.type !== 'discrete') throw new Error('expected discrete');
    expect(c.dictionary).toEqual([3, 'three']);
  });

  it('an element that has the path on its instance and its type takes the instance value', () => {
    const c = build('P.X', [props(1, [row('P.X', single('instance')), row('P.X', single('type'), { inheritedFromType: true })])]);
    if (c.type !== 'discrete') throw new Error('expected discrete');
    expect(c.dictionary).toEqual(['instance']);
  });

  it('counts values as the description does, below the cap and past it', () => {
    const elements: ElementProperties[] = [];
    for (let i = 0; i < 300; i++) elements.push(props(i, [row('P.X', single(`v${i % 250}`))]));
    elements.push(props(999, [row('P.Y', single('other'))]));
    const values = columnValueCounts(build('P.X', elements));
    expect(values).toHaveLength(250);
    expect(values[0].count).toBe(2);
    expect(values.reduce((n, v) => n + v.count, 0)).toBe(300);

    const fold = new ParameterFold();
    const few = ['a', 'b', 'a', 'c'].map((v, i) => props(i, [row('P.X', single(v))]));
    for (const e of few) fold.add(e);
    expect(columnValueCounts(build('P.X', few))).toEqual(fold.result('m', 4).parameters[0].values);

    const nums = [3, 1, 3, 2].map((v, i) => props(i, [row('Q.N', single(v))]));
    const numFold = new ParameterFold();
    for (const e of nums) numFold.add(e);
    expect(columnValueCounts(build('Q.N', nums))).toEqual(numFold.result('m', 4).parameters[0].values);
  });

  it('finds the elements with a value: exactly the ones the matcher selects, as many as counted', () => {
    const elements = [
      props(11, [row('P.X', single('a')), row('P.X', single('b'), { inheritedFromType: true })]),
      props(12, [row('P.X', single('b'), { inheritedFromType: true })]),
      props(13, [row('P.X', single('b'))]),
      props(14, [row('P.Y', single('a'))]),
    ];
    const c = withIds(build('P.X', elements), [11, 12, 13, 14]);
    for (const { value, count } of columnValueCounts(c)) {
      const matched = elements
        .filter((e) => elementMatches(e, { path: 'P.X' }, { kind: 'parameter-value', value }))
        .map((e) => e.identity.expressId);
      expect(columnIdsWithValue(c, value)).toEqual(matched);
      expect(matched).toHaveLength(count);
    }
    expect(columnIdsWithValue(c, 'nope')).toEqual([]);
  });

  it('compares numbers as they show, and never a number with text', () => {
    const c = build('Q.N', [props(1, [row('Q.N', single(0.1 + 0.2))]), props(2, [row('Q.N', single(0.3))])]);
    // 0.1 + 0.2 shows as 0.3, so it is the same value as 0.3 (#114).
    expect(columnRowsWithValue(c, 0.3)).toEqual([0, 1]);
    expect(columnRowsWithValue(c, '0.3')).toEqual([]);
  });
});

function harness(read?: (id: number) => ElementProperties) {
  const queue = new SerialQueue();
  const log: string[] = [];
  const posted: { msg: FromWorker; transfer?: Transferable[] }[] = [];
  const open = new Map([['m', 7]]);
  let during: (() => void) | null = null;
  const d = new ParameterDiscoveries(
    {
      queue,
      openId: (id) => open.get(id),
      read: async (_m, _w, id) => {
        log.push(`read ${id}`);
        const f = during;
        during = null;
        f?.();
        if (read) return read(id);
        return props(id, [row('P.X', single(id % 2 === 0 ? 'even' : 'odd'))]);
      },
      post: (msg, transfer) => posted.push({ msg, transfer }),
    },
    2,
  );
  const reply = async (reqId: number): Promise<{ msg: FromWorker; transfer?: Transferable[] }> => {
    for (;;) {
      const r = posted.find(({ msg: m }) => (m.type === 'column' || m.type === 'error') && m.reqId === reqId);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 1));
    }
  };
  return { queue, log, posted, open, d, reply, setDuring: (f: () => void) => (during = f) };
}

describe('building a value column in the worker', () => {
  it('reads in chunks, lets a click go first, and answers with the column, its arrays transferred', async () => {
    const h = harness();
    h.setDuring(() => setTimeout(() => h.queue.enqueue(async () => void h.log.push('getProps')), 0));
    h.d.requestColumn(1, 'm', Int32Array.from([1, 2, 3, 4, 5]), 'P.X');
    const { msg, transfer } = await h.reply(1);
    if (msg.type !== 'column' || msg.column.type !== 'discrete') throw new Error('expected a discrete column');
    expect(msg.column.dictionary).toEqual(['odd', 'even']);
    expect([...msg.column.codes]).toEqual([0, 1, 0, 1, 0]);
    expect(transfer).toEqual([msg.column.codes.buffer]);
    expect(h.log.indexOf('getProps')).toBe(2);
    expect(h.posted.some(({ msg: m }) => m.type === 'progress' && m.reqId === 1 && m.done === 5)).toBe(true);
  });

  it('keeps rows aligned with the scope when an element cannot be read', async () => {
    const h = harness((id) => {
      if (id === 2) throw new Error('unreadable');
      return props(id, [row('Q.N', single(id * 10))]);
    });
    h.d.requestColumn(1, 'm', Int32Array.from([1, 2, 3]), 'Q.N');
    const { msg } = await h.reply(1);
    if (msg.type !== 'column' || msg.column.type !== 'numeric') throw new Error('expected a numeric column');
    expect([...msg.column.values]).toEqual([10, NaN, 30]);
  });

  it('runs alongside the description of the same model without either joining the other', async () => {
    const h = harness();
    h.d.request(1, 'm', [1, 2]);
    h.d.requestColumn(2, 'm', Int32Array.from([1, 2]), 'P.X');
    await h.reply(2);
    expect(h.posted.some(({ msg: m }) => m.type === 'parameters' && m.reqId === 1)).toBe(true);
  });

  it('a second ask while it runs joins the same read; only the last answer is handed the arrays', async () => {
    const h = harness();
    h.d.requestColumn(1, 'm', Int32Array.from([1, 2, 3]), 'P.X');
    h.d.requestColumn(2, 'm', Int32Array.from([1, 2, 3]), 'P.X');
    const first = await h.reply(1);
    const second = await h.reply(2);
    expect(h.log.filter((l) => l === 'read 1')).toHaveLength(1);
    expect(first.transfer).toEqual([]);
    expect(second.transfer).toHaveLength(1);
  });

  it('stops when the model is closed, and tells whoever waits', async () => {
    const h = harness();
    h.setDuring(() => {
      h.open.delete('m');
      h.d.drop('m');
    });
    h.d.requestColumn(1, 'm', Int32Array.from([1, 2, 3, 4, 5]), 'P.X');
    const { msg } = await h.reply(1);
    expect(msg).toMatchObject({ type: 'error', message: expect.stringMatching(/closed/) });
    await new Promise((res) => setTimeout(res, 10));
    // A column build stops at once, without finishing its step on a closed model.
    expect(h.log).toEqual(['read 1']);
    expect(h.d.isRunning('m')).toBe(false);
  });
});

describe('column builds sharing one read', () => {
  it('keeps the units of numbers among text, so a scope of only those numbers can be added up', () => {
    const c = build('Q.N', [
      props(1, [row('Q.N', single('n/a'))]),
      props(2, [row('Q.N', single(4), { unit: 'm', unitKey: 'si:m' })]),
      props(3, [row('Q.N', single(5), { unit: 'mm', unitKey: 'si:mm' })]),
    ]);
    if (c.type !== 'discrete') throw new Error('expected a discrete column');
    expect(c.units).toEqual([
      { key: 'si:m', symbol: 'm' },
      { key: 'si:mm', symbol: 'mm' },
    ]);
    expect([...c.unitIndex!]).toEqual([0, 0, 1]);
    expect(columnTransferables(c)).toHaveLength(2);
  });

  it('a column asked for while an element is being read starts with that element and reads round', async () => {
    const reads: number[] = [];
    let joined = false;
    const h = harness((id) => {
      reads.push(id);
      if (id === 2 && !joined) {
        joined = true;
        // Arrives while element 2 is being read.
        h.d.requestColumn(2, 'm', Int32Array.from([1, 2, 3, 4, 5]), 'Q.B');
      }
      return props(id, [row('Q.A', single(id)), row('Q.B', single(id * 10))]);
    });
    h.d.requestColumn(1, 'm', Int32Array.from([1, 2, 3, 4, 5]), 'Q.A');
    const a = await h.reply(1);
    const b = await h.reply(2);
    if (a.msg.type !== 'column' || b.msg.type !== 'column') throw new Error('expected columns');
    if (b.msg.column.type !== 'numeric') throw new Error('expected numbers');
    expect([...b.msg.column.values]).toEqual([10, 20, 30, 40, 50]);
    // Once round for A, and B round again to element 1, which it missed.
    expect(reads).toEqual([1, 2, 3, 4, 5, 1]);
  });

  it('closing the model stops every column of a shared read and tells each caller', async () => {
    const h = harness();
    h.setDuring(() => {
      h.open.delete('m');
      h.d.drop('m');
    });
    h.d.requestColumn(1, 'm', Int32Array.from([1, 2, 3, 4, 5]), 'P.X');
    h.d.requestColumn(2, 'm', Int32Array.from([1, 2, 3, 4, 5]), 'P.Y');
    const a = await h.reply(1);
    const b = await h.reply(2);
    expect(a.msg).toMatchObject({ type: 'error', message: expect.stringMatching(/closed/) });
    expect(b.msg).toMatchObject({ type: 'error', message: expect.stringMatching(/closed/) });
    expect(h.d.isRunning('m')).toBe(false);
  });

  it('a column asked for over other elements of the model supersedes the one over the old elements', async () => {
    const h = harness();
    h.d.requestColumn(1, 'm', Int32Array.from([1, 2, 3]), 'P.X');
    h.d.requestColumn(2, 'm', Int32Array.from([1, 2]), 'P.X');
    const old = await h.reply(1);
    const fresh = await h.reply(2);
    expect(old.msg).toMatchObject({ type: 'error', message: 'Superseded by a newer request' });
    if (fresh.msg.type !== 'column') throw new Error('expected a column');
    expect(fresh.msg.column.count).toBe(2);
  });
});

describe('numbers that show the same are one value (#114)', () => {
  // Unit conversion leaves 16.7083 ft a hair apart on different elements.
  const spans = [16.7083, 16.708300000001, 16.7083, 22.25].map((v, i) =>
    props(i + 1, [row('P.Span', single(v), { unit: 'ft', unitKey: 'conv:foot' })]),
  );

  it('counts them as one line, in the description and in the column alike', () => {
    const fold = new ParameterFold();
    for (const e of spans) fold.add(e);
    const described = fold.result('m', 4).parameters[0].values!;
    expect(described.map((v) => [v.value, v.count])).toEqual([
      [16.7083, 3],
      [22.25, 1],
    ]);
    expect(columnValueCounts(build('P.Span', spans))).toEqual(described);
  });

  it('keeps them as one line in a mixed-unit column, and apart by unit', () => {
    const mixed = [
      props(1, [row('P.Span', single(3), { unit: 'mm', unitKey: 'si:mm' })]),
      props(2, [row('P.Span', single(3.0000000001), { unit: 'mm', unitKey: 'si:mm' })]),
      props(3, [row('P.Span', single(3), { unit: 'm', unitKey: 'si:m' })]),
    ];
    const counts = columnValueCounts(build('P.Span', mixed));
    expect(counts.map((v) => [v.value, v.count, v.unit?.key])).toEqual([
      [3, 2, 'si:mm'],
      [3, 1, 'si:m'],
    ]);
  });

  it('merges them in a column that also holds text', () => {
    const withText = [...spans, props(9, [row('P.Span', single('n/a'))])];
    const counts = columnValueCounts(build('P.Span', withText));
    expect(counts.find((v) => v.value === 16.7083)?.count).toBe(3);
  });

  it('picks all of them: the column, and the matcher select-similar uses', () => {
    const column = withIds(build('P.Span', spans), [1, 2, 3, 4]);
    expect(columnIdsWithValue(column, 16.7083)).toEqual([1, 2, 3]);
    expect(columnIdsWithValue(column, 16.7083, 'conv:foot')).toEqual([1, 2, 3]);
    const target = { kind: 'parameter-value' as const, value: 16.7083 };
    expect(spans.map((e) => elementMatches(e, { path: 'P.Span' }, target))).toEqual([true, true, true, false]);
  });
});
