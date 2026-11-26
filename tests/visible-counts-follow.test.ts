// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { ParameterList } from '../src/ui/ParameterList';
import { followVisibility, VisibleCountsController, type VisibilitySources } from '../src/inspector/VisibleCountsController';
import { countVisible, visibleValueKey, type OpenDetail, type VisibleView } from '../src/inspector/visibleCounts';
import { columnValueCounts, type ColumnData, type ParameterColumn } from '../src/inspector/parameterColumn';
import type { ModelParameters, ParameterSummary } from '../src/inspector/types';
import { boxModel, makeModelManager } from './helpers/models';

function summary(key: string, extra: Partial<ParameterSummary> = {}): ParameterSummary {
  return {
    key,
    count: 10,
    kind: 'text',
    distinct: 3,
    values: [
      { value: 'Steel', count: 6 },
      { value: 'Wood', count: 3 },
      { value: 'Glass', count: 1 },
    ],
    uniquePerElement: false,
    ...extra,
  };
}

const DATA: ModelParameters = { modelId: 'm', scopeSize: 10, parameters: [summary('A'), summary('B', { count: 8 }), summary('C', { count: 2 })] };

function view(a: Record<string, number>, count = 5, extra: Record<string, { count: number; values: Map<string, number> }> = {}): VisibleView {
  const values = new Map(Object.entries(a).map(([k, n]) => [visibleValueKey(k), n]));
  return { modelId: 'm', elements: 5, total: 10, parameters: new Map([['A', { count, values }], ...Object.entries(extra)]) };
}

function listWithOpenRow(): { host: HTMLElement; list: ParameterList } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const list = new ParameterList(host, { onShowOnly: () => {}, onPickValue: () => {} });
  list.setData(DATA);
  list.open('A');
  return { host, list };
}

describe('focus survives a recount', () => {
  it('keeps a focused eye button focused when counts change in place', () => {
    const { host, list } = listWithOpenRow();
    list.setVisible(view({ Steel: 3, Wood: 2 }));
    const eye = host.querySelectorAll<HTMLButtonElement>('.show-only-btn')[1];
    eye.focus();
    expect(document.activeElement).toBe(eye);
    list.setVisible(view({ Steel: 2, Wood: 1, Glass: 0 }, 3));
    expect(document.activeElement).toBe(eye);
    expect(eye.isConnected).toBe(true);
  });

});

const keys = (host: HTMLElement): (string | undefined)[] => [...host.querySelectorAll<HTMLElement>('.param-row')].map((e) => e.dataset.key);
const entries = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('.param-value-item')].map(
    (li) => `${li.querySelector('.param-value-text')!.textContent} ${li.querySelector('.param-value-count')!.textContent}`,
  );

describe('nothing moves because of a recount', () => {
  it('sorted by Count with something hidden, a row whose column finishes building stays where it is', () => {
    const host = document.createElement('div');
    const list = new ParameterList(host, {});
    list.setData(DATA);
    list.setSort('count');
    expect(keys(host)).toEqual(['A', 'B', 'C']);
    // Only A is counted at first.
    list.setVisible({ modelId: 'm', elements: 5, total: 10, parameters: new Map([['A', { count: 4, values: null }]]) });
    list.open('C');
    const before = [...host.querySelectorAll('.param-row')];
    // C's column finishes building and it has hardly any visible element; B is counted far below its whole-model count.
    list.setVisible({
      modelId: 'm',
      elements: 5,
      total: 10,
      parameters: new Map([
        ['A', { count: 4, values: null }],
        ['B', { count: 0, values: null }],
        ['C', { count: 5, values: new Map() }],
      ]),
    });
    expect(keys(host)).toEqual(['A', 'B', 'C']);
    expect([...host.querySelectorAll('.param-row')]).toEqual(before);
  });

  it('showing only one value leaves the values where they were, so the next click hits what it aimed at', () => {
    const { host, list } = listWithOpenRow();
    expect(entries(host)).toEqual(['Steel 6', 'Wood 3', 'Glass 1']);
    // The eye on Glass (C): only Glass remains.
    list.setVisible(view({ Glass: 1 }));
    expect(entries(host)).toEqual(['Steel 0', 'Wood 0', 'Glass 1']);
    const eyes = [...host.querySelectorAll<HTMLButtonElement>('.show-only-btn')];
    expect(eyes.map((b) => b.getAttribute('aria-label')!.split(' (')[0])).toEqual(['Show only Steel', 'Show only Wood', 'Show only Glass']);
    const items = [...host.querySelectorAll('.param-value-item')];
    expect(items.map((li) => li.classList.contains('none'))).toEqual([true, true, false]);
  });
});

describe('wording', () => {
  it('a value shows only its visible number, with the model total in a tooltip', () => {
    const { host, list } = listWithOpenRow();
    list.setVisible(view({ Steel: 2, Wood: 3 }));
    const first = host.querySelector<HTMLElement>('.param-value-count')!;
    expect(first.textContent).toBe('2');
    expect(first.title).toBe('2 of the 6 in the model can be seen');
    expect(entries(host).some((e) => e.includes(' of '))).toBe(false);
  });

  it('a counted row reads "N of M visible"; one not counted says "in model"', () => {
    const { host, list } = listWithOpenRow();
    list.setVisible(view({}, 4));
    const count = (k: string): HTMLElement => host.querySelector<HTMLElement>(`[data-key="${k}"] .param-count`)!;
    expect(count('A').textContent).toBe('4 of 5');
    expect(count('A').classList.contains('counted')).toBe(true);
    expect(count('B').textContent).toBe('8 of 10 in model');
    expect(count('B').classList.contains('counted')).toBe(false);
    expect(host.querySelector('.param-list-summary')!.textContent).toContain('Counting the 5 of 10 elements you can see');
  });

  it('a model switched off gets one line, not zeros', () => {
    const { host, list } = listWithOpenRow();
    list.setVisible({ modelId: 'm', off: true, elements: 0, total: 10, parameters: new Map() });
    expect(host.querySelector('.param-list-summary')!.textContent).toContain('Model is switched off');
    expect(host.querySelector('[data-key="A"] .param-count')!.textContent).toBe('10 of 10');
    expect(host.querySelector('.param-row.none')).toBeNull();
    expect(entries(host)).toEqual(['Steel 6', 'Wood 3', 'Glass 1']);
  });

  it('a parameter unique per element claims nothing per value', () => {
    const host = document.createElement('div');
    const list = new ParameterList(host, { loadValues: async () => [{ value: 7, count: 1 }, { value: 8, count: 1 }] });
    list.setData({ modelId: 'm', scopeSize: 10, parameters: [summary('U', { uniquePerElement: true, values: undefined, count: 10 })] });
    expect(list.openDetail()).toBeNull();
    list.open('U');
    expect(list.openDetail()).toEqual({ key: 'U', perValue: false });
    list.setVisible({ modelId: 'm', elements: 5, total: 10, parameters: new Map([['U', { count: 5, values: null }]]) });
    expect(host.querySelector('[data-key="U"] .param-count')!.textContent).toBe('5 of 5');
  });

  it('entries no longer listed leave the cache: a filtered-out value is built afresh', () => {
    const host = document.createElement('div');
    const list = new ParameterList(host, { onShowOnly: () => {} });
    const values = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, count: 12 - i }));
    list.setData({ modelId: 'm', scopeSize: 100, parameters: [summary('M', { distinct: 12, values, count: 78 })] });
    list.open('M');
    const find = (t: string): Element | undefined => [...host.querySelectorAll('.param-value-item')].find((li) => li.querySelector('.param-value-text')!.textContent === t);
    const v5 = find('v5')!;
    expect(find('v5')).toBe(v5);
    const filter = host.querySelector<HTMLInputElement>('.param-value-filter')!;
    filter.value = 'v1';
    filter.dispatchEvent(new Event('input'));
    expect(find('v5')).toBeUndefined();
    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    // Not kept while it was not listed: a new element, not the old one.
    expect(find('v5')).not.toBe(v5);
    expect(find('v5')).toBeDefined();
  });
});

describe('a row not counted for what can be seen yet', () => {
  it('marks its "without this parameter" line as the whole model', () => {
    const host = document.createElement('div');
    const list = new ParameterList(host);
    list.setData(DATA);
    list.open('B');
    const without = (): string | undefined => host.querySelector('.param-values-without')?.textContent ?? undefined;
    expect(without()).toBe('2 without this parameter');
    list.setVisible({ modelId: 'm', elements: 5, total: 10, parameters: new Map() });
    expect(without()).toBe('2 without this parameter in model');
    list.setVisible({ modelId: 'm', elements: 5, total: 10, parameters: new Map([['B', { count: 3, values: new Map() }]]) });
    expect(without()).toBe('2 without this parameter');
  });
});

describe('the value join between the list and the visible counts', () => {
  const columns: ColumnData[] = [
    {
      type: 'numeric',
      key: 'Mixed',
      count: 4,
      values: Float64Array.from([3, 3, 3, 5, NaN]),
      units: [
        { key: 'si:mm', symbol: 'mm' },
        { key: 'si:m', symbol: 'm' },
      ],
      unitIndex: Uint16Array.from([0, 0, 1, 0, 0]),
    },
    { type: 'numeric', key: 'Single', count: 4, values: Float64Array.from([1, 1, 2, NaN, 7]), units: [{ key: 'si:mm', symbol: 'mm' }], unitIndex: null },
    { type: 'discrete', key: 'Text', count: 4, codes: Int32Array.from([0, 1, 0, -1, 2]), dictionary: ['a', true, 4] },
  ];

  for (const c of columns) {
    it(`every value listed for ${c.key} finds its count when everything is visible`, () => {
      const all = Int32Array.from({ length: c.type === 'discrete' ? c.codes.length : c.values.length }, (_, i) => i);
      const seen = countVisible(c, all);
      const listed = columnValueCounts(c);
      expect(listed.length).toBeGreaterThan(0);
      for (const v of listed) expect(seen.values.get(visibleValueKey(v.value, v.unit?.key))).toBe(v.count);
      expect(seen.count).toBe(c.count);
    });
  }
});

describe('lines that merge numbers printed alike', () => {
  // Rows 0-3 are one line (16.7083), 4 is another; the discrete column mixes the same numbers with text.
  const nums = [16.7083, 16.70830000001, 16.7083, 16.70829999999, 20, NaN];
  const numeric: ColumnData = {
    type: 'numeric',
    key: 'Span',
    count: 5,
    values: Float64Array.from(nums),
    units: [{ key: 'ft', symbol: 'ft' }],
    unitIndex: null,
  };
  const mixedUnits: ColumnData = {
    ...numeric,
    key: 'SpanUnits',
    units: [
      { key: 'ft', symbol: 'ft' },
      { key: 'm', symbol: 'm' },
    ],
    unitIndex: Uint16Array.from([0, 0, 1, 1, 0, 0]),
  };
  const discrete: ColumnData = {
    type: 'discrete',
    key: 'Mix',
    count: 6,
    codes: Int32Array.from([0, 1, 2, 3, 4, 5]),
    dictionary: [16.7083, 16.70830000001, 16.70829999999, 'a', 20, 16.7083],
  };
  const asKeys = (c: ColumnData, rows: Int32Array): Map<string, number> => countVisible(c, rows).values;
  const listedKeys = (c: ColumnData): Map<string, number> =>
    new Map(columnValueCounts(c).map((v) => [visibleValueKey(v.value, v.unit?.key), v.count]));
  const rowsOf = (c: ColumnData, skip: number[] = []): Int32Array =>
    Int32Array.from(
      Array.from({ length: c.type === 'discrete' ? c.codes.length : c.values.length }, (_, i) => i).filter((i) => !skip.includes(i)),
    );

  for (const c of [numeric, mixedUnits, discrete]) {
    it(`${c.key}: the list and the visible counts agree key for key when everything is visible`, () => {
      expect(asKeys(c, rowsOf(c))).toEqual(listedKeys(c));
    });
  }

  it('hiding some members of a merged line lowers its count by exactly those', () => {
    const all = listedKeys(numeric).get(visibleValueKey(16.7083))!;
    expect(all).toBe(4);
    const some = asKeys(numeric, rowsOf(numeric, [1, 3])).get(visibleValueKey(16.7083));
    expect(some).toBe(all - 2);
    const none = asKeys(numeric, rowsOf(numeric, [0, 1, 2, 3])).get(visibleValueKey(16.7083));
    expect(none).toBeUndefined();
  });

  it('a visible count never exceeds its line', () => {
    for (const c of [numeric, mixedUnits, discrete]) {
      const listed = listedKeys(c);
      for (const [k, n] of asKeys(c, rowsOf(c, [0, 4]))) expect(n).toBeLessThanOrEqual(listed.get(k)!);
    }
  });
});

describe('how much a recount works out', () => {
  const ids = Int32Array.from([1, 2, 3, 4]);
  const text: ColumnData = { type: 'discrete', key: 'T', count: 3, codes: Int32Array.from([0, 1, 0, -1]), dictionary: ['a', 'b'] };
  const num: ColumnData = { type: 'numeric', key: 'N', count: 3, values: Float64Array.from([1, 2, NaN, 4]), units: [{ key: '', symbol: '' }], unitIndex: null };
  const make = (open: OpenDetail | null, shown = true) => {
    const onView = vi.fn();
    const c = new VisibleCountsController({
      scopeIds: () => ids,
      visibility: () => (id) => id !== 1,
      builtColumns: () => [text, num].map((x) => ({ ...x, modelId: 'm', ids }) as ParameterColumn),
      isShown: () => shown,
      openParameter: () => open,
      onView,
    });
    c.watch('m');
    return onView.mock.calls[0][0] as VisibleView;
  };

  it('counts only elements with a value per built column, and values for the open one only', () => {
    const v = make({ key: 'T', perValue: true });
    expect(v.parameters.get('T')!.count).toBe(2);
    expect(v.parameters.get('T')!.values!.get(visibleValueKey('b'))).toBe(1);
    expect(v.parameters.get('N')!.count).toBe(2);
    expect(v.parameters.get('N')!.values).toBeNull();
  });

  it('no per-value map at all with nothing open or for a parameter unique per element', () => {
    expect(make(null).parameters.get('T')!.values).toBeNull();
    expect(make({ key: 'N', perValue: false }).parameters.get('N')!.values).toBeNull();
  });

  it('a model switched off is one flag, with nothing counted', () => {
    const v = make({ key: 'T', perValue: true }, false);
    expect(v.off).toBe(true);
    expect(v.parameters.size).toBe(0);
  });
});

describe('what reaches the recount', () => {
  function sources(): { src: VisibilitySources; fire: Record<keyof VisibilitySources, () => void> } {
    const cbs: Partial<Record<keyof VisibilitySources, () => void>> = {};
    const on = (k: keyof VisibilitySources) => (cb: () => void) => {
      cbs[k] = cb;
    };
    const src: VisibilitySources = {
      appearanceChanged: on('appearanceChanged'),
      modelToggled: on('modelToggled'),
      clipStateChanged: on('clipStateChanged'),
      clipPlaneMoved: on('clipPlaneMoved'),
      loadIdle: on('loadIdle'),
    };
    const fire = Object.fromEntries(
      (Object.keys(src) as (keyof VisibilitySources)[]).map((k) => [k, () => cbs[k]!()]),
    ) as Record<keyof VisibilitySources, () => void>;
    return { src, fire };
  }

  for (const kind of ['appearanceChanged', 'modelToggled', 'clipStateChanged', 'clipPlaneMoved', 'loadIdle'] as const) {
    it(`${kind} makes the controller recount`, async () => {
      const onView = vi.fn();
      const controller = new VisibleCountsController({
        scopeIds: () => Int32Array.from([1, 2]),
        visibility: () => (id) => id === 1,
        builtColumns: () => [],
        onView,
        debounceMs: 1,
      });
      controller.watch('m');
      onView.mockClear();
      const { src, fire } = sources();
      followVisibility(src, controller);
      fire[kind]();
      await new Promise((r) => setTimeout(r, 15));
      expect(onView).toHaveBeenCalledTimes(1);
    });
  }

  it('a model switched on or off tells ModelManager listeners', () => {
    const { modelManager } = makeModelManager([boxModel('m1', [1])]);
    const cb = vi.fn();
    const off = modelManager.onModelVisibility(cb);
    modelManager.setVisible('m1', false);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    modelManager.setVisible('m1', true);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
