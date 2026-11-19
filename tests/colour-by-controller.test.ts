import * as THREE from 'three';
import { describe, it, expect, vi } from 'vitest';
import { ColourByController, colourScopeFor, isColouringBy, type ColourByDeps } from '../src/inspector/ColourByController';
import type { ModelManager } from '../src/viewer/ModelManager';
import type { ParameterColumn } from '../src/inspector/parameterColumn';
import { makeModelManager, boxModel } from './helpers/models';

/** A text column over elements `ids`: `values[i]` for element ids[i], null for none. */
function textColumn(modelId: string, ids: number[], values: (string | null)[]): ParameterColumn {
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
    ids: Int32Array.from(ids),
  };
}

const RED = { r: 1, g: 0, b: 0, a: 1 };

function setup(columns: Record<string, ParameterColumn>) {
  const { modelManager } = makeModelManager([boxModel('a', [1, 2, 3], { color: RED }), boxModel('b', [1, 2], { color: RED })]);
  const select = vi.fn();
  const deps: ColourByDeps = {
    loadColumn: vi.fn(async (modelId: string) => {
      const c = columns[modelId];
      if (!c) throw new Error('no column');
      return c;
    }),
    paint: modelManager,
    select,
  };
  return { modelManager, controller: new ColourByController(deps), select, deps };
}

describe('ColourByController', () => {
  it('colours a whole model and clears back to its own colours', async () => {
    const { modelManager, controller } = setup({ a: textColumn('a', [1, 2, 3], ['EI 30', 'EI 60', null]) });
    modelManager.setColor('a', [2], { r: 0, g: 0, b: 1 });
    await controller.colourBy('Pset_Common.FireRating', { kind: 'model', modelId: 'a' });

    const s = controller.getState();
    expect(s.phase).toBe('shown');
    expect(modelManager.getElementState('a', 1)!.dataColored).toBe(true);
    expect(modelManager.getElementState('a', 3)!.dataColored).toBe(true); // "no value" grey
    expect(modelManager.getElementState('b', 1)!.dataColored).toBe(false);

    controller.clear();
    expect(controller.getState().phase).toBe('off');
    expect(modelManager.getElementState('a', 1)).toMatchObject({ dataColored: false, color: { r: 1, g: 0, b: 0 } });
    // A colour override that was there before is there after.
    expect(modelManager.getElementState('a', 2)).toMatchObject({ color: { r: 0, g: 0, b: 1 }, colorOverridden: true });
  });

  it('a selection across models shares one legend and colours only the selection', async () => {
    const { modelManager, controller } = setup({
      a: textColumn('a', [1, 2, 3], ['x', 'y', 'x']),
      b: textColumn('b', [1, 2], ['x', 'x']),
    });
    await controller.colourBy('k', {
      kind: 'selection',
      elements: new Map([
        ['a', [1, 2]],
        ['b', [2]],
      ]),
    });
    const s = controller.getState();
    if (s.phase !== 'shown') throw new Error('not shown');
    expect(s.plan.entries.map((e) => [e.label, e.count])).toEqual([
      ['x', 2],
      ['y', 1],
    ]);
    expect(modelManager.getElementState('a', 3)!.dataColored).toBe(false);
    expect(modelManager.getElementState('b', 1)!.dataColored).toBe(false);
    expect(modelManager.getElementState('b', 2)!.color).toEqual(modelManager.getElementState('a', 1)!.color);
  });

  it('unticking an entry gives its elements their own colour; all/none tick everything', async () => {
    const { modelManager, controller } = setup({ a: textColumn('a', [1, 2, 3], ['x', 'y', 'x']) });
    await controller.colourBy('k', { kind: 'model', modelId: 'a' });
    controller.setTicked(0, false);
    expect(modelManager.getElementState('a', 1)!.dataColored).toBe(false);
    expect(modelManager.getElementState('a', 2)!.dataColored).toBe(true);
    controller.setAllTicked(false);
    expect(modelManager.getElementState('a', 2)!.dataColored).toBe(false);
    controller.setAllTicked(true);
    expect(modelManager.getElementState('a', 1)!.dataColored).toBe(true);
    expect(modelManager.getElementState('a', 2)!.dataColored).toBe(true);
  });

  it('starting another colouring ends the first', async () => {
    const { modelManager, controller } = setup({
      a: textColumn('a', [1, 2, 3], ['x', 'x', 'x']),
      b: textColumn('b', [1, 2], ['x', 'y']),
    });
    await controller.colourBy('k', { kind: 'model', modelId: 'a' });
    await controller.colourBy('k', { kind: 'model', modelId: 'b' });
    expect(modelManager.getElementState('a', 1)!.dataColored).toBe(false);
    expect(modelManager.getElementState('b', 1)!.dataColored).toBe(true);
  });

  it('a reading overtaken by a clear paints nothing', async () => {
    const { modelManager, controller } = setup({ a: textColumn('a', [1, 2, 3], ['x', 'x', 'x']) });
    const done = controller.colourBy('k', { kind: 'model', modelId: 'a' });
    expect(controller.getState().phase).toBe('reading');
    controller.clear();
    await done;
    expect(controller.getState().phase).toBe('off');
    expect(modelManager.getElementState('a', 1)!.dataColored).toBe(false);
  });

  it('reports a failed read in its state', async () => {
    const { controller } = setup({});
    await controller.colourBy('k', { kind: 'model', modelId: 'a' });
    expect(controller.getState()).toMatchObject({ phase: 'failed', message: 'no column' });
  });

  it('selecting an entry selects its elements', async () => {
    const { controller, select } = setup({ a: textColumn('a', [1, 2, 3], ['x', 'y', 'x']) });
    await controller.colourBy('k', { kind: 'model', modelId: 'a' });
    controller.selectEntry(0);
    expect(select).toHaveBeenCalledWith([
      { modelId: 'a', expressId: 1 },
      { modelId: 'a', expressId: 3 },
    ]);
  });

  it('closing a model drops it from the colouring, and ends it when nothing is left', async () => {
    const { controller } = setup({
      a: textColumn('a', [1, 2, 3], ['x', 'y', 'x']),
      b: textColumn('b', [1, 2], ['y', 'y']),
    });
    await controller.colourBy('k', { kind: 'selection', elements: new Map([['a', [1, 2, 3]], ['b', [1, 2]]]) });
    controller.onModelRemoved('b');
    const s = controller.getState();
    if (s.phase !== 'shown') throw new Error('not shown');
    expect(s.plan.entries.map((e) => [e.label, e.count])).toEqual([
      ['x', 2],
      ['y', 1],
    ]);
    controller.onModelRemoved('a');
    expect(controller.getState().phase).toBe('off');
  });

  it('a different palette recolours a numeric colouring, keeping what is ticked', async () => {
    const column: ParameterColumn = {
      type: 'numeric',
      key: 'k',
      count: 3,
      values: Float64Array.from([1, 2, 3]),
      units: [{ key: '', symbol: '' }],
      unitIndex: null,
      modelId: 'a',
      ids: Int32Array.from([1, 2, 3]),
    };
    const { modelManager, controller } = setup({ a: column });
    await controller.colourBy('k', { kind: 'model', modelId: 'a' });
    controller.setTicked(1, false);
    const before = modelManager.getElementState('a', 1)!.color;
    controller.setPalette('colour-blind-safe');
    const s = controller.getState();
    if (s.phase !== 'shown') throw new Error('not shown');
    expect(s.palette.id).toBe('colour-blind-safe');
    expect(s.ticked).toEqual([true, false, true]);
    expect(modelManager.getElementState('a', 1)!.color).not.toEqual(before);
    expect(modelManager.getElementState('a', 2)!.dataColored).toBe(false);
  });
});

describe('what a colouring covers', () => {
  const a1 = { modelId: 'a', expressId: 1 };
  const a2 = { modelId: 'a', expressId: 2 };
  const b1 = { modelId: 'b', expressId: 1 };
  const b2 = { modelId: 'b', expressId: 2 };

  it('one element or none selected: the whole model', () => {
    expect(colourScopeFor([], 'a', false)).toEqual({ kind: 'model', modelId: 'a' });
    expect(colourScopeFor([a1], 'a', false)).toEqual({ kind: 'model', modelId: 'a' });
  });

  it('from the right-click menu, a selection across models is coloured as one', () => {
    const s = colourScopeFor([a1, b1, b2], 'a', false);
    expect(s).toEqual({ kind: 'selection', elements: new Map([['a', [1]], ['b', [1, 2]]]) });
  });

  it("from a model's Parameters list, only that model's selected elements", () => {
    expect(colourScopeFor([a1, a2, b1], 'a', true)).toEqual({ kind: 'selection', elements: new Map([['a', [1, 2]]]) });
  });

  it("from a model's Parameters list, a selection in another model colours the whole list's model", () => {
    // Before: model B's elements were coloured by model A's parameter, and
    // model A stayed as it was.
    expect(colourScopeFor([b1, b2], 'a', true)).toEqual({ kind: 'model', modelId: 'a' });
    expect(colourScopeFor([a1, b1, b2], 'a', true)).toEqual({ kind: 'model', modelId: 'a' });
  });

  it('the swatch of the parameter shown clears it: same parameter, and the colouring covers that model', async () => {
    const { controller } = setup({ a: textColumn('a', [1, 2, 3], ['x', 'y', 'x']) });
    expect(isColouringBy(controller.getState(), 'k', 'a')).toBe(false);
    await controller.colourBy('k', colourScopeFor([b1, b2], 'a', true));
    expect(isColouringBy(controller.getState(), 'k', 'a')).toBe(true);
    expect(isColouringBy(controller.getState(), 'other', 'a')).toBe(false);
    expect(isColouringBy(controller.getState(), 'k', 'b')).toBe(false);
  });
});
describe('colouring what is visible', () => {
  function numberColumn(modelId: string, ids: number[], values: number[]): ParameterColumn {
    return {
      type: 'numeric',
      key: 'k',
      count: values.length,
      values: Float64Array.from(values),
      units: [{ key: 'LENGTHUNIT:MILLI:METRE', symbol: 'mm' }],
      unitIndex: null,
      modelId,
      ids: Int32Array.from(ids),
    };
  }

  function visibleSetup(columns: Record<string, ParameterColumn>, modelManager: ModelManager) {
    const controller = new ColourByController({
      loadColumn: async (modelId) => columns[modelId],
      paint: modelManager,
      visibility: (modelId) => modelManager.visibleElements(modelId),
    });
    return controller;
  }

  it('hidden elements are not counted, do not set the scale and keep their own colour when shown', async () => {
    const { modelManager } = makeModelManager([boxModel('a', [1, 2, 3, 4], { color: RED })]);
    const ids = [1, 2, 3, 4];
    const values = [1, 2, 3, 1000];
    const controller = visibleSetup({ a: numberColumn('a', ids, values) }, modelManager);
    modelManager.setHidden('a', [4], true);
    await controller.colourBy('k', { kind: 'model', modelId: 'a' });
    const s = controller.getState();
    if (s.phase !== 'shown') throw new Error('not shown');
    // 1000 is hidden: it is not one of the values.
    expect(s.plan.entries.map((e) => e.label)).toEqual(['1 mm', '2 mm', '3 mm']);
    expect([s.plan.scopeSize, s.total]).toEqual([3, 4]);
    // Shown again: its own colour, not "no value", until a refresh.
    modelManager.setHidden('a', [4], false);
    expect(modelManager.getElementState('a', 4)).toMatchObject({ dataColored: false, color: { r: 1, g: 0, b: 0 } });
  });

  it('Refresh works the colouring out again over what is visible now, keeping ticks of values still there', async () => {
    const { modelManager } = makeModelManager([boxModel('a', [1, 2, 3], { color: RED })]);
    const controller = visibleSetup({ a: textColumn('a', [1, 2, 3], ['x', 'y', 'z']) }, modelManager);
    modelManager.setHidden('a', [3], true);
    await controller.colourBy('k', { kind: 'model', modelId: 'a' });
    controller.setTicked(1, false); // 'y'
    modelManager.setHidden('a', [3], false);
    modelManager.setHidden('a', [1], true);
    controller.markStale();
    const before = controller.getState();
    expect(before.phase === 'shown' && before.stale).toBe(true);

    controller.refresh();
    const s = controller.getState();
    if (s.phase !== 'shown') throw new Error('not shown');
    expect(s.stale).toBe(false);
    expect(s.plan.entries.map((e) => e.label).sort()).toEqual(['y', 'z']);
    expect(s.ticked[s.plan.entries.findIndex((e) => e.label === 'y')]).toBe(false);
    expect(s.ticked[s.plan.entries.findIndex((e) => e.label === 'z')]).toBe(true);
    // Hidden now: its colour was taken off.
    expect(modelManager.getElementState('a', 1)!.dataColored).toBe(false);
    expect(modelManager.getElementState('a', 3)!.dataColored).toBe(true);
  });

  it('Refresh of a selection keeps to the selected elements, those of them visible now', async () => {
    const { modelManager } = makeModelManager([boxModel('a', [1, 2, 3, 4])]);
    const controller = visibleSetup({ a: textColumn('a', [1, 2, 3, 4], ['x', 'x', 'x', 'x']) }, modelManager);
    modelManager.setHidden('a', [2], true);
    await controller.colourBy('k', { kind: 'selection', elements: new Map([['a', [1, 2, 3]]]) });
    let s = controller.getState();
    expect(s.phase === 'shown' && [s.plan.scopeSize, s.total]).toEqual([2, 3]);
    modelManager.setHidden('a', [2], false);
    controller.refresh();
    s = controller.getState();
    expect(s.phase === 'shown' && [s.plan.scopeSize, s.total]).toEqual([3, 3]);
    // Element 4 was never selected.
    expect(modelManager.getElementState('a', 4)!.dataColored).toBe(false);
  });

  it('nothing is recoloured until Refresh: marking stale only says so', async () => {
    const { modelManager } = makeModelManager([boxModel('a', [1, 2])]);
    const controller = visibleSetup({ a: textColumn('a', [1, 2], ['x', 'y']) }, modelManager);
    await controller.colourBy('k', { kind: 'model', modelId: 'a' });
    const plan = controller.getState().phase === 'shown' ? (controller.getState() as { plan: unknown }).plan : null;
    modelManager.setHidden('a', [1], true);
    controller.markStale();
    expect((controller.getState() as { plan: unknown }).plan).toBe(plan);
    controller.clear();
    controller.markStale();
    expect(controller.getState().phase).toBe('off');
  });

  it('a model switched off is not visible; elements wholly behind the section plane are not either', async () => {
    const { modelManager } = makeModelManager([boxModel('a', [1, 2, 3])]); // boxes at x = 0, 2, 4
    // Keep x > 3: everything at x < 3 is cut away.
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -3);
    const visible = modelManager.visibleElements('a', plane)!;
    expect([1, 2, 3].map(visible)).toEqual([false, false, true]);
    // A plane through an element leaves it visible.
    const through = modelManager.visibleElements('a', new THREE.Plane(new THREE.Vector3(1, 0, 0), -2))!;
    expect(through(2)).toBe(true);
    modelManager.setVisible('a', false);
    expect(modelManager.visibleElements('a')!(3)).toBe(false);
  });
});

describe('how many values get their own colour', () => {
  it('every value its own colour: 100 values, 100 colours, no "other"', async () => {
    const values = Array.from({ length: 100 }, (_, i) => `Type ${i}`);
    const ids = values.map((_, i) => i + 1);
    const column = textColumn('a', ids, values);
    const { modelManager } = makeModelManager([boxModel('a', ids)]);
    const controller = new ColourByController({ loadColumn: async () => column, paint: modelManager }, { maxValues: 12 });
    await controller.colourBy('k', { kind: 'model', modelId: 'a' });
    let s = controller.getState();
    expect(s.phase === 'shown' && s.plan.entries.length).toBe(13);
    controller.setTicked(0, false);
    controller.setMaxValues(Infinity);
    s = controller.getState();
    if (s.phase !== 'shown') throw new Error('not shown');
    expect(s.plan.entries).toHaveLength(100);
    expect(s.plan.entries.some((e) => e.kind === 'other')).toBe(false);
    const colours = new Set(s.plan.entries.map((e) => `${e.color.r.toFixed(3)},${e.color.g.toFixed(3)},${e.color.b.toFixed(3)}`));
    expect(colours.size).toBe(100);
    // The tick of a value that is still there is kept.
    expect(s.ticked[0]).toBe(false);
    expect(controller.getMaxValues()).toBe(Infinity);
  });
});