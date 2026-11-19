// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ColourByController } from '../src/inspector/ColourByController';
import type { ParameterColumn } from '../src/inspector/parameterColumn';
import { ColourLegend, ENTRIES_SHOWN, countsText, loadColourValueCount, scopeText } from '../src/ui/ColourLegend';
import { ParameterPicker, filterPickerRows } from '../src/ui/ParameterPicker';
import { ParameterList } from '../src/ui/ParameterList';
import { buildContextMenuItems, type ContextMenuActions } from '../src/ui/contextMenuItems';
import type { ModelParameters, SelectionState } from '../src/inspector/types';

function textColumn(modelId: string, values: (string | null)[]): ParameterColumn {
  const dictionary: string[] = [];
  const codes = values.map((v) => {
    if (v === null) return -1;
    let c = dictionary.indexOf(v);
    if (c < 0) c = dictionary.push(v) - 1;
    return c;
  });
  return {
    type: 'discrete',
    key: 'Pset_Common.FireRating',
    count: codes.filter((c) => c >= 0).length,
    codes: Int32Array.from(codes),
    dictionary,
    modelId,
    ids: Int32Array.from(values.map((_, i) => i + 1)),
  };
}

function numberColumn(modelId: string, values: number[]): ParameterColumn {
  return {
    type: 'numeric',
    key: 'Dimensions.Length',
    count: values.length,
    values: Float64Array.from(values),
    units: [{ key: 'LENGTHUNIT:MILLI:METRE', symbol: 'mm' }],
    unitIndex: null,
    modelId,
    ids: Int32Array.from(values.map((_, i) => i + 1)),
  };
}

function makeController(column: ParameterColumn) {
  const paint = { setDataColors: vi.fn(), clearDataColors: vi.fn() };
  const select = vi.fn();
  const controller = new ColourByController({ loadColumn: async () => column, paint, select });
  return { controller, paint, select };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('colour legend', () => {
  it('is hidden until something is coloured, and lists entries with swatch, value and count', async () => {
    const { controller } = makeController(textColumn('m', ['EI 60', 'EI 60', 'EI 30', null]));
    const legend = new ColourLegend(document.body, { controller, modelName: () => 'Tower' });
    expect(legend.isOpen()).toBe(false);

    await controller.colourBy('Pset_Common.FireRating', { kind: 'model', modelId: 'm' });
    expect(legend.isOpen()).toBe(true);
    const el = legend.getContainer();
    expect(el.querySelector('.colour-legend-name')!.textContent).toBe('FireRating');
    expect(el.querySelector('.colour-legend-scope')!.textContent).toBe('Whole model · Tower · 4 elements');
    const rows = [...el.querySelectorAll('.colour-legend-entry')].map((li) => [
      li.querySelector('.colour-legend-label')!.textContent,
      li.querySelector('.colour-legend-count')!.textContent,
    ]);
    expect(rows).toEqual([
      ['EI 60', '2'],
      ['EI 30', '1'],
      ['No value', '1'],
    ]);
    // Text has no scale to choose; it has a choice of how many values get their own colour.
    expect(el.querySelector('select[aria-label="Colour scale"]')).toBeNull();
    expect(el.querySelector('.colour-legend-count-choice')).not.toBeNull();
  });

  it('ticks and unticks entries, all / none, and repaints each time', async () => {
    const { controller, paint } = makeController(textColumn('m', ['a', 'b']));
    const legend = new ColourLegend(document.body, { controller, modelName: () => 'Tower' });
    await controller.colourBy('k', { kind: 'model', modelId: 'm' });
    const el = legend.getContainer();
    const box = el.querySelector<HTMLInputElement>('.colour-legend-entry input')!;
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(el.querySelector('.colour-legend-entry')!.classList.contains('off')).toBe(true);
    // The first element's colour is NaN: its own.
    const rgba = paint.setDataColors.mock.calls[paint.setDataColors.mock.calls.length - 1][2] as Float32Array;
    expect(Number.isNaN(rgba[0])).toBe(true);

    const none = [...el.querySelectorAll<HTMLButtonElement>('.colour-legend-btn')].find((b) => b.textContent === 'None')!;
    none.click();
    expect([...el.querySelectorAll<HTMLInputElement>('.colour-legend-entry input')].every((b) => !b.checked)).toBe(true);
    const all = [...el.querySelectorAll<HTMLButtonElement>('.colour-legend-btn')].find((b) => b.textContent === 'All')!;
    all.click();
    expect([...el.querySelectorAll<HTMLInputElement>('.colour-legend-entry input')].every((b) => b.checked)).toBe(true);
  });

  it('clicking an entry selects its elements; Clear ends the colouring', async () => {
    const { controller, select, paint } = makeController(textColumn('m', ['a', 'b', 'a']));
    const legend = new ColourLegend(document.body, { controller, modelName: () => 'Tower' });
    await controller.colourBy('k', { kind: 'model', modelId: 'm' });
    const el = legend.getContainer();
    el.querySelector<HTMLButtonElement>('.colour-legend-label')!.click();
    expect(select).toHaveBeenCalledWith([
      { modelId: 'm', expressId: 1 },
      { modelId: 'm', expressId: 3 },
    ]);
    el.querySelector<HTMLButtonElement>('.colour-legend-close')!.click();
    expect(legend.isOpen()).toBe(false);
    expect(paint.clearDataColors).toHaveBeenCalledWith('m');
  });

  it('a numeric colouring shows its scale with the unit, and offers the colour scales', async () => {
    const values = Array.from({ length: 40 }, (_, i) => 100 + i * 25);
    const { controller } = makeController(numberColumn('m', values));
    const legend = new ColourLegend(document.body, { controller, modelName: () => 'Tower' });
    await controller.colourBy('Dimensions.Length', { kind: 'model', modelId: 'm' });
    const el = legend.getContainer();
    expect(el.querySelector('.colour-legend-ends')!.textContent).toBe('100 mm1075 mm');
    const select = el.querySelector<HTMLSelectElement>('.colour-legend-palette')!;
    expect([...select.options].map((o) => o.value)).toEqual(['red-green', 'colour-blind-safe']);
    select.value = 'colour-blind-safe';
    select.dispatchEvent(new Event('change'));
    expect(el.querySelector<HTMLSelectElement>('.colour-legend-palette')!.value).toBe('colour-blind-safe');
  });

  it('says it is reading while the values are built, and why it failed if it did', async () => {
    let fail: (e: Error) => void = () => {};
    const controller = new ColourByController({
      loadColumn: (_m, _k, onProgress) =>
        new Promise((_, reject) => {
          onProgress(5, 10);
          fail = reject;
        }),
      paint: { setDataColors: vi.fn(), clearDataColors: vi.fn() },
    });
    const legend = new ColourLegend(document.body, { controller, modelName: () => 'Tower' });
    const done = controller.colourBy('k', { kind: 'model', modelId: 'm' });
    await Promise.resolve();
    expect(legend.getContainer().querySelector('.colour-legend-status')!.textContent).toBe('Reading values… 5 of 10 elements');
    fail(new Error('the model was closed'));
    await done;
    expect(legend.getContainer().querySelector('.colour-legend-status')!.textContent).toMatch(/the model was closed/);
  });

  it('names the scope: a whole model, or a selection in one or several models', () => {
    const name = (id: string): string => ({ a: 'Tower', b: 'Annex' })[id] ?? id;
    expect(scopeText({ kind: 'model', modelId: 'a' }, name)).toBe('Whole model · Tower');
    expect(scopeText({ kind: 'selection', elements: new Map([['b', [1]]]) }, name)).toBe('Selection · Annex');
    expect(scopeText({ kind: 'selection', elements: new Map([['a', [1]], ['b', [2]]]) }, name)).toBe('Selection · 2 models');
  });
});

describe('parameter picker (right-click "Colour by parameter…")', () => {
  const ROWS = [
    { key: 'Identity.Name', value: 'Wall A' },
    { key: 'Pset_WallCommon.FireRating', value: 'EI 60' },
    { key: 'Qto_WallBaseQuantities.Width', value: '200 mm' },
  ];

  it('filters by name or value', () => {
    expect(filterPickerRows(ROWS, 'fire').map((r) => r.key)).toEqual(['Pset_WallCommon.FireRating']);
    expect(filterPickerRows(ROWS, '200').map((r) => r.key)).toEqual(['Qto_WallBaseQuantities.Width']);
    expect(filterPickerRows(ROWS, '  ')).toHaveLength(3);
  });

  it('types to narrow, Enter picks the first match and closes', () => {
    const picker = new ParameterPicker(document.body);
    const onPick = vi.fn();
    picker.open(10, 10, 'Colour the whole model by', ROWS, onPick);
    const input = document.querySelector<HTMLInputElement>('.param-picker-filter')!;
    expect(document.activeElement).toBe(input);
    input.value = 'width';
    input.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.param-picker-row')).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onPick).toHaveBeenCalledWith('Qto_WallBaseQuantities.Width');
    expect(picker.isOpen()).toBe(false);
  });

  it('arrow keys move the choice; a click picks; Escape closes without picking', () => {
    const picker = new ParameterPicker(document.body);
    const onPick = vi.fn();
    picker.open(10, 10, 'h', ROWS, onPick);
    const input = document.querySelector<HTMLInputElement>('.param-picker-filter')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(document.querySelectorAll('.param-picker-row')[1].classList.contains('active')).toBe(true);
    document.querySelectorAll<HTMLElement>('.param-picker-row')[2].click();
    expect(onPick).toHaveBeenCalledWith('Qto_WallBaseQuantities.Width');

    picker.open(10, 10, 'h', ROWS, onPick);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(picker.isOpen()).toBe(false);
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

describe('colour button on a parameter row', () => {
  const DATA: ModelParameters = {
    modelId: 'm',
    scopeSize: 10,
    parameters: [
      { key: 'Pset_Common.FireRating', count: 10, kind: 'text', distinct: 2, uniquePerElement: false },
      { key: 'Identity.Name', count: 10, kind: 'text', distinct: 9, uniquePerElement: false },
    ],
  };

  it('asks to colour by that parameter, without opening the row', () => {
    const onColourBy = vi.fn();
    const list = new ParameterList(document.body, { onColourBy });
    list.setData(DATA);
    document.querySelector<HTMLButtonElement>('.param-row[data-key="Identity.Name"] .param-colour-btn')!.click();
    expect(onColourBy).toHaveBeenCalledWith(DATA.parameters[1]);
    expect(list.openRow()).toBeNull();
  });

  it('marks the parameter being coloured by', () => {
    const list = new ParameterList(document.body, { onColourBy: () => {} });
    list.setData(DATA);
    list.setColouredKey('Identity.Name');
    const btn = (k: string): HTMLElement => document.querySelector(`.param-row[data-key="${k}"] .param-colour-btn`)!;
    expect(btn('Identity.Name').classList.contains('active')).toBe(true);
    expect(btn('Pset_Common.FireRating').classList.contains('active')).toBe(false);
    // Survives the row being rebuilt (opened).
    list.open('Identity.Name');
    expect(btn('Identity.Name').getAttribute('aria-pressed')).toBe('true');
    list.setColouredKey(null);
    expect(btn('Identity.Name').classList.contains('active')).toBe(false);
  });

  it('is not there when nothing can colour', () => {
    const list = new ParameterList(document.body, {});
    list.setData(DATA);
    expect(document.querySelector('.param-colour-btn')).toBeNull();
  });
});

describe('right-click menu: colour by parameter', () => {
  const single: SelectionState = { kind: 'single', identities: [{ modelId: 'A', expressId: 1, ifcClass: 'IfcWall', ifcTypeCode: 1 }] };
  function actions(): ContextMenuActions & { calls: string[] } {
    const calls: string[] = [];
    const push = (name: string) => () => void calls.push(name);
    return {
      calls,
      hide: push('hide'),
      isolate: push('isolate'),
      showAll: push('showAll'),
      transparent: push('transparent'),
      opaque: push('opaque'),
      clearTransparency: push('clearTransparency'),
      addToBasket: push('addToBasket'),
      selectSimilarCategory: push('similarCategory'),
      selectSimilarType: push('similarType'),
      colourBy: push('colourBy'),
      clearColours: push('clearColours'),
    };
  }

  it('offers "Colour by parameter…" for a selection, and "Clear colours" while one is shown', () => {
    const a = actions();
    const off = buildContextMenuItems(single, { hasHidden: false, hasTransparent: false }, a)!;
    expect(off.some((i) => i.label === 'Colour by parameter…')).toBe(true);
    expect(off.some((i) => i.label === 'Clear colours')).toBe(false);
    const on = buildContextMenuItems(single, { hasHidden: false, hasTransparent: false, hasColouring: true }, a)!;
    on.find((i) => i.label === 'Colour by parameter…')!.onClick!();
    on.find((i) => i.label === 'Clear colours')!.onClick!();
    expect(a.calls).toEqual(['colourBy', 'clearColours']);
  });

  it('with nothing selected, a shown colouring can still be cleared', () => {
    const a = actions();
    expect(buildContextMenuItems({ kind: 'none' }, { hasHidden: false, hasTransparent: false }, a)).toBeNull();
    const items = buildContextMenuItems({ kind: 'none' }, { hasHidden: false, hasTransparent: false, hasColouring: true }, a)!;
    expect(items.map((i) => i.label)).toEqual(['Clear colours']);
  });

  it('callers without colouring get the menu they had', () => {
    const { colourBy: _c, clearColours: _x, ...rest } = actions();
    void _c;
    void _x;
    const items = buildContextMenuItems(single, { hasHidden: false, hasTransparent: false, hasColouring: true }, rest)!;
    expect(items.some((i) => /colour/i.test(i.label ?? ''))).toBe(false);
  });
});

describe('colour legend keeps the keyboard in place', () => {
  async function shown(column: ParameterColumn) {
    const { controller } = makeController(column);
    const origin = document.createElement('button');
    document.body.appendChild(origin);
    origin.focus();
    const legend = new ColourLegend(document.body, { controller, modelName: () => 'Tower' });
    await controller.colourBy('k', { kind: 'model', modelId: 'm' });
    return { controller, legend, origin, el: legend.getContainer() };
  }
  const button = (el: HTMLElement, text: string): HTMLButtonElement =>
    [...el.querySelectorAll<HTMLButtonElement>('.colour-legend-btn')].find((b) => b.textContent === text)!;

  it('a ticked checkbox keeps focus though the legend is redrawn', async () => {
    const { el } = await shown(textColumn('m', ['a', 'b']));
    const box = el.querySelectorAll<HTMLInputElement>('.colour-legend-entry input')[1];
    box.focus();
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(document.activeElement).toBe(el.querySelectorAll('.colour-legend-entry input')[1]);
  });

  it('None, once it has turned itself off, hands focus to All', async () => {
    const { el } = await shown(textColumn('m', ['a', 'b']));
    button(el, 'None').focus();
    button(el, 'None').click();
    expect(document.activeElement).toBe(button(el, 'All'));
  });

  it('the colour scale keeps focus after a change', async () => {
    const { el } = await shown(numberColumn('m', Array.from({ length: 30 }, (_, i) => i)));
    const select = el.querySelector<HTMLSelectElement>('.colour-legend-palette')!;
    select.focus();
    select.value = 'colour-blind-safe';
    select.dispatchEvent(new Event('change'));
    expect(document.activeElement).toBe(el.querySelector('.colour-legend-palette'));
  });

  it('Clear gives focus back to what started the colouring', async () => {
    const { el, origin } = await shown(textColumn('m', ['a', 'b']));
    button(el, 'Clear colours').focus();
    button(el, 'Clear colours').click();
    expect(document.activeElement).toBe(origin);
  });
});
describe('parameter picker for screen readers and the keyboard', () => {
  const ROWS = [
    { key: 'Identity.Name', value: 'Wall A' },
    { key: 'Pset_WallCommon.FireRating', value: 'EI 60' },
  ];

  it('is a combobox over a listbox, naming the row the arrow keys are on', () => {
    const picker = new ParameterPicker(document.body);
    picker.open(0, 0, 'h', ROWS, () => {});
    const input = document.querySelector<HTMLInputElement>('.param-picker-filter')!;
    const list = document.querySelector<HTMLElement>('.param-picker-list')!;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(list.getAttribute('role')).toBe('listbox');
    const rows = document.querySelectorAll<HTMLElement>('.param-picker-row');
    expect(input.getAttribute('aria-activedescendant')).toBe(rows[0].id);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(input.getAttribute('aria-activedescendant')).toBe(rows[1].id);
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
    input.value = 'nothing like it';
    input.dispatchEvent(new Event('input'));
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('gives focus back to where it was when it closes', () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    const picker = new ParameterPicker(document.body);
    picker.open(0, 0, 'h', ROWS, () => {});
    expect(document.activeElement).not.toBe(before);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.activeElement).toBe(before);
  });
});
describe('colour legend: how many values, many values, refresh', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // no storage
    }
  });

  function manyValues(n: number): ParameterColumn {
    return textColumn('m', Array.from({ length: n * 2 }, (_, i) => `Type ${String(i % n).padStart(4, '0')}`));
  }

  it('chooses how many values get their own colour, and remembers it', async () => {
    const { controller } = makeController(manyValues(30));
    const legend = new ColourLegend(document.body, { controller, modelName: () => 'Tower' });
    await controller.colourBy('k', { kind: 'model', modelId: 'm' });
    const el = legend.getContainer();
    expect(el.querySelectorAll('.colour-legend-entry')).toHaveLength(13); // 12 + other
    const choice = el.querySelector<HTMLSelectElement>('.colour-legend-count-choice')!;
    choice.value = 'Infinity';
    choice.dispatchEvent(new Event('change'));
    expect(el.querySelectorAll('.colour-legend-entry')).toHaveLength(30);
    expect(loadColourValueCount()).toBe(Infinity);
    choice.value = '6';
    el.querySelector<HTMLSelectElement>('.colour-legend-count-choice')!.value = '6';
    el.querySelector<HTMLSelectElement>('.colour-legend-count-choice')!.dispatchEvent(new Event('change'));
    expect(loadColourValueCount()).toBe(6);
  });

  it('with a thousand values: draws at most a page of rows, and a filter finds the rest', async () => {
    const { controller } = makeController(manyValues(1000));
    controller.setMaxValues(Infinity);
    const legend = new ColourLegend(document.body, { controller, modelName: () => 'Tower' });
    await controller.colourBy('k', { kind: 'model', modelId: 'm' });
    const el = legend.getContainer();
    expect(el.querySelectorAll('.colour-legend-entry')).toHaveLength(ENTRIES_SHOWN);
    expect(el.querySelector('.colour-legend-status')!.textContent).toMatch(/Showing 200 of 1,000/);
    const filter = el.querySelector<HTMLInputElement>('.colour-legend-filter')!;
    filter.focus();
    filter.value = '0999';
    filter.dispatchEvent(new Event('input'));
    const rows = el.querySelectorAll('.colour-legend-entry');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.colour-legend-label')!.textContent).toBe('Type 0999');
    // Typing keeps the keyboard in the filter.
    expect(document.activeElement).toBe(el.querySelector('.colour-legend-filter'));
    // Ticking the row found ticks that value, not the first row's.
    const box = rows[0].querySelector<HTMLInputElement>('input')!;
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    const s = controller.getState();
    if (s.phase !== 'shown') throw new Error('not shown');
    expect(s.ticked[s.plan.entries.findIndex((e) => e.label === 'Type 0999')]).toBe(false);
    expect(s.ticked.filter((t) => !t)).toHaveLength(1);
  });

  it('a thousand-value legend is drawn quickly', async () => {
    const { controller } = makeController(manyValues(1000));
    controller.setMaxValues(Infinity);
    const legend = new ColourLegend(document.body, { controller, modelName: () => 'Tower' });
    const t0 = performance.now();
    await controller.colourBy('k', { kind: 'model', modelId: 'm' });
    controller.setTicked(5, false);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(legend.isOpen()).toBe(true);
  });

  it('says how many of the elements were visible, and marks Refresh when out of date', async () => {
    const column = textColumn('m', ['a', 'b', 'a', 'b']);
    const paint = { setDataColors: vi.fn(), clearDataColors: vi.fn() };
    let hidden = new Set([4]);
    const controller = new ColourByController({
      loadColumn: async () => column,
      paint,
      visibility: () => (id) => !hidden.has(id),
    });
    const legend = new ColourLegend(document.body, { controller, modelName: () => 'Tower' });
    await controller.colourBy('k', { kind: 'model', modelId: 'm' });
    const el = legend.getContainer();
    expect(el.querySelector('.colour-legend-scope')!.textContent).toBe('Whole model · Tower · 3 of 4 visible');
    const refresh = (): HTMLButtonElement => el.querySelector<HTMLButtonElement>('.colour-legend-refresh')!;
    expect(refresh().classList.contains('stale')).toBe(false);
    hidden = new Set();
    controller.markStale();
    expect(refresh().classList.contains('stale')).toBe(true);
    refresh().click();
    expect(el.querySelector('.colour-legend-scope')!.textContent).toBe('Whole model · Tower · 4 elements');
    expect(refresh().classList.contains('stale')).toBe(false);
  });

  it('counts text', () => {
    expect(countsText(1235, 1235)).toBe('1,235 elements');
    expect(countsText(412, 1235)).toBe('412 of 1,235 visible');
  });

  it('the right-click menu offers Refresh colours while a colouring is shown', () => {
    const calls: string[] = [];
    const noop = () => {};
    const actions = {
      hide: noop, isolate: noop, showAll: noop, transparent: noop, opaque: noop, clearTransparency: noop,
      addToBasket: noop, selectSimilarCategory: noop, selectSimilarType: noop,
      colourBy: noop, clearColours: noop, refreshColours: () => void calls.push('refresh'),
    };
    const items = buildContextMenuItems({ kind: 'none' }, { hasHidden: false, hasTransparent: false, hasColouring: true }, actions)!;
    expect(items.map((i) => i.label)).toEqual(['Refresh colours', 'Clear colours']);
    items[0].onClick!();
    expect(calls).toEqual(['refresh']);
  });
});