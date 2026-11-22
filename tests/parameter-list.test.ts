// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  ParameterList,
  countText,
  spreadText,
  unitNoteText,
  unitText,
  visibleParameters,
} from '../src/ui/ParameterList';
import { ParametersPanel, type ParametersPanelDeps } from '../src/ui/ParametersPanel';
import { ModelTreePanel } from '../src/ui/ModelTreePanel';
import { LoadGate } from '../src/core/LoadGate';
import type { ModelParameters, ParameterSummary } from '../src/inspector/types';

function param(key: string, extra: Partial<ParameterSummary> = {}): ParameterSummary {
  return { key, count: 1, kind: 'text', distinct: 1, values: [{ value: 'x', count: 1 }], uniquePerElement: false, ...extra };
}

const DATA: ModelParameters = {
  modelId: 'm',
  scopeSize: 1235,
  parameters: [
    param('Identity.GlobalId', { count: 1235, distinct: null, values: undefined, uniquePerElement: true }),
    param('Pset_BeamCommon.LoadBearing', { count: 412, kind: 'boolean', distinct: 2 }),
    param('Qto_BeamBaseQuantities.Length', {
      count: 600,
      kind: 'numeric',
      unit: 'mm',
      numeric: { min: 250, max: 12500.5, sum: 1e6 },
      distinct: null,
      values: undefined,
    }),
  ],
};

describe('parameter row text', () => {
  it('counts out of the scope, with thousands separators', () => {
    expect(countText(DATA.parameters[1], DATA.scopeSize)).toBe('412 of 1,235');
  });

  it('shows a numeric range, a shared value, a distinct count or uniqueness', () => {
    expect(spreadText(DATA.parameters[2])).toBe('250 – 12500.5');
    expect(spreadText(param('A', { kind: 'numeric', numeric: { min: 3, max: 3, sum: 6 } }))).toBe('all 3');
    expect(
      spreadText(
        param('A', {
          kind: 'numeric',
          numeric: { min: 3, max: 3, sum: 9 },
          unitsDiffer: true,
          units: [
            { key: 'si:mm', symbol: 'mm', count: 2 },
            { key: 'si:m', symbol: 'm', count: 1 },
          ],
        }),
      ),
    ).toBe('3 in 2 units');
    expect(spreadText(param('A', { values: [{ value: 'Steel', count: 4 }] }))).toBe('all "Steel"');
    expect(spreadText(param('A', { kind: 'boolean', values: [{ value: false, count: 4 }] }))).toBe('all false');
    expect(spreadText(DATA.parameters[1])).toBe('2 values');
    expect(spreadText(param('A', { distinct: null, values: undefined }))).toBe('more than 200 values');
    expect(spreadText(DATA.parameters[0])).toBe('unique per element');
  });

  it('says mixed units rather than show one that is not true of all', () => {
    expect(unitText(param('A', { unit: 'mm', unitsDiffer: true }))).toBe('mixed units');
    expect(unitText(DATA.parameters[2])).toBe('mm');
  });

  it('says when the model does not state the unit, and shows nothing for plain numbers or text', () => {
    expect(unitText(param('A', { kind: 'numeric', units: [{ key: '?TIMEUNIT', symbol: '', count: 3 }] }))).toBe('unit not stated');
    expect(unitText(param('A', { kind: 'numeric', units: [{ key: '', symbol: '', count: 3 }] }))).toBe('');
    expect(unitText(param('A'))).toBe('');
  });

  it('explains a mixed-unit or unstated-unit parameter when opened, and nothing otherwise', () => {
    const mixed = param('A', {
      kind: 'numeric',
      unitsDiffer: true,
      units: [
        { key: 'si:mm', symbol: 'mm', count: 40 },
        { key: 'si:m', symbol: 'm', count: 2 },
      ],
    });
    expect(unitNoteText(mixed)).toBe('Values are in different units (mm on 40, m on 2), so they are not added up');
    expect(unitNoteText(param('A', { kind: 'numeric', units: [{ key: '?LENGTHUNIT', symbol: '', count: 3 }] }))).toBe(
      'The model does not state the unit of these values',
    );
    expect(unitNoteText(param('A', { kind: 'numeric', unit: 'mm', units: [{ key: 'si:mm', symbol: 'mm', count: 3 }] }))).toBe('');
    expect(unitNoteText(param('A'))).toBe('');
  });

  it('filters case-insensitively and sorts by name or by count', () => {
    expect(visibleParameters(DATA.parameters, 'beam', 'name').map((p) => p.key)).toEqual([
      'Pset_BeamCommon.LoadBearing',
      'Qto_BeamBaseQuantities.Length',
    ]);
    expect(visibleParameters(DATA.parameters, '', 'count').map((p) => p.count)).toEqual([1235, 600, 412]);
  });
});

describe('ParameterList', () => {
  it('renders one row per parameter with its count, kind, unit and spread', () => {
    const parent = document.createElement('div');
    const list = new ParameterList(parent);
    list.setData(DATA);
    const rows = parent.querySelectorAll('.param-row');
    expect(rows).toHaveLength(3);
    const length = parent.querySelector('[data-key="Qto_BeamBaseQuantities.Length"]')!;
    expect(length.querySelector('.param-name')!.textContent).toBe('Length');
    const meta = [...length.querySelectorAll('.param-meta > span')].map((s) => s.textContent);
    expect(meta).toEqual(['600 of 1,235', 'number', 'mm', '250 – 12500.5']);
    expect(parent.querySelector('.param-list-summary')!.textContent).toBe('3 parameters');
  });

  it('filters as you type and keeps the filter across new data', () => {
    const parent = document.createElement('div');
    const list = new ParameterList(parent);
    list.setData(DATA);
    const input = parent.querySelector<HTMLInputElement>('.param-list-filter')!;
    input.value = 'global';
    input.dispatchEvent(new Event('input'));
    expect(parent.querySelectorAll('.param-row')).toHaveLength(1);
    expect(parent.querySelector('.param-list-summary')!.textContent).toBe('1 of 3 parameters');
    list.setData({ ...DATA });
    expect(parent.querySelectorAll('.param-row')).toHaveLength(1);
  });

  it('sorts by count when asked, and marks the active sort', () => {
    const parent = document.createElement('div');
    const list = new ParameterList(parent);
    list.setData(DATA);
    parent.querySelector<HTMLButtonElement>('[data-sort="count"]')!.click();
    const keys = [...parent.querySelectorAll<HTMLElement>('.param-row')].map((r) => r.dataset.key);
    expect(keys[0]).toBe('Identity.GlobalId');
    expect(keys[2]).toBe('Pset_BeamCommon.LoadBearing');
    expect(parent.querySelector('[data-sort="count"]')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('opening a parameter', () => {
  const scope: ModelParameters = {
    modelId: 'm',
    scopeSize: 20,
    parameters: [
      param('P.Profile', {
        count: 14,
        distinct: 2,
        values: [
          { value: 'HEA140', count: 10 },
          { value: 'HEA160', count: 4 },
        ],
      }),
      param('P.LoadBearing', { count: 20, kind: 'boolean', distinct: 2, values: [{ value: true, count: 12 }, { value: false, count: 8 }] }),
      param('P.Length', {
        count: 20,
        kind: 'numeric',
        unit: 'mm',
        numeric: { min: 100, max: 300, sum: 4000 },
        distinct: 2,
        values: [
          { value: 200, count: 15 },
          { value: 100, count: 5 },
        ],
      }),
      param('P.Many', { count: 20, distinct: null, values: undefined }),
      param('Identity.GlobalId', { count: 20, distinct: null, values: undefined, uniquePerElement: true }),
      param('P.Twelve', {
        count: 12,
        distinct: 12,
        values: Array.from({ length: 12 }, (_, i) => ({ value: `t${i}`, count: 1 })),
      }),
    ],
  };

  function listWith(options: ConstructorParameters<typeof ParameterList>[1] = {}) {
    const parent = document.createElement('div');
    const list = new ParameterList(parent, options);
    list.setData(scope);
    const head = (key: string) => parent.querySelector<HTMLButtonElement>(`[data-key="${key}"] .param-head`)!;
    const values = (key: string) =>
      [...parent.querySelectorAll(`[data-key="${key}"] .param-value`)].map(
        (b) => `${b.querySelector('.param-value-text')!.textContent} · ${b.querySelector('.param-value-count')!.textContent}`,
      );
    const text = (key: string, cls: string) => parent.querySelector(`[data-key="${key}"] .${cls}`)?.textContent ?? null;
    return { parent, list, head, values, text };
  }

  it('is a button that expands in place and lists values with counts, most common first', () => {
    const { head, values, text } = listWith();
    expect(head('P.Profile').getAttribute('aria-expanded')).toBe('false');
    head('P.Profile').click();
    expect(head('P.Profile').getAttribute('aria-expanded')).toBe('true');
    expect(values('P.Profile')).toEqual(['HEA140 · 10', 'HEA160 · 4']);
    expect(text('P.Profile', 'param-values-without')).toBe('6 without this parameter');
    // No filter for two values.
    expect(text('P.Profile', 'param-value-filter')).toBeNull();
  });

  it('shows one open row at a time, and closes on a second click', () => {
    const { head, list } = listWith();
    head('P.Profile').click();
    head('P.LoadBearing').click();
    expect(list.openRow()).toBe('P.LoadBearing');
    expect(head('P.Profile').getAttribute('aria-expanded')).toBe('false');
    head('P.LoadBearing').click();
    expect(list.openRow()).toBeNull();
  });

  it('lists true and false for yes/no, and no "without" line when every element has it', () => {
    const { head, values, text } = listWith();
    head('P.LoadBearing').click();
    expect(values('P.LoadBearing')).toEqual(['true · 12', 'false · 8']);
    expect(text('P.LoadBearing', 'param-values-without')).toBeNull();
  });

  it('says why a mixed-unit parameter is not added up, and lists each value in its own unit', async () => {
    const parent = document.createElement('div');
    const mm = { key: 'si:mm', symbol: 'mm' };
    const m = { key: 'si:m', symbol: 'm' };
    // From the column: the same number in two units is two entries.
    const loadValues = vi.fn(async () => [
      { value: 3, count: 2, unit: mm },
      { value: 3, count: 1, unit: m },
      { value: 250, count: 1, unit: mm },
      { value: 7, count: 1, unit: { key: '?LENGTHUNIT', symbol: '' } },
    ]);
    const onPickValue = vi.fn();
    const list = new ParameterList(parent, { loadValues, onPickValue });
    list.setData({
      modelId: 'm',
      scopeSize: 3,
      parameters: [
        param('P.Width', {
          count: 3,
          kind: 'numeric',
          unitsDiffer: true,
          units: [
            { key: 'si:mm', symbol: 'mm', count: 2 },
            { key: 'si:m', symbol: 'm', count: 1 },
          ],
          numeric: { min: 0.3, max: 250, sum: 450.3 },
          distinct: 3,
          values: [
            { value: 0.3, count: 1 },
            { value: 200, count: 1 },
            { value: 250, count: 1 },
          ],
        }),
      ],
    });
    const meta = [...parent.querySelectorAll('[data-key="P.Width"] .param-meta > span')].map((x) => x.textContent);
    expect(meta).toContain('mixed units');
    parent.querySelector<HTMLButtonElement>('[data-key="P.Width"] .param-head')!.click();
    expect(parent.querySelector('[data-key="P.Width"] .param-range')!.textContent).toBe('min 0.3 · max 250');
    expect(parent.querySelector('[data-key="P.Width"] .param-units-note')!.textContent).toBe(
      'Values are in different units (mm on 2, m on 1), so they are not added up',
    );
    // The description merges 3 mm and 3 m, so the values come from the column.
    expect(loadValues).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    const texts = [...parent.querySelectorAll('[data-key="P.Width"] .param-value-text')].map((x) => x.textContent);
    expect(texts).toEqual(['3 mm', '3 m', '250 mm', '7 (unit not stated)']);
    // Picking "3 m" picks 3 in metres only.
    parent.querySelectorAll<HTMLButtonElement>('[data-key="P.Width"] .param-value')[1].click();
    expect(onPickValue.mock.calls[0][1]).toBe(3);
    expect(onPickValue.mock.calls[0][3]).toEqual(m);
  });

  it('tells whoever listens when the open row closes: second click, another row, or other data', () => {
    const onClose = vi.fn();
    const { head, list } = listWith({ onClose });
    const closed = (): string[] => onClose.mock.calls.map((c) => `${c[1]}:${c[0].key}`);
    head('P.Profile').click();
    head('P.Profile').click();
    expect(closed()).toEqual(['m:P.Profile']);
    head('P.Profile').click();
    head('P.LoadBearing').click();
    expect(closed()).toEqual(['m:P.Profile', 'm:P.Profile']);
    list.setData({ ...scope, modelId: 'other' });
    expect(closed()).toEqual(['m:P.Profile', 'm:P.Profile', 'm:P.LoadBearing']);
  });

  it('tells whoever listens when a row is opened, so picking can get ready', () => {
    const onOpen = vi.fn();
    const { head } = listWith({ onOpen });
    head('P.Profile').click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].key).toBe('P.Profile');
    // Closing is not opening.
    head('P.Profile').click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows min and max for numbers, then the values with their unit', () => {
    const { head, values, text } = listWith();
    head('P.Length').click();
    expect(text('P.Length', 'param-range')).toBe('min 100 mm · max 300 mm');
    expect(values('P.Length')).toEqual(['200 mm · 15', '100 mm · 5']);
  });

  it('offers a value filter when there are many values', () => {
    const { parent, head, values } = listWith();
    head('P.Twelve').click();
    const filter = parent.querySelector<HTMLInputElement>('[data-key="P.Twelve"] .param-value-filter')!;
    filter.value = 't1';
    filter.dispatchEvent(new Event('input'));
    expect(values('P.Twelve')).toEqual(['t1 · 1', 't10 · 1', 't11 · 1']);
  });

  it('fetches the values of a parameter past the cap when opened, shows the 500 most common, and filters all of them', async () => {
    const all = Array.from({ length: 7347 }, (_, i) => ({ value: `v${i}`, count: 7347 - i }));
    let progress!: (d: number, t: number) => void;
    let resolve!: (v: typeof all) => void;
    const loadValues = vi.fn((_key: string, onProgress: (d: number, t: number) => void) => {
      progress = onProgress;
      return new Promise<typeof all>((r) => (resolve = r));
    });
    const { parent, head, values, text } = listWith({ loadValues });
    head('P.Many').click();
    expect(loadValues).toHaveBeenCalledWith('P.Many', expect.any(Function));
    expect(text('P.Many', 'param-values-status')).toBe('Reading values…');
    progress(5, 20);
    expect(text('P.Many', 'param-values-status')).toBe('Reading values… 5 of 20 elements');
    resolve(all);
    await flush();
    expect(values('P.Many')).toHaveLength(500);
    expect(values('P.Many')[0]).toBe('v0 · 7,347');
    expect(text('P.Many', 'param-values-status')).toBe('Showing the 500 most common of 7,347; type to filter');
    const filter = parent.querySelector<HTMLInputElement>('[data-key="P.Many"] .param-value-filter')!;
    filter.value = 'v7346';
    filter.dispatchEvent(new Event('input'));
    expect(values('P.Many')).toEqual(['v7346 · 1']);
    // Fetched once: closing and opening again does not ask again.
    head('P.Many').click();
    head('P.Many').click();
    expect(loadValues).toHaveBeenCalledTimes(1);
  });

  it('a unique-per-element parameter shows the note and the filter only; typing finds a value', async () => {
    const loadValues = vi.fn(async () => [{ value: 'abc', count: 1 }, { value: 'xyz', count: 1 }]);
    const { parent, head, values, text } = listWith({ loadValues });
    head('Identity.GlobalId').click();
    await flush();
    expect(text('Identity.GlobalId', 'param-values-note')).toMatch(/Unique per element/);
    expect(values('Identity.GlobalId')).toEqual([]);
    const filter = parent.querySelector<HTMLInputElement>('[data-key="Identity.GlobalId"] .param-value-filter')!;
    filter.value = 'XY';
    filter.dispatchEvent(new Event('input'));
    expect(values('Identity.GlobalId')).toEqual(['xyz · 1']);
  });

  it('picking a value hands it on, adding to the selection with Ctrl or Shift', () => {
    const onPickValue = vi.fn();
    const { parent, head } = listWith({ onPickValue });
    head('P.Profile').click();
    const [first, second] = parent.querySelectorAll<HTMLButtonElement>('[data-key="P.Profile"] .param-value');
    first.click();
    second.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(onPickValue.mock.calls.map((c) => [c[0].key, c[1], c[2]])).toEqual([
      ['P.Profile', 'HEA140', false],
      ['P.Profile', 'HEA160', true],
    ]);
  });

  it('each value has an eye that shows only its elements, as well with Ctrl or Shift, and never selects', () => {
    const onPickValue = vi.fn();
    const onShowOnly = vi.fn();
    const { parent, head } = listWith({ onPickValue, onShowOnly });
    head('P.Profile').click();
    const eyes = parent.querySelectorAll<HTMLButtonElement>('[data-key="P.Profile"] .show-only-btn');
    expect(eyes).toHaveLength(parent.querySelectorAll('[data-key="P.Profile"] .param-value').length);
    expect(eyes[0].getAttribute('aria-label')).toBe('Show only HEA140');
    expect(eyes[0].title).toMatch(/^Show only the elements with HEA140, hide the rest/);
    eyes[0].click();
    eyes[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(onShowOnly.mock.calls.map((c) => [c[0].key, c[1], c[2]])).toEqual([
      ['P.Profile', 'HEA140', false],
      ['P.Profile', 'HEA160', true],
    ]);
    expect(onPickValue).not.toHaveBeenCalled();
  });

  it('has no eye without a show-only handler', () => {
    const { parent, head } = listWith({ onPickValue: vi.fn() });
    head('P.Profile').click();
    expect(parent.querySelector('.show-only-btn')).toBeNull();
  });

  it('gives every name and value its full text as a tooltip', () => {
    const long = 'A_very_long_type_name_without_spaces'.repeat(4);
    const parent = document.createElement('div');
    const list = new ParameterList(parent);
    list.setData({ modelId: 'm', scopeSize: 2, parameters: [param(`Pset_${long}.${long}`, { values: [{ value: long, count: 2 }], count: 2 })] });
    expect(parent.querySelector('.param-key')!.getAttribute('title')).toBe(`Pset_${long}.${long}`);
    expect(parent.querySelector('.param-spread')!.getAttribute('title')).toBe(`all "${long}"`);
    parent.querySelector<HTMLButtonElement>('.param-head')!.click();
    expect(parent.querySelector('.param-value')!.getAttribute('title')).toBe(long);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function panelWith(models: { id: string; name: string }[]) {
  const calls: { modelId: string; progress: (d: number, t: number) => void; d: ReturnType<typeof deferred<ModelParameters>> }[] = [];
  const deps: ParametersPanelDeps = {
    getModels: () => models,
    describe: (modelId, progress) => {
      const d = deferred<ModelParameters>();
      calls.push({ modelId, progress, d });
      return d.promise;
    },
  };
  const parent = document.createElement('div');
  const panel = new ParametersPanel(parent, deps);
  return { parent, panel, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ParametersPanel', () => {
  it('shows progress while discovery runs, then the list', async () => {
    const { parent, panel, calls } = panelWith([{ id: 'm', name: 'A.ifc' }]);
    panel.open('m');
    expect(panel.isOpen()).toBe(true);
    calls[0].progress(400, 1235);
    expect(parent.querySelector('.params-panel-status')!.textContent).toBe('Reading parameters… 400 of 1,235 elements');
    expect(parent.querySelector('.params-panel-progress')!.classList.contains('hidden')).toBe(false);
    calls[0].d.resolve(DATA);
    await flush();
    expect(parent.querySelector('.params-panel-status')!.textContent).toBe(
      '3 parameters across 1,235 elements with geometry',
    );
    expect(parent.querySelectorAll('.param-row')).toHaveLength(3);
    expect(parent.querySelector('.params-panel-progress')!.classList.contains('hidden')).toBe(true);
  });

  it('says it is waiting while a model loads, then reading once it starts', () => {
    const parent = document.createElement('div');
    let started!: () => void;
    const panel = new ParametersPanel(parent, {
      getModels: () => [{ id: 'm', name: 'A.ifc' }],
      isLoading: () => true,
      describe: (_m, _p, onStarted) => {
        started = onStarted!;
        return new Promise(() => {});
      },
    });
    panel.open('m');
    const status = () => parent.querySelector('.params-panel-status')!.textContent;
    expect(status()).toBe('Waiting for the load to finish…');
    started();
    expect(status()).toBe('Reading parameters…');
  });

  it('opening a parameter asks for it to be got ready, for the model shown', async () => {
    const prepare = vi.fn();
    const parent = document.createElement('div');
    const panel = new ParametersPanel(parent, {
      getModels: () => [{ id: 'm', name: 'A.ifc' }],
      describe: async () => DATA,
      prepare,
    });
    panel.open('m');
    await flush();
    parent.querySelector<HTMLButtonElement>('[data-key="Pset_BeamCommon.LoadBearing"] .param-head')!.click();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toBe('m');
    expect(prepare.mock.calls[0][1].key).toBe('Pset_BeamCommon.LoadBearing');
  });

  it('closing a parameter, or the panel, releases what opening it got ready', async () => {
    const release = vi.fn();
    const parent = document.createElement('div');
    const panel = new ParametersPanel(parent, {
      getModels: () => [{ id: 'm', name: 'A.ifc' }],
      describe: async () => DATA,
      prepare: () => {},
      release,
    });
    panel.open('m');
    await flush();
    const head = (k: string) => parent.querySelector<HTMLButtonElement>(`[data-key="${k}"] .param-head`)!;
    head('Pset_BeamCommon.LoadBearing').click();
    head('Identity.GlobalId').click();
    expect(release.mock.calls.map((c) => `${c[0]}:${c[1].key}`)).toEqual(['m:Pset_BeamCommon.LoadBearing']);
    panel.close();
    expect(release.mock.calls.map((c) => `${c[0]}:${c[1].key}`)).toEqual([
      'm:Pset_BeamCommon.LoadBearing',
      'm:Identity.GlobalId',
    ]);
  });

  it('keeps clear of the contextual tray by its height', () => {
    const { panel } = panelWith([{ id: 'm', name: 'A.ifc' }]);
    const tray = document.createElement('div');
    Object.defineProperty(tray, 'offsetHeight', { value: 132 });
    panel.keepClearOf(tray);
    expect(panel.getContainer().style.getPropertyValue('--params-clearance')).toBe('132px');
  });

  it('says so when discovery fails', async () => {
    const { parent, panel, calls } = panelWith([{ id: 'm', name: 'A.ifc' }]);
    panel.open('m');
    calls[0].d.reject(new Error('The model was closed'));
    await flush();
    expect(parent.querySelector('.params-panel-status')!.textContent).toMatch(/Could not read parameters: The model was closed/);
  });

  it('shows one model at a time; a late reply for the previous model is ignored', async () => {
    const { parent, panel, calls } = panelWith([
      { id: 'a', name: 'A.ifc' },
      { id: 'b', name: 'B.ifc' },
    ]);
    panel.open('a');
    const select = parent.querySelector<HTMLSelectElement>('.params-panel-select')!;
    expect(select.classList.contains('hidden')).toBe(false);
    select.value = 'b';
    select.dispatchEvent(new Event('change'));
    expect(panel.currentModel()).toBe('b');
    calls[0].d.resolve(DATA);
    await flush();
    expect(parent.querySelectorAll('.param-row')).toHaveLength(0);
    calls[1].d.resolve({ ...DATA, modelId: 'b', parameters: DATA.parameters.slice(0, 1) });
    await flush();
    expect(parent.querySelectorAll('.param-row')).toHaveLength(1);
  });

  it('hides the model picker with one model and names the model instead', () => {
    const { parent, panel } = panelWith([{ id: 'm', name: 'A.ifc' }]);
    panel.open('m');
    expect(parent.querySelector('.params-panel-select')!.classList.contains('hidden')).toBe(true);
    expect(parent.querySelector('.params-panel-model')!.textContent).toBe('A.ifc');
  });

  it('moves to another model when the shown one is removed, and closes when none is left', () => {
    const models = [
      { id: 'a', name: 'A.ifc' },
      { id: 'b', name: 'B.ifc' },
    ];
    const { panel } = panelWith(models);
    panel.open('a');
    models.splice(0, 1);
    panel.onModelRemoved('a');
    expect(panel.currentModel()).toBe('b');
    models.splice(0, 1);
    panel.onModelRemoved('b');
    expect(panel.isOpen()).toBe(false);
  });
});

describe('Models panel entry point', () => {
  it('offers Parameters on each loaded model, and not on one whose file is missing', () => {
    const onShowParameters = vi.fn();
    const parent = document.createElement('div');
    const tree = new ModelTreePanel(parent, {
      onVisibilityToggle: vi.fn(),
      onRemoveModel: vi.fn(),
      onAddModel: vi.fn(),
      onShowParameters,
    });
    tree.addModel('m1', 'A.ifc', 10);
    tree.addModel('m2', 'B.ifc', 0);
    tree.setModelWarning('m2', 'File missing');
    const buttons = parent.querySelectorAll<HTMLButtonElement>('.model-row-params');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].title).toBe('Parameters in this model');
    expect(buttons[0].getAttribute('aria-label')).toBe('Parameters in this model');
    buttons[0].click();
    expect(onShowParameters).toHaveBeenCalledWith('m1');
    expect(buttons[1].disabled).toBe(true);
  });

  it('shows no Parameters button when the app does not offer it', () => {
    const parent = document.createElement('div');
    const tree = new ModelTreePanel(parent, { onVisibilityToggle: vi.fn(), onRemoveModel: vi.fn(), onAddModel: vi.fn() });
    tree.addModel('m1', 'A.ifc', 10);
    expect(parent.querySelector('.model-row-params')).toBeNull();
  });
});

describe('LoadGate', () => {
  it('is idle at once with no load, and waits for every running load to end', async () => {
    const gate = new LoadGate();
    await gate.idle();
    const endA = gate.begin();
    const endB = gate.begin();
    let idle = false;
    void gate.idle().then(() => (idle = true));
    endA();
    endA(); // ending twice counts once
    await flush();
    expect(idle).toBe(false);
    expect(gate.busy).toBe(true);
    endB();
    await flush();
    expect(idle).toBe(true);
  });
});
