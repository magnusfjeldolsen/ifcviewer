import { describe, it, expect, vi } from 'vitest';
import { ColourByController, type ColourByDeps } from '../src/inspector/ColourByController';
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
