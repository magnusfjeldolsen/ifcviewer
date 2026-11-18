/**
 * Values of one parameter: the matcher target the Parameters list selects
 * with, the uncapped tally fetched on demand, and the worker job that
 * fetches it (chunked on the queue, stopped when the model goes away).
 */

import { describe, it, expect } from 'vitest';
import { elementMatches } from '../src/inspector/matchValue';
import { ParameterFold, ValueTally } from '../src/inspector/parameterFold';
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

describe('ValueTally', () => {
  it('counts every distinct value with no cap, most common first', () => {
    const tally = new ValueTally('P.X');
    for (let i = 0; i < 300; i++) tally.add(props(i, [row('P.X', single(`v${i % 250}`))]));
    tally.add(props(999, [row('P.Y', single('other'))]));
    const values = tally.result();
    expect(values).toHaveLength(250);
    expect(values[0].count).toBe(2);
    expect(values.reduce((n, v) => n + v.count, 0)).toBe(300);
  });

  it('agrees with the fold below the cap', () => {
    const fold = new ParameterFold();
    const tally = new ValueTally('P.X');
    for (const v of ['a', 'b', 'a', 'c']) {
      const e = props(1, [row('P.X', single(v))]);
      fold.add(e);
      tally.add(e);
    }
    expect(tally.result()).toEqual(fold.result('m', 4).parameters[0].values);
  });
});

function harness() {
  const queue = new SerialQueue();
  const log: string[] = [];
  const posted: FromWorker[] = [];
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
        return props(id, [row('P.X', single(id % 2 === 0 ? 'even' : 'odd'))]);
      },
      post: (m) => posted.push(m),
    },
    2,
  );
  const reply = async (reqId: number): Promise<FromWorker> => {
    for (;;) {
      const r = posted.find((m) => (m.type === 'parameterValues' || m.type === 'error') && m.reqId === reqId);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 1));
    }
  };
  return { queue, log, posted, open, d, reply, setDuring: (f: () => void) => (during = f) };
}

describe('fetching one parameter\'s values in the worker', () => {
  it('reads in chunks, lets a click go first, and answers with counts', async () => {
    const h = harness();
    h.setDuring(() => setTimeout(() => h.queue.enqueue(async () => void h.log.push('getProps')), 0));
    h.d.requestValues(1, 'm', [1, 2, 3, 4, 5], 'P.X');
    const r = await h.reply(1);
    expect(r).toEqual({ type: 'parameterValues', reqId: 1, values: [{ value: 'odd', count: 3 }, { value: 'even', count: 2 }] });
    expect(h.log.indexOf('getProps')).toBe(2);
    expect(h.posted.some((m) => m.type === 'progress' && m.reqId === 1 && m.done === 5)).toBe(true);
  });

  it('runs alongside the description of the same model without either joining the other', async () => {
    const h = harness();
    h.d.request(1, 'm', [1, 2]);
    h.d.requestValues(2, 'm', [1, 2], 'P.X');
    await h.reply(2);
    expect(h.posted.some((m) => m.type === 'parameters' && m.reqId === 1)).toBe(true);
  });

  it('stops when the model is closed, and tells whoever waits', async () => {
    const h = harness();
    h.setDuring(() => {
      h.open.delete('m');
      h.d.drop('m');
    });
    h.d.requestValues(1, 'm', [1, 2, 3, 4, 5], 'P.X');
    const r = await h.reply(1);
    expect(r).toMatchObject({ type: 'error', message: expect.stringMatching(/closed/) });
    await new Promise((res) => setTimeout(res, 10));
    expect(h.log).toEqual(['read 1', 'read 2']);
    expect(h.d.isRunning('m')).toBe(false);
  });
});
