// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { ParameterList, visibleParameters } from '../src/ui/ParameterList';
import { followVisibility, VisibleCountsController, type VisibilitySources } from '../src/inspector/VisibleCountsController';
import { countVisible, visibleValueKey, type VisibleView } from '../src/inspector/visibleCounts';
import { columnValueCounts, type ColumnData } from '../src/inspector/parameterColumn';
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

  it('keeps the same eye button focused when the order changes', () => {
    const { host, list } = listWithOpenRow();
    list.setVisible(view({ Steel: 4, Wood: 1 }));
    const names = (): string[] => [...host.querySelectorAll('.param-value-text')].map((e) => e.textContent ?? '');
    expect(names()).toEqual(['Steel', 'Wood', 'Glass']);
    const eye = [...host.querySelectorAll<HTMLButtonElement>('.show-only-btn')].find((b) => b.getAttribute('aria-label')!.startsWith('Show only Steel'))!;
    eye.focus();
    // Wood now has more visible elements than Steel: the order swaps.
    list.setVisible(view({ Steel: 1, Wood: 3 }));
    expect(names()).toEqual(['Wood', 'Steel', 'Glass']);
    expect(document.activeElement).toBe(eye);
  });

  it('keeps a focused parameter row control focused when rows reorder by count', () => {
    const { host, list } = listWithOpenRow();
    list.setSort('count');
    const head = host.querySelector<HTMLButtonElement>('[data-key="C"] .param-head')!;
    head.focus();
    list.setVisible(
      view({}, 5, { C: { count: 9, values: new Map() }, B: { count: 1, values: new Map() } }),
    );
    expect([...host.querySelectorAll('.param-row')].map((e) => (e as HTMLElement).dataset.key)).toEqual(['C', 'A', 'B']);
    expect(document.activeElement).toBe(head);
  });
});

describe('order follows the numbers shown', () => {
  it('values: most visible first, ties by the whole model, zero-visible ones last but listed', () => {
    const { host, list } = listWithOpenRow();
    list.setVisible(view({ Wood: 1, Glass: 1 }));
    const rows = [...host.querySelectorAll('.param-value-item')].map(
      (li) => `${li.querySelector('.param-value-text')!.textContent} ${li.querySelector('.param-value-count')!.textContent}`,
    );
    expect(rows).toEqual(['Wood 1 of 3', 'Glass 1', 'Steel 0 of 6']);
  });

  it('parameter rows: sort by count uses the visible count where counted', () => {
    const v = view({}, 1, { B: { count: 5, values: new Map() }, C: { count: 2, values: new Map() } });
    expect(visibleParameters(DATA.parameters, '', 'count', v).map((p) => p.key)).toEqual(['B', 'C', 'A']);
    expect(visibleParameters(DATA.parameters, '', 'count').map((p) => p.key)).toEqual(['A', 'B', 'C']);
  });

  it('parameter rows: ties on the visible count fall back to the whole model count', () => {
    const v: VisibleView = {
      modelId: 'm',
      elements: 5,
      total: 10,
      parameters: new Map([
        ['A', { count: 2, values: new Map() }],
        ['B', { count: 2, values: new Map() }],
        ['C', { count: 2, values: new Map() }],
      ]),
    };
    expect(visibleParameters(DATA.parameters, '', 'count', v).map((p) => p.key)).toEqual(['A', 'B', 'C']);
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
