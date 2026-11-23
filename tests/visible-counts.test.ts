// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { countVisible, visibleRows, visibleValueKey, type VisibleView } from '../src/inspector/visibleCounts';
import { VisibleCountsController } from '../src/inspector/VisibleCountsController';
import { ParameterList, visibleCountText, visibleValueCountText } from '../src/ui/ParameterList';
import { ParametersPanel } from '../src/ui/ParametersPanel';
import type { ColumnData, ParameterColumn } from '../src/inspector/parameterColumn';
import type { ModelParameters, ParameterSummary } from '../src/inspector/types';

const IDS = Int32Array.from([10, 11, 12, 13, 14]);

// Rows 0..4: Steel, Steel, Wood, (none), Steel.
const material: ColumnData = {
  type: 'discrete',
  key: 'Material',
  count: 4,
  codes: Int32Array.from([0, 0, 1, -1, 0]),
  dictionary: ['Steel', 'Wood'],
};

// 3 mm, 3 mm, 3 m (a second unit), NaN, 5 mm.
const width: ColumnData = {
  type: 'numeric',
  key: 'Width',
  count: 4,
  values: Float64Array.from([3, 3, 3, NaN, 5]),
  units: [
    { key: 'si:mm', symbol: 'mm' },
    { key: 'si:m', symbol: 'm' },
  ],
  unitIndex: Uint16Array.from([0, 0, 1, 0, 0]),
};

describe('visibleRows', () => {
  it('is null when everything can be seen', () => {
    expect(visibleRows(IDS, () => true)).toBeNull();
  });
  it('lists the rows of what can be seen', () => {
    expect([...visibleRows(IDS, (id) => id !== 11 && id !== 14)!]).toEqual([0, 2, 3]);
  });
  it('is empty when nothing can be seen', () => {
    expect(visibleRows(IDS, () => false)!.length).toBe(0);
  });
});

describe('countVisible', () => {
  it('counts a text column over the rows given', () => {
    const c = countVisible(material, Int32Array.from([1, 2, 3]));
    expect(c.count).toBe(2);
    expect(c.values.get(visibleValueKey('Steel'))).toBe(1);
    expect(c.values.get(visibleValueKey('Wood'))).toBe(1);
  });
  it('keeps units apart in a mixed-unit number column', () => {
    const c = countVisible(width, Int32Array.from([0, 2, 3, 4]));
    expect(c.count).toBe(3);
    expect(c.values.get(visibleValueKey(3, 'si:mm'))).toBe(1);
    expect(c.values.get(visibleValueKey(3, 'si:m'))).toBe(1);
    expect(c.values.get(visibleValueKey(5, 'si:mm'))).toBe(1);
  });
  it('has no entry for a value nobody can see', () => {
    const c = countVisible(material, Int32Array.from([0, 1]));
    expect(c.values.has(visibleValueKey('Wood'))).toBe(false);
  });
});

describe('VisibleCountsController', () => {
  function setup(visible: (id: number) => boolean) {
    const onView = vi.fn();
    const built = vi.fn(() => [{ ...material, modelId: 'm', ids: IDS } as ParameterColumn]);
    let rule = visible;
    const c = new VisibleCountsController({
      scopeIds: () => IDS,
      visibility: () => rule,
      builtColumns: built,
      onView,
      debounceMs: 5,
    });
    return { c, onView, built, setRule: (r: (id: number) => boolean) => (rule = r) };
  }

  it('does nothing while no list is shown', async () => {
    const { c, onView, built } = setup((id) => id < 12);
    c.invalidate();
    await new Promise((r) => setTimeout(r, 20));
    expect(onView).not.toHaveBeenCalled();
    expect(built).not.toHaveBeenCalled();
  });

  it('reports null when everything can be seen', () => {
    const { c, onView } = setup(() => true);
    c.watch('m');
    expect(onView).toHaveBeenLastCalledWith(null);
  });

  it('counts the visible elements from built columns when watched', () => {
    const { c, onView } = setup((id) => id < 12);
    c.watch('m');
    const view = onView.mock.calls[0][0] as VisibleView;
    expect(view.elements).toBe(2);
    expect(view.total).toBe(5);
    expect(view.parameters.get('Material')!.count).toBe(2);
  });

  it('debounces changes into one recount', async () => {
    const { c, onView, setRule } = setup(() => true);
    c.watch('m');
    onView.mockClear();
    setRule((id) => id === 10);
    c.invalidate();
    c.invalidate();
    c.invalidate();
    expect(onView).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 30));
    expect(onView).toHaveBeenCalledTimes(1);
    expect((onView.mock.calls[0][0] as VisibleView).elements).toBe(1);
  });

  it('stops counting when the list is no longer shown', async () => {
    const { c, onView } = setup((id) => id < 12);
    c.watch('m');
    onView.mockClear();
    c.invalidate();
    c.watch(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(onView).not.toHaveBeenCalled();
  });

  it('counts nothing as visible when the model is switched off', () => {
    const { c, onView } = setup(() => false);
    c.watch('m');
    const view = onView.mock.calls[0][0] as VisibleView;
    expect(view.elements).toBe(0);
    expect(view.parameters.get('Material')!.count).toBe(0);
  });
});

function summary(key: string, extra: Partial<ParameterSummary> = {}): ParameterSummary {
  return { key, count: 4, kind: 'text', distinct: 2, values: [{ value: 'Steel', count: 3 }, { value: 'Wood', count: 1 }], uniquePerElement: false, ...extra };
}

const DATA: ModelParameters = { modelId: 'm', scopeSize: 5, parameters: [summary('Material'), summary('Other')] };

function viewOf(visibleMaterial: Map<string, number>, count: number): VisibleView {
  return { modelId: 'm', elements: 2, total: 5, parameters: new Map([['Material', { count, values: visibleMaterial }]]) };
}

describe('counts in the list', () => {
  it('texts: whole model, visible, or whole model marked as such', () => {
    const p = DATA.parameters[0];
    expect(visibleCountText(p, 5, null)).toBe('4 of 5');
    expect(visibleCountText(p, 5, viewOf(new Map(), 2))).toBe('2 of 2');
    expect(visibleCountText(DATA.parameters[1], 5, viewOf(new Map(), 2))).toBe('4 of 5 in model');
    expect(visibleValueCountText(3, null)).toBe('3');
    expect(visibleValueCountText(3, 3)).toBe('3');
    expect(visibleValueCountText(3, 1)).toBe('1 of 3');
  });

  it('shows visible counts, keeps zero-visible values listed and dimmed, and updates in place', () => {
    const host = document.createElement('div');
    const list = new ParameterList(host, { onShowOnly: () => {}, onPickValue: () => {} });
    list.setData(DATA);
    list.open('Material');
    const counts = (): string[] => [...host.querySelectorAll('.param-value-count')].map((e) => e.textContent ?? '');
    expect(counts()).toEqual(['3', '1']);

    list.setVisible(viewOf(new Map([[visibleValueKey('Steel'), 2]]), 2));
    expect(counts()).toEqual(['2 of 3', '0 of 1']);
    const items = [...host.querySelectorAll('.param-value-item')];
    expect(items).toHaveLength(2);
    expect(items[0].classList.contains('none')).toBe(false);
    expect(items[1].classList.contains('none')).toBe(true);
    expect(host.querySelector('[data-key="Material"] .param-count')!.textContent).toBe('2 of 2');
    expect(host.querySelector('[data-key="Other"] .param-count')!.textContent).toBe('4 of 5 in model');
    expect(host.querySelector('.param-list-summary')!.textContent).toContain('2 of 5 elements that can be seen');

    list.setVisible(null);
    expect(counts()).toEqual(['3', '1']);
    expect(host.querySelector('[data-key="Material"] .param-count')!.textContent).toBe('4 of 5');
    expect(host.querySelector('.param-list-summary')!.textContent).not.toContain('can be seen');
  });

  it('ignores a view of another model', () => {
    const host = document.createElement('div');
    const list = new ParameterList(host);
    list.setData(DATA);
    list.setVisible({ ...viewOf(new Map(), 2), modelId: 'other' });
    expect(host.querySelector('[data-key="Material"] .param-count')!.textContent).toBe('4 of 5');
  });
});

describe('panel tells when the list is on screen', () => {
  it('watches the open model on its Parameters tab, and nothing otherwise', async () => {
    const watch = vi.fn();
    const totals = { getElement: () => document.createElement('div'), setShown: vi.fn() };
    const panel = new ParametersPanel(document.body, {
      getModels: () => [{ id: 'm', name: 'M' }],
      describe: async () => DATA,
      totals,
      watchVisibility: watch,
    });
    panel.open('m');
    expect(watch).toHaveBeenLastCalledWith('m');
    panel.showTab('totals');
    expect(watch).toHaveBeenLastCalledWith(null);
    panel.showTab('parameters');
    expect(watch).toHaveBeenLastCalledWith('m');
    panel.close();
    expect(watch).toHaveBeenLastCalledWith(null);
  });
});
