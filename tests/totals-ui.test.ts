// @vitest-environment jsdom
/**
 * Totals (#69) in the DOM: the Totals tab draws the controller's state
 * (numbers first, one line per unit, grouped tables that sort and select,
 * share charts, Copy), and the Parameters panel hosts it as a tab with a Σ
 * on every parameter row. The right-click menu opens it.
 */

import { describe, it, expect, vi } from 'vitest';
import { TotalsController, type TotalsDeps, type TotalsScope } from '../src/inspector/TotalsController';
import { TotalsView, choiceText, formatStat, groupChoices, scopeHeading, TOTALS_FILTER_FROM } from '../src/ui/TotalsView';
import { ParametersPanel } from '../src/ui/ParametersPanel';
import { buildContextMenuItems, type ContextMenuActions } from '../src/ui/contextMenuItems';
import { LoadGate } from '../src/core/LoadGate';
import type { ColumnData, ParameterColumn } from '../src/inspector/parameterColumn';
import type { ModelParameters, ParameterSummary } from '../src/inspector/types';
import type { UnitRef } from '../src/inspector/units';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

const last = <T,>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

const M3: UnitRef = { key: 'si:m³', symbol: 'm³' };
const FT3: UnitRef = { key: 'conv:cubic foot*0.0283168 si:m³', symbol: 'ft³' };

function numeric(key: string, values: number[], units: UnitRef[] = [M3], unitOf?: number[]): ColumnData {
  return { type: 'numeric', key, count: values.length, values: Float64Array.from(values), units, unitIndex: unitOf ? Uint16Array.from(unitOf) : null };
}

function discrete(key: string, values: string[]): ColumnData {
  const dictionary = [...new Set(values)];
  return { type: 'discrete', key, count: values.length, codes: Int32Array.from(values.map((v) => dictionary.indexOf(v))), dictionary };
}

function summary(key: string): ParameterSummary {
  return { key, count: 1, kind: 'numeric', distinct: 1, uniquePerElement: false };
}

function setup(columns: Record<string, ColumnData>, ids: number[], scope: TotalsScope = { kind: 'visible' }) {
  const store: Record<string, string> = {};
  const deps: TotalsDeps = {
    models: () => ['a'],
    scope: () => scope,
    describe: async (): Promise<ModelParameters> => ({ modelId: 'a', scopeSize: ids.length, parameters: Object.entries(columns).map(([k, c]) => ({ ...summary(k), kind: c.type === 'numeric' ? 'numeric' : 'text' })) }),
    scopeIds: () => Int32Array.from(ids),
    loadColumn: async (m, key): Promise<ParameterColumn> => ({ ...columns[key], modelId: m, ids: Int32Array.from(ids) }),
    releaseColumn: () => {},
    select: vi.fn(),
    storage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => void (store[k] = v) },
    debounceMs: 0,
  };
  const controller = new TotalsController(deps);
  const picker = { open: vi.fn() };
  const copy = vi.fn<(text: string) => Promise<boolean>>(async () => true);
  const view = new TotalsView({ controller, picker, modelName: () => 'A.ifc', copy });
  document.body.replaceChildren(view.getElement());
  return { controller, view, picker, copy, deps, root: view.getElement() };
}

describe('TotalsView', () => {
  it('says what it counts', () => {
    expect(scopeHeading({ kind: 'selection', elements: 37, models: 1 })).toBe('37 selected elements');
    expect(scopeHeading({ kind: 'selection', elements: 1, models: 2 })).toBe('1 selected element · 2 models');
    expect(scopeHeading({ kind: 'visible', elements: 1235, models: 1 })).toBe('All visible: 1,235 elements');
  });

  it('formats numbers to six significant digits, keeping every digit of a large one', () => {
    expect(formatStat(15322.7123)).toBe('15,322.7');
    expect(formatStat(12345678.9)).toBe('12,345,679');
    expect(formatStat(NaN)).toBe('–');
  });

  it('asks to add a parameter when there is none', async () => {
    const t = setup({}, [1]);
    t.view.setShown(true);
    await flush();
    expect(t.root.querySelector('.totals-empty')).not.toBeNull();
    expect(t.root.querySelector<HTMLButtonElement>('.totals-copy')!.disabled).toBe(true);
  });

  it('shows the sum first, then count, min, max and average, with the unit', async () => {
    const t = setup({ 'Q.Volume': numeric('Q.Volume', [1, 2, 4, NaN]) }, [1, 2, 3, 4]);
    t.controller.addRow('Q.Volume');
    t.view.setShown(true);
    await flush();
    const row = t.root.querySelector('.totals-row')!;
    expect(row.querySelector('.totals-sum-value')!.textContent).toBe('7');
    expect(row.querySelector('.totals-sum-unit')!.textContent).toBe('m³');
    expect([...row.querySelectorAll('.totals-stat')].map((s) => s.textContent)).toEqual(['n3', 'min1', 'max4', 'avg2.33333']);
    expect(row.textContent).toContain('3 of 4 have a value');
    expect(t.root.querySelector('.totals-scope')!.textContent).toBe('All visible: 4 elements');
  });

  it('never adds up two units: one line per unit, and the reason', async () => {
    const t = setup({ 'Q.Volume': numeric('Q.Volume', [1, 2, 3], [M3, FT3], [0, 1, 0]) }, [1, 2, 3]);
    t.controller.addRow('Q.Volume');
    t.view.setShown(true);
    await flush();
    const units = [...t.root.querySelectorAll('.totals-unit')].map((u) => u.querySelector('.totals-sum-value')!.textContent + ' ' + u.querySelector('.totals-sum-unit')!.textContent);
    expect(units).toEqual(['4 m³', '2 ft³']);
    expect(t.root.querySelector('.totals-note.warn')!.textContent).toMatch(/different units/);
  });

  it('says quietly when the selection does not have the parameter', async () => {
    const t = setup({ 'Q.Volume': numeric('Q.Volume', [NaN, 2]) }, [1, 2], { kind: 'selection', elements: new Map([['a', [1]]]) });
    t.controller.addRow('Q.Volume');
    t.view.setShown(true);
    await flush();
    expect(t.root.querySelector('.totals-note.quiet')!.textContent).toBe('Not in this selection');
  });

  it('counts text and its distinct values', async () => {
    const t = setup({ 'P.Mark': discrete('P.Mark', ['A', 'B', 'A']) }, [1, 2, 3]);
    t.controller.addRow('P.Mark');
    t.view.setShown(true);
    await flush();
    expect([...t.root.querySelectorAll('.totals-stat')].map((s) => s.textContent)).toEqual(['Count3', 'Distinct2']);
  });

  it('removes a row with its ×', async () => {
    const t = setup({ 'Q.Volume': numeric('Q.Volume', [1]) }, [1]);
    t.controller.addRow('Q.Volume');
    t.view.setShown(true);
    await flush();
    t.root.querySelector<HTMLButtonElement>('.totals-row-remove')!.click();
    await flush();
    expect(t.root.querySelectorAll('.totals-row')).toHaveLength(0);
  });

  describe('grouped', () => {
    const cols = {
      'Q.Volume': numeric('Q.Volume', [1, 2, 10, 4]),
      'Identity.IfcClass': discrete('Identity.IfcClass', ['IfcBeam', 'IfcSlab', 'IfcWall', 'IfcBeam']),
    };

    async function grouped() {
      const t = setup(cols, [11, 12, 13, 14]);
      t.controller.addRow('Q.Volume');
      t.controller.setGroupBy('Identity.IfcClass');
      t.view.setShown(true);
      await flush();
      const labels = (): string[] =>
        [...t.root.querySelectorAll('.totals-line:not(.totals-line-head) .totals-label')].map((e) => e.textContent!);
      return { ...t, labels };
    }

    it('draws one line per group, by sum, largest first, each with a bar', async () => {
      const t = await grouped();
      expect(t.labels()).toEqual(['IfcWall', 'IfcBeam', 'IfcSlab']);
      const bars = [...t.root.querySelectorAll<HTMLElement>('.totals-bar')].map((b) => b.style.width);
      expect(bars).toEqual(['100%', '50%', '20%']);
      expect(t.root.querySelector('.totals-group-btn')!.textContent).toBe('IfcClass');
    });

    it('sorts by a column when its header is clicked, and back again', async () => {
      const t = await grouped();
      const header = (label: string) =>
        [...t.root.querySelectorAll<HTMLButtonElement>('.totals-sort')].find((b) => b.textContent!.startsWith(label))!;
      header('n').click();
      expect(t.labels()).toEqual(['IfcBeam', 'IfcSlab', 'IfcWall']);
      header('n').click();
      expect(t.labels()).toEqual(['IfcSlab', 'IfcWall', 'IfcBeam']);
      header('IfcClass').click();
      expect(t.labels()).toEqual(['IfcBeam', 'IfcSlab', 'IfcWall']);
    });

    it('selects a group\'s elements when its line is clicked', async () => {
      const t = await grouped();
      t.root.querySelectorAll<HTMLElement>('.totals-line:not(.totals-line-head)')[1].click();
      expect(t.deps.select).toHaveBeenCalledWith([
        { modelId: 'a', expressId: 11 },
        { modelId: 'a', expressId: 14 },
      ]);
    });

    it('switches a row to a share chart and back', async () => {
      const t = await grouped();
      t.root.querySelector<HTMLButtonElement>('.totals-chart-btn')!.click();
      await flush();
      const paths = t.root.querySelectorAll('.totals-donut path');
      expect(paths).toHaveLength(3);
      expect(paths[0].querySelector('title')!.textContent).toBe('IfcWall: 10 m³ (58.8%)');
      t.root.querySelector<HTMLButtonElement>('.totals-chart-btn')!.click();
      await flush();
      expect(t.root.querySelector('.totals-donut')).toBeNull();
    });

    it('copies the tables as tab-separated text', async () => {
      const t = await grouped();
      t.root.querySelector<HTMLButtonElement>('.totals-copy')!.click();
      await flush();
      const text = t.copy.mock.calls[0][0] as string;
      const lines = text.split('\n');
      expect(lines[0]).toBe('All visible: 4 elements');
      expect(lines[2].split('\t')).toEqual(['Parameter', 'IfcClass', 'Unit', 'Count', 'Sum', 'Min', 'Max', 'Average', 'Distinct']);
      expect(lines[3].split('\t')).toEqual(['Q.Volume', '', 'm³', '4', '17', '1', '10', '4.25', '']);
      expect(lines[4].split('\t').slice(0, 5)).toEqual(['Q.Volume', 'IfcWall', 'm³', '1', '10']);
      expect(t.root.querySelector('.totals-copy')!.textContent).toBe('Copied');
    });

    it('has a find box once a table has many groups, and keeps to it', async () => {
      const n = TOTALS_FILTER_FROM + 5;
      const t = setup(
        {
          'Q.Volume': numeric('Q.Volume', Array.from({ length: n }, (_, i) => i + 1)),
          'P.Mark': discrete('P.Mark', Array.from({ length: n }, (_, i) => `M${i}`)),
        },
        Array.from({ length: n }, (_, i) => i + 1),
      );
      t.controller.addRow('Q.Volume');
      t.controller.setGroupBy('P.Mark');
      t.view.setShown(true);
      await flush();
      const find = t.root.querySelector<HTMLInputElement>('.totals-find')!;
      find.value = 'M2';
      find.dispatchEvent(new Event('input'));
      const labels = [...t.root.querySelectorAll('.totals-line:not(.totals-line-head) .totals-label')].map((e) => e.textContent);
      expect(labels.every((l) => l!.includes('M2'))).toBe(true);
      expect(labels.length).toBeGreaterThan(1);
    });
  });

  it('offers parameters to add with their kind and unit, numbers first', async () => {
    const t = setup({ 'Q.Volume': numeric('Q.Volume', [1]), 'P.Mark': discrete('P.Mark', ['A']) }, [1]);
    t.view.setShown(true);
    t.root.querySelector<HTMLButtonElement>('.totals-add')!.click();
    await flush();
    expect(t.picker.open).toHaveBeenCalledTimes(1);
    const rows = t.picker.open.mock.calls[0][3] as { key: string; value: string }[];
    expect(rows[0].key).toBe('Q.Volume');
    t.picker.open.mock.calls[0][4]('P.Mark');
    expect(t.controller.hasRow('P.Mark')).toBe(true);
  });

  it('describes a choice by kind, unit and count; group-by puts class and type first', () => {
    expect(choiceText({ key: 'Q', kind: 'numeric', count: 1235, units: [{ ...M3, count: 1235 }], distinct: 3 })).toBe('number · m³ · 1,235 el.');
    expect(choiceText({ key: 'Q', kind: 'text', count: 3, units: [], distinct: 2 })).toBe('text · 2 values · 3 el.');
    const order = groupChoices([
      { key: 'Q.Volume', kind: 'numeric', count: 1, units: [], distinct: 1 },
      { key: 'P.Mark', kind: 'text', count: 1, units: [], distinct: 1 },
      { key: 'Identity.Type', kind: 'text', count: 1, units: [], distinct: 1 },
      { key: 'Identity.GlobalId', kind: 'text', count: 1, units: [], distinct: 1 },
      { key: 'Identity.IfcClass', kind: 'text', count: 1, units: [], distinct: 1 },
    ]).map((c) => c.key);
    expect(order).toEqual(['Identity.IfcClass', 'Identity.Type', 'P.Mark', 'Q.Volume']);
  });

  it('only draws while shown', async () => {
    const t = setup({ 'Q.Volume': numeric('Q.Volume', [1]) }, [1]);
    t.controller.addRow('Q.Volume');
    await flush();
    expect(t.root.querySelectorAll('.totals-row')).toHaveLength(0);
    t.view.setShown(true);
    await flush();
    expect(t.root.querySelectorAll('.totals-row')).toHaveLength(1);
  });
});

/** Totals over several models: `models` maps a model to its element ids and columns. */
function setupModels(models: Record<string, { ids: number[]; columns: Record<string, ColumnData> }>) {
  const deps: TotalsDeps = {
    models: () => Object.keys(models),
    scope: () => ({ kind: 'visible' }),
    describe: async (m): Promise<ModelParameters> => ({
      modelId: m,
      scopeSize: models[m].ids.length,
      parameters: Object.keys(models[m].columns).map(summary),
    }),
    scopeIds: (m) => Int32Array.from(models[m].ids),
    loadColumn: async (m, key): Promise<ParameterColumn> => ({ ...models[m].columns[key], modelId: m, ids: Int32Array.from(models[m].ids) }),
    releaseColumn: () => {},
    select: vi.fn(),
    storage: null,
    debounceMs: 0,
  };
  const controller = new TotalsController(deps);
  const view = new TotalsView({ controller, picker: { open: vi.fn() }, modelName: (m) => `${m.toUpperCase()}.ifc` });
  document.body.replaceChildren(view.getElement());
  return { controller, view, deps, root: view.getElement() };
}

describe('TotalsView: look-alike groups and units', () => {
  const unstated: UnitRef = { key: '?LENGTHUNIT', symbol: '' };
  const two = () =>
    setupModels({
      a: { ids: [1], columns: { 'Q.Volume': numeric('Q.Volume', [1]), 'P.Len': numeric('P.Len', [3], [unstated]) } },
      b: { ids: [2], columns: { 'Q.Volume': numeric('Q.Volume', [2]), 'P.Len': numeric('P.Len', [3], [unstated]) } },
    });

  it('names the model of each look-alike group, and a share-chart entry selects its own group', async () => {
    const t = two();
    t.controller.addRow('Q.Volume');
    t.controller.setGroupBy('P.Len');
    t.controller.setChart('Q.Volume', 'pie');
    t.view.setShown(true);
    await flush();
    const labels = [...t.root.querySelectorAll('.totals-line:not(.totals-line-head) .totals-label')].map((e) => e.textContent);
    expect(labels).toEqual(['3 (B.ifc)', '3 (A.ifc)']);
    const entries = [...t.root.querySelectorAll<HTMLElement>('.totals-pie-entry')];
    expect(entries.map((e) => e.querySelector('.totals-pie-label')!.textContent)).toEqual(['3 (B.ifc)', '3 (A.ifc)']);
    entries[1].click();
    expect(t.deps.select).toHaveBeenLastCalledWith([{ modelId: 'a', expressId: 1 }]);
    entries[0].click();
    expect(t.deps.select).toHaveBeenLastCalledWith([{ modelId: 'b', expressId: 2 }]);
  });

  it('names the models when it will not add up units they leave unstated', async () => {
    const t = two();
    t.controller.addRow('P.Len');
    t.view.setShown(true);
    await flush();
    expect(t.root.querySelector('.totals-note.warn')!.textContent).toBe(
      'Values are in different units (unit not stated (A.ifc) on 1, unit not stated (B.ifc) on 1), so they are not added up',
    );
  });
});

describe('TotalsView: the keyboard keeps its place', () => {
  const cols = {
    'Q.Volume': numeric('Q.Volume', [1, 2, 10, 4]),
    'Q.Area': numeric('Q.Area', [1, 1, 1, 1]),
    'Identity.IfcClass': discrete('Identity.IfcClass', ['IfcBeam', 'IfcSlab', 'IfcWall', 'IfcBeam']),
  };

  async function grouped() {
    const t = setup(cols, [11, 12, 13, 14]);
    t.controller.addRow('Q.Volume');
    t.controller.addRow('Q.Area');
    t.controller.setGroupBy('Identity.IfcClass');
    t.view.setShown(true);
    await flush();
    return t;
  }

  const focused = (): string | undefined => (document.activeElement as HTMLElement | null)?.dataset.focus;

  it('a sort header keeps the focus when the table is sorted', async () => {
    const t = await grouped();
    const n = [...t.root.querySelectorAll<HTMLButtonElement>('.totals-sort')].find((b) => b.textContent!.startsWith('n'))!;
    n.focus();
    n.click();
    expect(focused()).toBe(n.dataset.focus);
    expect(document.activeElement).not.toBe(n);
  });

  it('a group line keeps the focus when the totals are counted again', async () => {
    const t = await grouped();
    const line = t.root.querySelectorAll<HTMLElement>('.totals-line:not(.totals-line-head)')[1];
    const key = line.dataset.focus;
    line.focus();
    t.controller.invalidate();
    await flush();
    expect(focused()).toBe(key);
  });

  it('the chart toggle keeps the focus when pressed', async () => {
    const t = await grouped();
    const toggle = t.root.querySelector<HTMLButtonElement>('.totals-chart-btn')!;
    toggle.focus();
    toggle.click();
    await flush();
    expect(focused()).toBe('chart:Q.Volume');
  });

  it('removing a row hands the focus to the next row', async () => {
    const t = await grouped();
    const remove = t.root.querySelector<HTMLButtonElement>('.totals-row-remove')!;
    remove.focus();
    remove.click();
    await flush();
    expect(focused()).toBe('remove:Q.Area');
  });

  it('reading progress is updated in place, without rebuilding under the keyboard', async () => {
    const t = setup({ 'Q.Volume': numeric('Q.Volume', [1]), 'Q.Area': numeric('Q.Area', [2]) }, [1]);
    const progress: ((d: number, total: number) => void)[] = [];
    let finish!: () => void;
    const area = t.deps.loadColumn;
    t.deps.loadColumn = (m, key, onProgress) => {
      if (key !== 'Q.Area') return area(m, key, onProgress);
      progress.push(onProgress);
      return new Promise((resolve) => (finish = () => void area(m, key, onProgress).then(resolve)));
    };
    t.controller.addRow('Q.Volume');
    t.controller.addRow('Q.Area');
    t.view.setShown(true);
    await flush();
    const remove = t.root.querySelector<HTMLButtonElement>('.totals-row-remove')!;
    remove.focus();
    progress[0](40, 100);
    await flush();
    expect(document.activeElement).toBe(remove);
    const area0 = t.root.querySelectorAll('.totals-row')[1];
    expect(area0.querySelector('[data-progress="text"]')!.textContent).toBe('Reading values… 40 of 100');
    progress[0](80, 100);
    await flush();
    expect(t.root.querySelectorAll('.totals-row')[1]).toBe(area0);
    expect(area0.querySelector<HTMLElement>('[data-progress="fill"]')!.style.width).toBe('80%');
    finish();
    await flush();
    expect(document.activeElement).toBe(t.root.querySelector('[data-focus="remove:Q.Volume"]'));
  });
});

describe('Parameters panel with a Totals tab', () => {
  const data: ModelParameters = { modelId: 'm', scopeSize: 1, parameters: [summary('Q.Volume')] };

  function panel() {
    const totals = { el: document.createElement('div'), shown: [] as boolean[] };
    const added: string[] = [];
    const parent = document.createElement('div');
    const p = new ParametersPanel(parent, {
      getModels: () => [{ id: 'm', name: 'A.ifc' }],
      describe: async () => data,
      colourBy: () => {},
      totals: { getElement: () => totals.el, setShown: (on) => totals.shown.push(on) },
      addToTotals: (param) => added.push(param.key),
    });
    return { p, parent, totals, added };
  }

  it('Σ on a parameter row adds it to Totals and shows that tab', async () => {
    const t = panel();
    t.p.open('m');
    await flush();
    t.parent.querySelector<HTMLButtonElement>('[data-key="Q.Volume"] .param-totals-btn')!.click();
    expect(t.added).toEqual(['Q.Volume']);
    expect(t.p.currentTab()).toBe('totals');
    expect(t.totals.el.classList.contains('hidden')).toBe(false);
    expect(t.parent.querySelector('.params-panel-body:not(.hidden) .param-list')).toBeNull();
    expect(last(t.totals.shown)).toBe(true);
  });

  it('opens straight on Totals, and tells it when it is hidden', () => {
    const t = panel();
    t.p.openTotals();
    expect(t.p.isOpen()).toBe(true);
    expect(last(t.totals.shown)).toBe(true);
    t.parent.querySelector<HTMLButtonElement>('.params-panel-tab[data-tab="parameters"]')!.click();
    expect(t.p.currentTab()).toBe('parameters');
    expect(last(t.totals.shown)).toBe(false);
    t.p.openTotals();
    t.p.close();
    expect(last(t.totals.shown)).toBe(false);
  });

  it('moves between tabs with the arrow keys, Home and End', () => {
    const t = panel();
    t.p.open('m');
    const tab = (name: string) => t.parent.querySelector<HTMLButtonElement>(`.params-panel-tab[data-tab="${name}"]`)!;
    document.body.appendChild(t.parent);
    expect(tab('parameters').tabIndex).toBe(0);
    expect(tab('totals').tabIndex).toBe(-1);
    const key = (k: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    tab('parameters').focus();
    key('ArrowRight');
    expect(t.p.currentTab()).toBe('totals');
    expect(document.activeElement).toBe(tab('totals'));
    expect(tab('totals').tabIndex).toBe(0);
    key('ArrowRight');
    expect(t.p.currentTab()).toBe('parameters');
    key('End');
    expect(t.p.currentTab()).toBe('totals');
    key('Home');
    expect(t.p.currentTab()).toBe('parameters');
    key('ArrowLeft');
    expect(t.p.currentTab()).toBe('totals');
    t.parent.remove();
  });

  it('keeps the Totals tab open when the model shown is closed and others are left', () => {
    const models = [{ id: 'm', name: 'A.ifc' }, { id: 'n', name: 'B.ifc' }];
    const parent = document.createElement('div');
    const p = new ParametersPanel(parent, {
      getModels: () => models,
      describe: async () => data,
      totals: { getElement: () => document.createElement('div'), setShown: () => {} },
    });
    p.open('m');
    p.showTab('totals');
    models.shift();
    p.onModelRemoved('m');
    expect(p.isOpen()).toBe(true);
    expect(p.currentTab()).toBe('totals');
  });
});

describe('the right-click menu', () => {
  const actions = (): ContextMenuActions => ({
    hide: () => {},
    isolate: () => {},
    showAll: () => {},
    transparent: () => {},
    opaque: () => {},
    clearTransparency: () => {},
    addToBasket: () => {},
    selectSimilarCategory: () => {},
    selectSimilarType: () => {},
    totals: vi.fn(),
  });

  it('offers Totals for selection', () => {
    const a = actions();
    const items = buildContextMenuItems(
      { kind: 'single', identities: [{ modelId: 'm', expressId: 1, ifcClass: 'IfcBeam', ifcTypeCode: 1 }] },
      { hasHidden: false, hasTransparent: false },
      a,
    )!;
    const item = items.find((i) => 'label' in i && i.label === 'Totals for selection');
    expect(item).toBeDefined();
    (item as { onClick: () => void }).onClick();
    expect(a.totals).toHaveBeenCalled();
  });
});

describe('LoadGate', () => {
  it('says each time the last load ends', () => {
    const gate = new LoadGate();
    const idle = vi.fn();
    gate.onIdle(idle);
    const a = gate.begin();
    const b = gate.begin();
    a();
    expect(idle).not.toHaveBeenCalled();
    b();
    expect(idle).toHaveBeenCalledTimes(1);
  });
});
