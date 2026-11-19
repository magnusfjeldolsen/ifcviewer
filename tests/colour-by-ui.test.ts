// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ColourByController } from '../src/inspector/ColourByController';
import type { ParameterColumn } from '../src/inspector/parameterColumn';
import { ColourLegend, scopeText } from '../src/ui/ColourLegend';
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
    // Text has no scale to choose.
    expect(el.querySelector('.colour-legend-palette')).toBeNull();
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
