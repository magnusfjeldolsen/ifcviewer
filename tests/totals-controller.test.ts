/**
 * Totals (#69): the controller behind the Totals tab. What it counts
 * (selection, else everything visible), that it follows changes only while
 * the tab is open, that nothing runs while it is closed, and what it
 * remembers.
 */

import { describe, it, expect, vi } from 'vitest';
import { TotalsController, type TotalsDeps, type TotalsScope } from '../src/inspector/TotalsController';
import {
  parseTotalsSettings,
  serialiseTotalsSettings,
  TOTALS_STORAGE,
  type SettingsStorage,
} from '../src/inspector/totalsSettings';
import type { ColumnData, ParameterColumn } from '../src/inspector/parameterColumn';
import { ColumnBuildCancelled } from '../src/inspector/repository/ElementPropertyRepository';
import type { ModelParameters, ParameterSummary } from '../src/inspector/types';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function memoryStorage(initial: Record<string, string> = {}): SettingsStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => void (data[k] = v),
  };
}

function summary(key: string): ParameterSummary {
  return { key, count: 1, kind: 'numeric', distinct: 1, uniquePerElement: false };
}

interface FakeModel {
  ids: number[];
  columns: Record<string, ColumnData>;
}

const vol = (values: number[]): ColumnData => ({
  type: 'numeric',
  key: 'Q.Volume',
  count: values.length,
  values: Float64Array.from(values),
  units: [{ key: 'si:m³', symbol: 'm³' }],
  unitIndex: null,
});

const cls = (values: string[]): ColumnData => {
  const dictionary = [...new Set(values)];
  return { type: 'discrete', key: 'Identity.IfcClass', count: values.length, codes: Int32Array.from(values.map((v) => dictionary.indexOf(v))), dictionary };
};

/** A world of models, a selection and a visibility rule; columns resolve when asked (or when told). */
function world(models: Record<string, FakeModel>, opts: { storage?: SettingsStorage; manual?: boolean } = {}) {
  let scope: TotalsScope = { kind: 'visible' };
  const hidden = new Set<string>();
  const pending: { modelId: string; key: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  const deps: TotalsDeps = {
    models: () => Object.keys(models),
    scope: () => scope,
    visibility: (m) => (id) => !hidden.has(`${m}:${id}`),
    describe: vi.fn(async (m: string): Promise<ModelParameters> => ({
      modelId: m,
      scopeSize: models[m].ids.length,
      parameters: Object.keys(models[m].columns).map(summary),
    })),
    scopeIds: (m) => Int32Array.from(models[m].ids),
    loadColumn: vi.fn((m: string, key: string) => {
      const column = (): ParameterColumn => ({ ...models[m].columns[key], modelId: m, ids: Int32Array.from(models[m].ids) });
      if (!opts.manual) return Promise.resolve(column());
      return new Promise<ParameterColumn>((resolve, reject) =>
        pending.push({ modelId: m, key, resolve: () => resolve(column()), reject }),
      );
    }),
    releaseColumn: vi.fn(),
    select: vi.fn(),
    storage: opts.storage ?? memoryStorage(),
    debounceMs: 0,
  };
  const c = new TotalsController(deps);
  return {
    c,
    deps,
    pending,
    setScope: (s: TotalsScope) => (scope = s),
    hide: (m: string, id: number) => hidden.add(`${m}:${id}`),
  };
}

const sel = (entries: Record<string, number[]>): TotalsScope => ({ kind: 'selection', elements: new Map(Object.entries(entries)) });

describe('TotalsController', () => {
  it('counts everything visible when nothing is selected, across models', async () => {
    const w = world({
      a: { ids: [1, 2, 3], columns: { 'Q.Volume': vol([1, 2, 3]) } },
      b: { ids: [7], columns: { 'Q.Volume': vol([10]) } },
    });
    w.c.addRow('Q.Volume');
    w.hide('a', 3);
    w.c.setActive(true);
    await flush();
    const s = w.c.getState();
    expect(s.scope).toEqual({ kind: 'visible', elements: 3, models: 2 });
    expect(s.rows[0].phase).toBe('ready');
    expect(s.rows[0].totals!.numbers[0].stats.sum).toBe(13);
  });

  it('counts the selection when there is one, and follows it', async () => {
    const w = world({ a: { ids: [1, 2, 3], columns: { 'Q.Volume': vol([1, 2, 3]) } } });
    w.c.addRow('Q.Volume');
    w.setScope(sel({ a: [1, 3] }));
    w.c.setActive(true);
    await flush();
    expect(w.c.getState().scope).toEqual({ kind: 'selection', elements: 2, models: 1 });
    expect(w.c.getState().rows[0].totals!.numbers[0].stats.sum).toBe(4);
    w.setScope(sel({ a: [2] }));
    w.c.invalidate();
    await flush();
    expect(w.c.getState().rows[0].totals!.numbers[0].stats.sum).toBe(2);
    // The column was read once; following the selection reads nothing new.
    expect(w.deps.loadColumn).toHaveBeenCalledTimes(2);
  });

  it('does nothing while the tab is closed, and counts when it opens', async () => {
    const w = world({ a: { ids: [1], columns: { 'Q.Volume': vol([5]) } } });
    w.c.addRow('Q.Volume');
    w.c.invalidate();
    await flush();
    expect(w.deps.describe).not.toHaveBeenCalled();
    expect(w.deps.loadColumn).not.toHaveBeenCalled();
    w.c.setActive(true);
    await flush();
    expect(w.c.getState().rows[0].totals!.withValue).toBe(1);
  });

  it('gives up the builds it started when the tab closes', async () => {
    const w = world({ a: { ids: [1], columns: { 'Q.Volume': vol([5]) } } }, { manual: true });
    w.c.addRow('Q.Volume');
    w.c.setActive(true);
    await flush();
    expect(w.pending).toHaveLength(1);
    w.c.setActive(false);
    expect(w.deps.releaseColumn).toHaveBeenCalledWith('a', 'Q.Volume');
  });

  it('gives up a build when its row is removed', async () => {
    const w = world({ a: { ids: [1], columns: { 'Q.Volume': vol([5]), 'Q.Area': vol([1]) } } }, { manual: true });
    w.c.addRow('Q.Volume');
    w.c.addRow('Q.Area');
    w.c.setActive(true);
    await flush();
    w.c.removeRow('Q.Area');
    expect(w.deps.releaseColumn).toHaveBeenCalledWith('a', 'Q.Area');
    expect(w.deps.releaseColumn).not.toHaveBeenCalledWith('a', 'Q.Volume');
  });

  it('asks for every missing column at once, so the worker can read them together', async () => {
    const w = world({ a: { ids: [1], columns: { 'Q.Volume': vol([5]), 'Q.Area': vol([1]), 'Identity.IfcClass': cls(['IfcBeam']) } } }, { manual: true });
    w.c.addRow('Q.Volume');
    w.c.addRow('Q.Area');
    w.c.setGroupBy('Identity.IfcClass');
    w.c.setActive(true);
    await flush();
    expect(w.pending.map((p) => p.key).sort()).toEqual(['Identity.IfcClass', 'Q.Area', 'Q.Volume']);
  });

  it('shows reading progress on a row until its column is built', async () => {
    const w = world({ a: { ids: [1], columns: { 'Q.Volume': vol([5]) } } }, { manual: true });
    w.c.addRow('Q.Volume');
    w.c.setActive(true);
    await flush();
    expect(w.c.getState().rows[0].phase).toBe('reading');
    w.pending[0].resolve();
    await flush();
    expect(w.c.getState().rows[0].phase).toBe('ready');
  });

  it('asks again when someone else gave up a build it still wants', async () => {
    const w = world({ a: { ids: [1], columns: { 'Q.Volume': vol([5]) } } }, { manual: true });
    w.c.addRow('Q.Volume');
    w.c.setActive(true);
    await flush();
    w.pending[0].reject(new ColumnBuildCancelled());
    await flush();
    expect(w.pending).toHaveLength(2);
    w.pending[1].resolve();
    await flush();
    expect(w.c.getState().rows[0].phase).toBe('ready');
  });

  it('a row whose parameter no model has says so, without reading anything', async () => {
    const w = world({ a: { ids: [1, 2], columns: { 'Q.Volume': vol([5, 6]) } } });
    w.c.addRow('Q.Missing');
    w.c.setActive(true);
    await flush();
    expect(w.c.getState().rows[0].totals!.kind).toBe('none');
    expect(w.deps.loadColumn).not.toHaveBeenCalled();
  });

  it('groups every row by the group-by parameter', async () => {
    const w = world({ a: { ids: [1, 2, 3], columns: { 'Q.Volume': vol([1, 2, 3]), 'Identity.IfcClass': cls(['IfcBeam', 'IfcSlab', 'IfcBeam']) } } });
    w.c.addRow('Q.Volume');
    w.c.setGroupBy('Identity.IfcClass');
    w.c.setActive(true);
    await flush();
    const groups = w.c.getState().rows[0].totals!.numbers[0].groups!;
    expect(groups.map((g) => [g.label, g.stats.sum])).toEqual([
      ['IfcBeam', 4],
      ['IfcSlab', 2],
    ]);
  });

  it('selects the elements of a line', async () => {
    const w = world({ a: { ids: [1, 2, 3], columns: { 'Q.Volume': vol([1, 2, 3]), 'Identity.IfcClass': cls(['IfcBeam', 'IfcSlab', 'IfcBeam']) } } });
    w.c.addRow('Q.Volume');
    w.c.setGroupBy('Identity.IfcClass');
    w.c.setActive(true);
    await flush();
    const beam = w.c.getState().rows[0].totals!.numbers[0].groups![0];
    expect(w.c.selectLine('Q.Volume', { groupKey: beam.key })).toBe(2);
    expect(w.deps.select).toHaveBeenCalledWith([
      { modelId: 'a', expressId: 1 },
      { modelId: 'a', expressId: 3 },
    ]);
  });

  it('remembers its rows, their charts and the group-by, by parameter key', () => {
    const storage = memoryStorage();
    const w = world({ a: { ids: [1], columns: {} } }, { storage });
    w.c.addRow('Q.Volume');
    w.c.addRow('Q.Area');
    w.c.setChart('Q.Area', 'pie');
    w.c.setGroupBy('Identity.Type');
    w.c.removeRow('Q.Volume');
    const again = world({ b: { ids: [1], columns: {} } }, { storage });
    const s = again.c.getState();
    expect(s.rows.map((r) => [r.key, r.chart])).toEqual([['Q.Area', 'pie']]);
    expect(s.groupBy).toBe('Identity.Type');
  });

  it('never starts a build it no longer wants after waiting for a load', async () => {
    const w = world({ a: { ids: [1], columns: { 'Q.Volume': vol([5]) } } });
    let loaded!: () => void;
    w.deps.waitForIdle = () => new Promise<void>((r) => (loaded = r));
    w.c.addRow('Q.Volume');
    w.c.setActive(true);
    await flush();
    // The tab closes while a model is still loading.
    w.c.setActive(false);
    loaded();
    await flush();
    expect(w.deps.loadColumn).not.toHaveBeenCalled();
  });

  it('asks for the column once the load is over when the tab is still open', async () => {
    const w = world({ a: { ids: [1], columns: { 'Q.Volume': vol([5]) } } });
    let loaded!: () => void;
    w.deps.waitForIdle = () => new Promise<void>((r) => (loaded = r));
    w.c.addRow('Q.Volume');
    w.c.setActive(true);
    await flush();
    expect(w.deps.loadColumn).not.toHaveBeenCalled();
    w.deps.waitForIdle = undefined;
    loaded();
    await flush();
    expect(w.deps.loadColumn).toHaveBeenCalledTimes(1);
    expect(w.c.getState().rows[0].phase).toBe('ready');
  });

  it('reads nothing while there is nothing to count, but still says what the scope is', async () => {
    const w = world({ a: { ids: [1, 2, 3], columns: { 'Q.Volume': vol([1, 2, 3]) } } });
    w.deps.visibleCount = vi.fn(() => 3);
    w.c.setActive(true);
    await flush();
    expect(w.deps.describe).not.toHaveBeenCalled();
    expect(w.c.getState().scope).toEqual({ kind: 'visible', elements: 3, models: 1 });
    w.setScope(sel({ a: [1, 2] }));
    w.c.invalidate();
    await flush();
    expect(w.c.getState().scope).toEqual({ kind: 'selection', elements: 2, models: 1 });
    expect(w.deps.describe).not.toHaveBeenCalled();
  });

  it('does not select elements of a model that was just closed', async () => {
    const w = world({
      a: { ids: [1], columns: { 'Q.Volume': vol([1]) } },
      b: { ids: [2], columns: { 'Q.Volume': vol([2]) } },
    });
    w.c.addRow('Q.Volume');
    w.c.setActive(true);
    await flush();
    w.c.onModelRemoved('b');
    w.c.selectLine('Q.Volume', {});
    expect(w.deps.select).toHaveBeenCalledWith([{ modelId: 'a', expressId: 1 }]);
  });

  it('lists every parameter of the loaded models for the pickers', async () => {
    const w = world({
      a: { ids: [1], columns: { 'Q.Volume': vol([1]) } },
      b: { ids: [2], columns: { 'Q.Volume': vol([2]), 'Q.Area': vol([3]) } },
    });
    const choices = await w.c.choices();
    expect(choices.map((c) => [c.key, c.count])).toEqual([
      ['Q.Area', 1],
      ['Q.Volume', 2],
    ]);
  });
});

describe('totals settings', () => {
  it('reads back what it wrote', () => {
    const s = { rows: [{ key: 'A' }, { key: 'B', chart: 'pie' as const }], groupBy: 'Identity.Type' };
    expect(parseTotalsSettings(serialiseTotalsSettings(s))).toEqual(s);
  });

  it('drops anything it cannot read rather than failing', () => {
    expect(parseTotalsSettings('not json')).toEqual({ rows: [], groupBy: null });
    expect(parseTotalsSettings('{"v":2,"rows":[{"key":"A"}]}')).toEqual({ rows: [], groupBy: null });
    expect(parseTotalsSettings('{"v":1,"rows":[{"key":"A"},{"key":""},7,{"key":"A"},{"key":"B","chart":"bar"}],"groupBy":5}')).toEqual({
      rows: [{ key: 'A' }, { key: 'B' }],
      groupBy: null,
    });
  });

  it('is stored under its own key as versioned JSON', () => {
    const storage = memoryStorage();
    const w = world({ a: { ids: [1], columns: {} } }, { storage });
    w.c.addRow('Q.Volume');
    expect(JSON.parse(storage.data[TOTALS_STORAGE])).toEqual({ v: 1, rows: [{ key: 'Q.Volume' }], groupBy: null });
  });

  it('works when storage is blocked', () => {
    const blocked: SettingsStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const w = world({ a: { ids: [1], columns: {} } }, { storage: blocked });
    expect(() => w.c.addRow('Q.Volume')).not.toThrow();
    expect(w.c.getState().rows).toHaveLength(1);
  });
});
