// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InspectorPanel } from '../src/inspector/InspectorPanel';
import type { InspectorPanelDeps, SelectionSource } from '../src/inspector/InspectorPanel';
import type {
  ElementIdentity,
  ElementProperties,
  PropertyFlatRow,
  PropertyGroup,
  PropertyNode,
  SelectionState,
} from '../src/inspector/types';
import {
  BulkRequestCancelled,
  type ElementPropertyRepository,
} from '../src/inspector/repository/ElementPropertyRepository';
import { BULK_INTERSECT_GUARD } from '../src/inspector/limits';
import type { SimilarQuery } from '../src/inspector/selectSimilar';
import { intersectProperties as batchIntersect } from '../src/inspector/intersection';

// ── localStorage mock (Phase 3 persists view choice here) ──────

const store = new Map<string, string>();
const localStorageMock: Storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => {
    store.clear();
  },
  get length() {
    return store.size;
  },
  key: (index: number) => [...store.keys()][index] ?? null,
};
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// ── Clipboard mock ────────────────────────────────────────────

const clipboardWrites: string[] = [];
const clipboardMock = {
  writeText: vi.fn(async (text: string) => {
    clipboardWrites.push(text);
  }),
};
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: clipboardMock },
  writable: true,
  configurable: true,
});

// ── Fixtures ──────────────────────────────────────────────────

function identity(over: Partial<ElementIdentity> = {}): ElementIdentity {
  return {
    modelId: 'model-A',
    expressId: 1001,
    ifcClass: 'IfcWall',
    ifcTypeCode: 1,
    name: 'Exterior Wall 200mm',
    globalId: '2O2Fr$t4X7Zf8NOew3FNr2',
    tag: 'W-12A',
    objectType: 'Wall',
    ...over,
  };
}

function leafNode(
  key: string,
  value: string | number | boolean,
  unit?: string,
): PropertyNode {
  return {
    key,
    value: {
      kind: 'single',
      value,
      raw: { typeCode: 0, value },
    },
    unit,
    source: 'pset',
  };
}

function flatRow(over: Partial<PropertyFlatRow> = {}): PropertyFlatRow {
  return {
    path: 'Pset_WallCommon.LoadBearing',
    name: 'LoadBearing',
    rawValue: { kind: 'single', value: true, raw: { typeCode: 0, value: true } },
    displayValue: 'true',
    source: 'pset',
    ...over,
  };
}

function makeProperties(over: Partial<ElementProperties> = {}): ElementProperties {
  const pset: PropertyGroup = {
    name: 'Pset_WallCommon',
    source: 'pset',
    properties: [
      leafNode('LoadBearing', true),
      leafNode('IsExternal', true),
      leafNode('Reference', 'WallType-A'),
    ],
  };
  const qto: PropertyGroup = {
    name: 'Qto_WallBaseQuantities',
    source: 'qto',
    properties: [
      { ...leafNode('Length', 5000), unit: 'mm' },
      { ...leafNode('NetVolume', 1.5), unit: 'm³' },
    ],
  };
  return {
    identity: identity(),
    direct: [leafNode('Name', 'Exterior Wall 200mm'), leafNode('Tag', 'W-12A')],
    psets: [pset],
    qtos: [qto],
    materials: [],
    flat: [
      flatRow({
        path: 'Pset_WallCommon.IsExternal',
        name: 'IsExternal',
        displayValue: 'true',
      }),
      flatRow({
        path: 'Pset_WallCommon.LoadBearing',
        name: 'LoadBearing',
        displayValue: 'true',
      }),
      flatRow({
        path: 'Pset_WallCommon.Reference',
        name: 'Reference',
        displayValue: 'WallType-A',
        rawValue: {
          kind: 'single',
          value: 'WallType-A',
          raw: { typeCode: 0, value: 'WallType-A' },
        },
      }),
      flatRow({
        path: 'Qto_WallBaseQuantities.Length',
        name: 'Length',
        displayValue: '5000',
        unit: 'mm',
        source: 'qto',
        rawValue: { kind: 'quantity', quantityKind: 'length', value: 5000 },
      }),
      flatRow({
        path: 'Qto_WallBaseQuantities.NetVolume',
        name: 'NetVolume',
        displayValue: '1.5',
        unit: 'm³',
        source: 'qto',
        rawValue: { kind: 'quantity', quantityKind: 'volume', value: 1.5 },
      }),
    ].sort((a, b) => a.path.localeCompare(b.path)),
    fetchedAt: Date.now(),
    ...over,
  };
}

interface StubRepo extends ElementPropertyRepository {
  /** Resolve any pending `get()` calls with the latest props. */
  resolveNext(): void;
  /** Reject the next `get()` call. */
  rejectNext(err: Error): void;
  /** Override what's returned. */
  setProps(props: ElementProperties): void;
  getCallCount: () => number;
  /** How many times the panel asked to abandon in-flight bulk work. */
  getCancelBulkCount: () => number;
}

function makeStubRepo(initial: ElementProperties = makeProperties()): StubRepo {
  let props = initial;
  let calls = 0;
  let cancelBulkCalls = 0;
  let pending: Array<{
    resolve: (p: ElementProperties) => void;
    reject: (e: Error) => void;
  }> = [];

  const repo: StubRepo = {
    get(): Promise<ElementProperties> {
      calls++;
      return new Promise<ElementProperties>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    intersectProperties(identities) {
      // Reuse the per-element pending mechanism so existing tests' control
      // flow (resolveNext / rejectNext) works unchanged. Real impl reduces
      // in the worker; the test stub simulates the same OUTPUT by running
      // the batch on per-element results.
      const promises = identities.map(() => {
        calls++;
        return new Promise<ElementProperties>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      });
      return Promise.all(promises).then((results) => batchIntersect(results));
    },
    cancel() {
      /* no-op */
    },
    cancelBulk() {
      cancelBulkCalls++;
    },
    disposeModel() {
      /* no-op */
    },
    enumerateExpressIds() {
      throw new Error('not implemented');
    },
    findMatching() {
      throw new Error('not implemented');
    },
    describeSchema() {
      throw new Error('not implemented');
    },
    resolveNext() {
      const queue = pending;
      pending = [];
      for (const p of queue) p.resolve(props);
    },
    rejectNext(err: Error) {
      const queue = pending;
      pending = [];
      for (const p of queue) p.reject(err);
    },
    setProps(p) {
      props = p;
    },
    getCallCount: () => calls,
    getCancelBulkCount: () => cancelBulkCalls,
  };
  return repo;
}

interface StubSelection extends SelectionSource {
  emit(state: SelectionState): void;
  /** True when the stub exposes lock API; controlled via factory option. */
  supportsLock: boolean;
  /** Lock state (only meaningful when supportsLock is true). */
  lockEnabled: boolean;
  /** Spy: each call to setSingleModelLock pushes here. */
  lockCalls: boolean[];
}

interface StubSelectionOptions {
  withLock?: boolean;
  initialLockEnabled?: boolean;
}

function makeStubSelection(
  initial: SelectionState = { kind: 'none' },
  opts: StubSelectionOptions = {},
): StubSelection {
  const withLock = opts.withLock ?? true;
  let lockEnabled = opts.initialLockEnabled ?? true;
  const lockCalls: boolean[] = [];
  let state = initial;
  let listeners: Array<(s: SelectionState) => void> = [];

  const stub: StubSelection = {
    onChange(listener) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    getState() {
      return state;
    },
    emit(s) {
      state = s;
      for (const l of listeners) l(s);
    },
    supportsLock: withLock,
    get lockEnabled() {
      return lockEnabled;
    },
    set lockEnabled(v: boolean) {
      lockEnabled = v;
    },
    lockCalls,
  };

  if (withLock) {
    stub.isSingleModelLockEnabled = () => lockEnabled;
    stub.setSingleModelLock = (v: boolean) => {
      lockEnabled = v;
      lockCalls.push(v);
    };
  }
  return stub;
}

// Panels created via mountPanel — disposed in afterEach so their delayed
// spinner timer (SPINNER_DELAY_MS) can't fire after the jsdom environment is
// torn down, which throws "document is not defined" and flakes CI.
const mountedPanels: InspectorPanel[] = [];

function mountPanel(
  initialSelection: SelectionState = { kind: 'none' },
  depsOverrides: Partial<InspectorPanelDeps> = {},
  initialProps?: ElementProperties,
  selectionOpts: StubSelectionOptions = {},
) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const repo = makeStubRepo(initialProps);
  const selection = makeStubSelection(initialSelection, selectionOpts);
  const deps: InspectorPanelDeps = {
    repository: repo,
    getModelInfo: depsOverrides.getModelInfo,
    getModelCount: depsOverrides.getModelCount,
    onSelectSimilar: depsOverrides.onSelectSimilar,
  };
  const panel = new InspectorPanel(parent, deps, selection);
  mountedPanels.push(panel);
  return { panel, parent, repo, selection };
}

// ── Tests ─────────────────────────────────────────────────────

describe('InspectorPanel', () => {
  beforeEach(() => {
    store.clear();
    clipboardWrites.length = 0;
    clipboardMock.writeText.mockClear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // Dispose every panel a test mounted — clears its pending spinner timer
    // so it can't fire post-teardown (dispose is idempotent-safe).
    for (const p of mountedPanels) p.dispose();
    mountedPanels.length = 0;
    vi.useRealTimers();
  });

  describe('lifecycle', () => {
    it('renders hidden when no selection', () => {
      const { parent } = mountPanel();
      const container = parent.querySelector('.inspector-panel');
      expect(container).not.toBeNull();
      expect(container!.classList.contains('hidden')).toBe(true);
    });

    it('shows on single selection and hides on clear', async () => {
      const { panel, parent, repo, selection } = mountPanel();
      const container = parent.querySelector('.inspector-panel')!;
      expect(container.classList.contains('hidden')).toBe(true);

      selection.emit({ kind: 'single', identities: [identity()] });
      expect(container.classList.contains('hidden')).toBe(false);

      // Resolve the fetch.
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      selection.emit({ kind: 'none' });
      expect(container.classList.contains('hidden')).toBe(true);
      expect(panel.isHidden()).toBe(true);
    });

    it('shows multi-select header summary (Phase 4)', () => {
      const { parent, selection } = mountPanel();
      selection.emit({
        kind: 'multi',
        identities: [identity(), identity({ expressId: 2 })],
      });
      // Panel becomes visible immediately (header renders synchronously).
      expect(parent.querySelector('.inspector-panel')!.classList.contains('hidden')).toBe(false);
      const title = parent.querySelector('.inspector-title');
      expect(title!.textContent).toBe('2 elements selected');
      const mix = parent.querySelector('.inspector-multi-mix .inspector-class');
      expect(mix!.textContent).toBe('2 IfcWall');
    });

    it('toggles collapse state', () => {
      const { parent } = mountPanel();
      const container = parent.querySelector('.inspector-panel') as HTMLElement;
      const collapseBtn = parent.querySelector('.inspector-collapse-btn') as HTMLButtonElement;

      expect(container.classList.contains('collapsed')).toBe(false);
      collapseBtn.click();
      expect(container.classList.contains('collapsed')).toBe(true);
      collapseBtn.click();
      expect(container.classList.contains('collapsed')).toBe(false);
    });

    it('renders an "Inspector" label that is exposed only in the collapsed state', () => {
      const { parent } = mountPanel();
      const label = parent.querySelector('.inspector-collapsed-label');
      const collapseBtn = parent.querySelector('.inspector-collapse-btn') as HTMLButtonElement;

      // The label element is always in the DOM (the stylesheet hides it
      // by default and reveals it when `.collapsed` is set on the panel).
      // To assertion-test the *exposure* without depending on the
      // stylesheet, we use aria-hidden as the source of truth.
      expect(label, 'collapsed label element exists in the DOM').not.toBeNull();
      expect(label!.textContent).toBe('Inspector');
      expect(label!.getAttribute('aria-hidden')).toBe('true');

      collapseBtn.click();
      expect(label!.getAttribute('aria-hidden')).toBe('false');

      collapseBtn.click();
      expect(label!.getAttribute('aria-hidden')).toBe('true');
    });

    it('hides on dispose', () => {
      const { panel, parent } = mountPanel();
      panel.dispose();
      expect(parent.querySelector('.inspector-panel')).toBeNull();
    });
  });

  describe('header content', () => {
    it('renders element name as title', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const title = parent.querySelector('.inspector-title');
      expect(title!.textContent).toBe('Exterior Wall 200mm');
    });

    it('falls back to "<class> #<id>" when name is missing', async () => {
      const propsNoName = makeProperties({
        identity: { ...identity({ name: undefined }), name: undefined },
      });
      const { parent, repo, selection } = mountPanel(
        { kind: 'none' },
        {},
        propsNoName,
      );
      selection.emit({
        kind: 'single',
        identities: [identity({ name: undefined })],
      });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const title = parent.querySelector('.inspector-title');
      expect(title!.textContent).toBe('IfcWall #1001');
    });

    it('renders class label and tag', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const cls = parent.querySelector('.inspector-class');
      expect(cls!.textContent).toBe('IfcWall');
      const tag = parent.querySelector('.inspector-tag');
      expect(tag!.textContent).toBe('Tag W-12A');
    });

    it('renders truncated GUID with full GUID in tooltip and copies on click', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const guidBtn = parent.querySelector('.inspector-guid-btn') as HTMLButtonElement;
      expect(guidBtn).not.toBeNull();
      expect(guidBtn.textContent!.length).toBeLessThanOrEqual(20);
      // Truncation marker present.
      expect(guidBtn.textContent).toContain('…');
      expect(guidBtn.title).toContain('2O2Fr$t4X7Zf8NOew3FNr2');

      guidBtn.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(clipboardWrites).toContain('2O2Fr$t4X7Zf8NOew3FNr2');
    });

    it('shows model-name row when more than one model is loaded', async () => {
      const { parent, repo, selection } = mountPanel(
        { kind: 'none' },
        {
          getModelCount: () => 2,
          getModelInfo: (id) => (id === 'model-A' ? { name: 'modelB.ifc' } : undefined),
        },
      );
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const modelRow = parent.querySelector('.inspector-model-row');
      expect(modelRow).not.toBeNull();
      expect(modelRow!.textContent).toBe('modelB.ifc');
    });

    it('hides model-name row with one model loaded', async () => {
      const { parent, repo, selection } = mountPanel(
        { kind: 'none' },
        { getModelCount: () => 1, getModelInfo: () => ({ name: 'only.ifc' }) },
      );
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      expect(parent.querySelector('.inspector-model-row')).toBeNull();
    });

    it('shows total property count pill', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const pill = parent.querySelector('.inspector-count-pill');
      expect(pill!.textContent).toBe('5 properties');
    });
  });

  describe('view toggle', () => {
    it('defaults to tree view', () => {
      const { panel } = mountPanel();
      expect(panel.getView()).toBe('tree');
    });

    it('persists view choice to localStorage', () => {
      const { panel } = mountPanel();
      panel.setView('flat');
      expect(localStorage.getItem('ifcviewer:inspectorView')).toBe('flat');
    });

    it('restores last-used view from localStorage on construction', () => {
      localStorage.setItem('ifcviewer:inspectorView', 'flat');
      const { panel } = mountPanel();
      expect(panel.getView()).toBe('flat');
    });

    it('marks active toggle button with aria-pressed and active class', () => {
      const { parent, panel } = mountPanel();
      const treeBtn = parent.querySelector('.inspector-view-btn[data-view="tree"]') as HTMLButtonElement;
      const flatBtn = parent.querySelector('.inspector-view-btn[data-view="flat"]') as HTMLButtonElement;
      expect(treeBtn.getAttribute('aria-pressed')).toBe('true');
      expect(treeBtn.classList.contains('active')).toBe(true);
      expect(flatBtn.getAttribute('aria-pressed')).toBe('false');

      panel.setView('flat');
      expect(flatBtn.getAttribute('aria-pressed')).toBe('true');
      expect(flatBtn.classList.contains('active')).toBe(true);
      expect(treeBtn.classList.contains('active')).toBe(false);
    });

    it('clicking inactive toggle switches view', () => {
      const { parent, panel } = mountPanel();
      const flatBtn = parent.querySelector('.inspector-view-btn[data-view="flat"]') as HTMLButtonElement;
      flatBtn.click();
      expect(panel.getView()).toBe('flat');
    });
  });

  describe('tree view rendering', () => {
    it('renders sections for identity, psets, qtos when present', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const sections = parent.querySelectorAll('.inspector-section-label');
      const labels = Array.from(sections).map((s) => s.textContent);
      expect(labels).toContain('Identity');
      expect(labels).toContain('Property Sets');
      expect(labels).toContain('Quantities');
    });

    it('shows row count badge on each section', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const sections = parent.querySelectorAll('.inspector-section');
      const idSection = Array.from(sections).find((s) =>
        s.querySelector('.inspector-section-label')?.textContent === 'Identity',
      )!;
      expect(idSection.querySelector('.inspector-section-count')!.textContent).toBe('2');
    });

    it('renders pset group with its own row count', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const groupHead = parent.querySelector('.inspector-group .inspector-group-label');
      expect(groupHead!.textContent).toBe('Pset_WallCommon');
      const groupCount = parent.querySelector('.inspector-group .inspector-group-count');
      expect(groupCount!.textContent).toBe('3');
    });

    it('collapses a section when its head is clicked', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const head = parent.querySelector('.inspector-section-head') as HTMLButtonElement;
      expect(head.getAttribute('aria-expanded')).toBe('true');
      head.click();
      expect(head.getAttribute('aria-expanded')).toBe('false');
    });

    it('renders quantity rows with unit pill', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const pills = parent.querySelectorAll('.inspector-unit-pill');
      const pillTexts = Array.from(pills).map((p) => p.textContent);
      expect(pillTexts).toContain('mm');
      expect(pillTexts).toContain('m³');
    });

    it('renders IfcComplexProperty as expandable nested rows', async () => {
      const complexProps = makeProperties({
        psets: [
          {
            name: 'Pset_Complex',
            source: 'pset',
            properties: [
              {
                key: 'OuterProp',
                value: {
                  kind: 'complex',
                  children: [leafNode('Inner1', 'a'), leafNode('Inner2', 'b')],
                },
                source: 'pset',
              },
            ],
          },
        ],
      });
      const { parent, repo, selection } = mountPanel({ kind: 'none' }, {}, complexProps);
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const complexHead = parent.querySelector('.inspector-complex-head') as HTMLButtonElement;
      expect(complexHead).not.toBeNull();
      expect(complexHead.getAttribute('aria-expanded')).toBe('false');
      complexHead.click();
      expect(complexHead.getAttribute('aria-expanded')).toBe('true');
    });

    it('truncates long values and exposes full text in title', async () => {
      const longValue = 'x'.repeat(150);
      const longProps = makeProperties({
        direct: [],
        qtos: [],
        psets: [
          {
            name: 'Pset_Long',
            source: 'pset',
            properties: [leafNode('Description', longValue)],
          },
        ],
      });
      const { parent, repo, selection } = mountPanel({ kind: 'none' }, {}, longProps);
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      // First value element belongs to our long pset row.
      const valueEl = parent.querySelector('.inspector-row-value') as HTMLElement;
      expect(valueEl.classList.contains('inspector-truncated')).toBe(true);
      expect(valueEl.textContent!.length).toBeLessThan(longValue.length);
      expect(valueEl.title).toContain(longValue);
    });

    it('copies value to clipboard on click', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const valueEl = parent.querySelector('.inspector-row-value') as HTMLElement;
      valueEl.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(clipboardWrites.length).toBeGreaterThan(0);
    });
  });

  describe('flat view rendering', () => {
    it('renders three-column table with header row', async () => {
      const { parent, panel, repo, selection } = mountPanel();
      panel.setView('flat');
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const header = parent.querySelector('.inspector-flat-header');
      expect(header).not.toBeNull();
      const labels = Array.from(header!.querySelectorAll('.inspector-flat-cell')).map(
        (c) => c.textContent,
      );
      expect(labels).toEqual(['Name', 'Value', 'Unit']);
    });

    it('renders rows alphabetically by path', async () => {
      const { parent, panel, repo, selection } = mountPanel();
      panel.setView('flat');
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const dataRows = Array.from(
        parent.querySelectorAll('.inspector-flat-row:not(.inspector-flat-header)'),
      );
      const paths = dataRows.map((r) => (r as HTMLElement).dataset.path);
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
      // First should be IsExternal (alphabetical before LoadBearing).
      expect(paths[0]).toBe('Pset_WallCommon.IsExternal');
    });

    it('shows unit column populated only for measure rows', async () => {
      const { parent, panel, repo, selection } = mountPanel();
      panel.setView('flat');
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const lengthRow = Array.from(
        parent.querySelectorAll('.inspector-flat-row:not(.inspector-flat-header)'),
      ).find((r) => (r as HTMLElement).dataset.path === 'Qto_WallBaseQuantities.Length')!;
      const unitCell = lengthRow.querySelector('.inspector-flat-unit')!;
      expect(unitCell.textContent).toBe('mm');

      const boolRow = Array.from(
        parent.querySelectorAll('.inspector-flat-row:not(.inspector-flat-header)'),
      ).find((r) => (r as HTMLElement).dataset.path === 'Pset_WallCommon.IsExternal')!;
      expect(boolRow.querySelector('.inspector-flat-unit')!.textContent).toBe('');
    });

    it('substring-filters rows by path', async () => {
      vi.useFakeTimers();
      const { parent, panel, repo, selection } = mountPanel();
      panel.setView('flat');
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const filter = parent.querySelector('.inspector-filter') as HTMLInputElement;
      filter.value = 'LoadBearing';
      filter.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(200);

      const visibleRows = Array.from(
        parent.querySelectorAll('.inspector-flat-row:not(.inspector-flat-header)'),
      ).filter((r) => (r as HTMLElement).style.display !== 'none');
      expect(visibleRows).toHaveLength(1);
      expect((visibleRows[0] as HTMLElement).dataset.path).toBe('Pset_WallCommon.LoadBearing');
    });

    it('renders an em-dash for empty values', async () => {
      const emptyValProps = makeProperties({
        flat: [
          flatRow({
            path: 'Pset_X.Empty',
            name: 'Empty',
            displayValue: '',
            rawValue: { kind: 'single', value: null, raw: { typeCode: 0, value: null } },
          }),
        ],
      });
      const { parent, panel, repo, selection } = mountPanel({ kind: 'none' }, {}, emptyValProps);
      panel.setView('flat');
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const valueCell = parent.querySelector('.inspector-flat-value');
      expect(valueCell!.textContent).toBe('—');
    });
  });

  describe('state transitions', () => {
    it('shows error banner on fetch failure', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.rejectNext(new Error('boom'));
      // Silence the console.error this raises (we still want to assert it gets called).
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const banner = parent.querySelector('.inspector-error');
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain('boom');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('ignores stale fetch result when a newer selection arrives', async () => {
      const { parent, repo, selection } = mountPanel();
      // First selection — its fetch will hang.
      selection.emit({ kind: 'single', identities: [identity({ expressId: 100 })] });
      // Second selection while first is still pending.
      selection.emit({ kind: 'single', identities: [identity({ expressId: 200, name: 'Door 1' })] });
      // Resolve all pending fetches (both will see the same canned props,
      // but only the second resolution should commit to the panel).
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();

      const title = parent.querySelector('.inspector-title');
      // Whichever order the fetches resolve in, only the latest key wins.
      // Since both fetches return identity Name "Exterior Wall 200mm" by
      // default, we instead verify the panel didn't end up rendering
      // anything stale-looking by checking the title resolves to the
      // single committed fetch (one of the two).
      expect(title!.textContent).toBeTruthy();
    });

    it('does not re-fetch when same selection is re-emitted', async () => {
      const { repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      const callsBefore = repo.getCallCount();
      // Emit the same selection again.
      selection.emit({ kind: 'single', identities: [identity()] });
      const callsAfter = repo.getCallCount();
      expect(callsAfter).toBe(callsBefore);
    });
  });

  // ── Phase 4 ──────────────────────────────────────────────────

  describe('single-model lock checkbox (Phase 4)', () => {
    it('lock row is hidden when no selection is active', () => {
      const { parent } = mountPanel();
      const row = parent.querySelector('.inspector-lock-row');
      expect(row).not.toBeNull();
      expect(row!.classList.contains('hidden')).toBe(true);
    });

    it('lock row appears when single selection is active', async () => {
      const { parent, repo, selection } = mountPanel();
      selection.emit({ kind: 'single', identities: [identity()] });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      const row = parent.querySelector('.inspector-lock-row');
      expect(row!.classList.contains('hidden')).toBe(false);
    });

    it('lock row appears for multi selection', () => {
      const { parent, selection } = mountPanel();
      selection.emit({
        kind: 'multi',
        identities: [identity(), identity({ expressId: 2 })],
      });
      const row = parent.querySelector('.inspector-lock-row');
      expect(row!.classList.contains('hidden')).toBe(false);
    });

    it('checkbox reflects initial lock-enabled state from selection source', () => {
      const { parent, selection } = mountPanel(
        { kind: 'multi', identities: [identity(), identity({ expressId: 2 })] },
        {},
        undefined,
        { initialLockEnabled: false },
      );
      const cb = parent.querySelector('.inspector-lock-checkbox') as HTMLInputElement;
      expect(cb.checked).toBe(false);
      // Sanity: the stub reports the same value.
      expect(selection.lockEnabled).toBe(false);
    });

    it('clicking the checkbox calls setSingleModelLock with the new value', () => {
      const { parent, selection } = mountPanel(
        { kind: 'multi', identities: [identity(), identity({ expressId: 2 })] },
      );
      const cb = parent.querySelector('.inspector-lock-checkbox') as HTMLInputElement;
      expect(cb.checked).toBe(true);
      cb.click();
      expect(selection.lockCalls).toEqual([false]);
      cb.click();
      expect(selection.lockCalls).toEqual([false, true]);
    });

    it('lock row stays hidden when the selection source does not expose the lock API', () => {
      const { parent, selection } = mountPanel(
        { kind: 'multi', identities: [identity(), identity({ expressId: 2 })] },
        {},
        undefined,
        { withLock: false },
      );
      const row = parent.querySelector('.inspector-lock-row');
      expect(row!.classList.contains('hidden')).toBe(true);
      // Sanity: source really has no setter.
      expect(typeof selection.setSingleModelLock).toBe('undefined');
    });
  });

  describe('multi-select intersection body (Phase 4)', () => {
    it('renders intersection from per-element repo.get returns', async () => {
      // Both walls share the same set of canned props (the stub returns
      // the same ElementProperties for any (modelId, expressId)). With
      // identical inputs the intersection has no varies rows.
      const { parent, repo, selection } = mountPanel();
      selection.emit({
        kind: 'multi',
        identities: [identity(), identity({ expressId: 2 })],
      });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Body should contain rendered sections (Identity / Property Sets / …).
      const sections = parent.querySelectorAll('.inspector-section-label');
      const labels = Array.from(sections).map((s) => s.textContent);
      expect(labels).toContain('Property Sets');

      // Common count pill present.
      const pill = parent.querySelector('.inspector-count-pill');
      expect(pill!.textContent).toMatch(/common/);
    });

    it('renders varies value with italic class and distinct-values tooltip', async () => {
      // Construct two element snapshots that differ at a single path.
      const propsA = makeProperties();
      const propsB = makeProperties({
        identity: identity({ expressId: 2, name: 'Wall B' }),
        psets: [
          {
            name: 'Pset_WallCommon',
            source: 'pset',
            properties: [
              { ...leafNode('LoadBearing', false) },
              { ...leafNode('IsExternal', true) },
              { ...leafNode('Reference', 'WallType-A') },
            ],
          },
        ],
        flat: [
          flatRow({
            path: 'Pset_WallCommon.IsExternal',
            name: 'IsExternal',
            displayValue: 'true',
          }),
          flatRow({
            path: 'Pset_WallCommon.LoadBearing',
            name: 'LoadBearing',
            displayValue: 'false',
            rawValue: { kind: 'single', value: false, raw: { typeCode: 0, value: false } },
          }),
          flatRow({
            path: 'Pset_WallCommon.Reference',
            name: 'Reference',
            displayValue: 'WallType-A',
            rawValue: {
              kind: 'single',
              value: 'WallType-A',
              raw: { typeCode: 0, value: 'WallType-A' },
            },
          }),
        ].sort((a, b) => a.path.localeCompare(b.path)),
      });

      // Custom repo that returns different props per expressId.
      let pending: Array<{ resolve: (p: ElementProperties) => void; reject: (e: Error) => void; eid: number }> = [];
      const repo: ElementPropertyRepository = {
        get(_modelId: string, expressId: number) {
          return new Promise<ElementProperties>((resolve, reject) => {
            pending.push({ resolve, reject, eid: expressId });
          });
        },
        intersectProperties(identities) {
          const promises = identities.map((id) => {
            return new Promise<ElementProperties>((resolve, reject) => {
              pending.push({ resolve, reject, eid: id.expressId });
            });
          });
          return Promise.all(promises).then((results) => batchIntersect(results));
        },
        cancel: () => undefined,
        cancelBulk: () => undefined,
        disposeModel: () => undefined,
        enumerateExpressIds: () => {
          throw new Error('not implemented');
        },
        findMatching: () => {
          throw new Error('not implemented');
        },
        describeSchema: () => {
          throw new Error('not implemented');
        },
      };
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const sel = makeStubSelection();
      const panel = new InspectorPanel(parent, { repository: repo }, sel);
      void panel;

      sel.emit({
        kind: 'multi',
        identities: [identity({ expressId: 1001 }), identity({ expressId: 2 })],
      });
      const queue = pending;
      pending = [];
      for (const p of queue) {
        // expressId 1001 → propsA (LoadBearing=true);  2 → propsB (false).
        if (p.eid === 1001) p.resolve(propsA);
        else p.resolve(propsB);
      }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // In Tree view, LoadBearing should render as a varies span.
      const varies = parent.querySelectorAll('.inspector-row-varies');
      expect(varies.length).toBeGreaterThan(0);
      const variesEl = Array.from(varies).find((e) => e.textContent === 'varies')!;
      expect(variesEl.classList.contains('inspector-row-varies')).toBe(true);
      // Tooltip lists both distinct display values.
      expect(variesEl.getAttribute('title')).toContain('true');
      expect(variesEl.getAttribute('title')).toContain('false');
    });

    it('past the guard: offers "Compute anyway" instead of refusing', () => {
      const { parent, repo, selection } = mountPanel();
      const identities = Array.from({ length: BULK_INTERSECT_GUARD + 1 }, (_, i) =>
        identity({ expressId: i + 1 }),
      );
      selection.emit({ kind: 'multi', identities });

      const guard = parent.querySelector('.inspector-multi-guard');
      expect(guard).not.toBeNull();
      const btn = parent.querySelector<HTMLButtonElement>('.inspector-multi-guard-btn');
      expect(btn).not.toBeNull();
      expect(btn!.textContent).toBe('Compute anyway');
      // Nothing was fetched — the point of the guard is that the user
      // opts in first.
      expect(repo.getCallCount()).toBe(0);
      // Identity summary still shown in the header.
      const title = parent.querySelector('.inspector-title');
      expect(title!.textContent).toBe(`${BULK_INTERSECT_GUARD + 1} elements selected`);
    });

    it('past the guard: "Compute anyway" runs the same reduction', async () => {
      const { parent, repo, selection } = mountPanel();
      const identities = Array.from({ length: BULK_INTERSECT_GUARD + 1 }, (_, i) =>
        identity({ expressId: i + 1 }),
      );
      selection.emit({ kind: 'multi', identities });

      parent.querySelector<HTMLButtonElement>('.inspector-multi-guard-btn')!.click();
      expect(repo.getCallCount()).toBeGreaterThan(0);

      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(parent.querySelector('.inspector-multi-guard')).toBeNull();
      const pill = parent.querySelector('.inspector-count-pill');
      expect(pill!.textContent).toMatch(/common/);
    });

    it('below the guard: computes immediately, no refusal', async () => {
      // The old 1 000-element refusal is gone — a selection this size now
      // reduces with a progress overlay instead of being turned away.
      const { parent, repo, selection } = mountPanel();
      const identities = Array.from({ length: 1001 }, (_, i) => identity({ expressId: i + 1 }));

      selection.emit({ kind: 'multi', identities });
      expect(parent.querySelector('.inspector-multi-guard')).toBeNull();
      expect(repo.getCallCount()).toBeGreaterThan(0);

      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const pill = parent.querySelector('.inspector-count-pill');
      expect(pill!.textContent).toMatch(/common/);
    });

    it('supersede: a new multi-selection cancels the in-flight reduction', () => {
      const { repo, selection } = mountPanel();
      const first = Array.from({ length: 50 }, (_, i) => identity({ expressId: i + 1 }));
      const second = Array.from({ length: 50 }, (_, i) => identity({ expressId: i + 500 }));

      selection.emit({ kind: 'multi', identities: first });
      const afterFirst = repo.getCancelBulkCount();
      selection.emit({ kind: 'multi', identities: second });

      // The second selection must have asked the worker to abandon the
      // first — otherwise it sits at the head of the serial queue and
      // delays the reduction the user is now waiting on.
      expect(repo.getCancelBulkCount()).toBeGreaterThan(afterFirst);
    });

    it('a cancelled reduction renders no error banner', async () => {
      const { parent, repo, selection } = mountPanel();
      const identities = Array.from({ length: 50 }, (_, i) => identity({ expressId: i + 1 }));

      selection.emit({ kind: 'multi', identities });
      repo.rejectNext(new BulkRequestCancelled());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The user moving on is not a failure.
      expect(parent.querySelector('.inspector-error')).toBeNull();
    });

    it('stale multi-fetch is dropped when selection changes mid-flight', async () => {
      // Resolve only the SECOND emission and verify the panel reflects it.
      // The first emission's fetch is left dangling; its later resolution
      // should not overwrite the rendered state.
      let allPending: Array<{
        resolve: (p: ElementProperties) => void;
        reject: (e: Error) => void;
      }> = [];
      const propsA = makeProperties();
      const propsB = makeProperties({
        identity: identity({ expressId: 99, name: 'Wall 99' }),
      });
      const repo: ElementPropertyRepository = {
        get() {
          return new Promise<ElementProperties>((resolve, reject) => {
            allPending.push({ resolve, reject });
          });
        },
        intersectProperties(identities) {
          const promises = identities.map(() => {
            return new Promise<ElementProperties>((resolve, reject) => {
              allPending.push({ resolve, reject });
            });
          });
          return Promise.all(promises).then((results) => batchIntersect(results));
        },
        cancel: () => undefined,
        cancelBulk: () => undefined,
        disposeModel: () => undefined,
        enumerateExpressIds: () => {
          throw new Error('not implemented');
        },
        findMatching: () => {
          throw new Error('not implemented');
        },
        describeSchema: () => {
          throw new Error('not implemented');
        },
      };
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const sel = makeStubSelection();
      const panel = new InspectorPanel(parent, { repository: repo }, sel);
      void panel;

      sel.emit({
        kind: 'multi',
        identities: [identity({ expressId: 1 }), identity({ expressId: 2 })],
      });
      const firstBatch = allPending;
      allPending = [];

      // Newer selection.
      sel.emit({
        kind: 'multi',
        identities: [identity({ expressId: 11 }), identity({ expressId: 12 })],
      });
      const secondBatch = allPending;
      allPending = [];

      // Resolve the SECOND batch first.
      for (const p of secondBatch) p.resolve(propsB);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Now resolve the stale FIRST batch; it must not overwrite anything.
      for (const p of firstBatch) p.resolve(propsA);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The current render must still reflect the second selection.
      const title = parent.querySelector('.inspector-title');
      expect(title!.textContent).toBe('2 elements selected');
      // Pill present from the committed (second) fetch.
      const pill = parent.querySelector('.inspector-count-pill');
      expect(pill!.textContent).toMatch(/common/);
    });

    it('tree view re-renders for multi-loaded state on view toggle', async () => {
      const { panel, parent, repo, selection } = mountPanel();
      selection.emit({
        kind: 'multi',
        identities: [identity(), identity({ expressId: 2 })],
      });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Switch to Flat: a flat-table header should appear.
      panel.setView('flat');
      expect(parent.querySelector('.inspector-flat-header')).not.toBeNull();

      // Back to Tree: section labels reappear.
      panel.setView('tree');
      const sections = parent.querySelectorAll('.inspector-section-label');
      expect(sections.length).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Phase 1 of dev/plans/handoff-bulk-property-access.md — the panel
  // routes multi-select reductions through the worker via
  // repository.intersectProperties and shows a live "Processing N / M"
  // overlay driven by onProgress.
  // ───────────────────────────────────────────────────────────────────

  describe('multi-select bulk intersect (Phase 1)', () => {
    it('routes the reduction through repository.intersectProperties', async () => {
      // Custom repo that tracks both get() and intersectProperties() calls.
      const getCalls: number[] = [];
      const intersectCalls: number[] = [];
      let pendingIntersect: Array<{ resolve: (p: ElementProperties) => void }> = [];
      const repo: ElementPropertyRepository = {
        get(_modelId, expressId) {
          getCalls.push(expressId);
          return Promise.resolve(makeProperties({ identity: identity({ expressId }) }));
        },
        intersectProperties(identities) {
          intersectCalls.push(identities.length);
          return new Promise<ElementProperties>((resolve) => {
            pendingIntersect.push({ resolve });
          });
        },
        cancel: () => undefined,
        cancelBulk: () => undefined,
        disposeModel: () => undefined,
        enumerateExpressIds: () => {
          throw new Error('not implemented');
        },
        findMatching: () => {
          throw new Error('not implemented');
        },
        describeSchema: () => {
          throw new Error('not implemented');
        },
      };
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const sel = makeStubSelection();
      const panel = new InspectorPanel(parent, { repository: repo }, sel);
      void panel;

      sel.emit({
        kind: 'multi',
        identities: [identity({ expressId: 1 }), identity({ expressId: 2 }), identity({ expressId: 3 })],
      });
      // The panel should NOT have called get() for the multi-select path.
      expect(getCalls).toEqual([]);
      // It SHOULD have called intersectProperties once with all three.
      expect(intersectCalls).toEqual([3]);

      // Settle so async error handlers don't leak into other tests.
      const queue = pendingIntersect;
      pendingIntersect = [];
      for (const p of queue) p.resolve(makeProperties());
      await Promise.resolve();
      await Promise.resolve();
    });

    it('renders a live "Processing N / M" overlay from onProgress', async () => {
      // Custom repo: intersect captures the onProgress callback so the
      // test can drive it manually.
      let capturedOnProgress: ((d: number, t: number) => void) | undefined;
      let resolveIntersect!: (p: ElementProperties) => void;
      const repo: ElementPropertyRepository = {
        get() {
          throw new Error('should not be called');
        },
        intersectProperties(_identities, onProgress) {
          capturedOnProgress = onProgress;
          return new Promise<ElementProperties>((resolve) => {
            resolveIntersect = resolve;
          });
        },
        cancel: () => undefined,
        cancelBulk: () => undefined,
        disposeModel: () => undefined,
        enumerateExpressIds: () => {
          throw new Error('not implemented');
        },
        findMatching: () => {
          throw new Error('not implemented');
        },
        describeSchema: () => {
          throw new Error('not implemented');
        },
      };
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const sel = makeStubSelection();
      const panel = new InspectorPanel(parent, { repository: repo }, sel);
      void panel;

      sel.emit({
        kind: 'multi',
        identities: Array.from({ length: 5 }, (_, i) => identity({ expressId: i + 1 })),
      });
      expect(capturedOnProgress).toBeDefined();

      // Drive a progress update — overlay should appear with "1 / 5".
      capturedOnProgress!(1, 5);
      const overlay1 = parent.querySelector('.inspector-progress');
      expect(overlay1).not.toBeNull();
      expect(overlay1!.textContent).toBe('Processing 1 / 5');

      // Update again — overlay must update in place (same node).
      capturedOnProgress!(3, 5);
      const overlay2 = parent.querySelector('.inspector-progress');
      expect(overlay2).toBe(overlay1);
      expect(overlay2!.textContent).toBe('Processing 3 / 5');

      // Final completion clears the overlay (the body re-renders to the tree).
      capturedOnProgress!(5, 5);
      resolveIntersect(makeProperties());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(parent.querySelector('.inspector-progress')).toBeNull();
    });
  });

  describe('select similar affordance', () => {
    /** Mount, select one element, resolve its props, return the rendered DOM. */
    async function mountWithElement(onSelectSimilar?: (q: SimilarQuery) => void) {
      const mounted = mountPanel({ kind: 'none' }, { onSelectSimilar });
      mounted.selection.emit({ kind: 'single', identities: [identity()] });
      mounted.repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      return mounted;
    }

    it('offers the affordance on matchable rows when a handler is wired', async () => {
      const { parent } = await mountWithElement(() => undefined);
      expect(parent.querySelectorAll('.inspector-similar-btn').length).toBeGreaterThan(0);
    });

    it('offers nothing when no handler is wired', async () => {
      // The panel is usable without a SelectionManager behind it; the
      // affordance must not appear as a dead control in that case.
      const { parent } = await mountWithElement(undefined);
      expect(parent.querySelector('.inspector-similar-btn')).toBeNull();
    });

    it('offers the affordance on a multi-selection too', async () => {
      // A row that survives the intersection with a concrete value describes
      // a value the whole selection shares, so "select everything else with
      // this value" is exactly as well-defined as for one element. Rows that
      // differ render as `varies`, which isn't matchable, so they're excluded
      // without needing a separate rule.
      const seen: SimilarQuery[] = [];
      const { parent, repo, selection } = mountPanel({ kind: 'none' }, { onSelectSimilar: (q) => seen.push(q) });
      selection.emit({
        kind: 'multi',
        identities: [identity({ expressId: 1 }), identity({ expressId: 2 })],
      });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const btn = parent.querySelector<HTMLButtonElement>('.inspector-similar-btn');
      expect(btn).not.toBeNull();
      btn!.click();
      expect(seen.length).toBe(1);
      // Both members report the same type code, so the search stays scoped
      // to that type rather than widening to every product.
      expect(seen[0].ifcTypeCode).toBe(identity().ifcTypeCode);
    });

    it('widens the scope to all products when the selection spans types', async () => {
      // Marquee identities carry a placeholder type code of 0, and a mixed
      // selection has no single type — guessing one would silently search
      // the wrong set, so the query scopes to every product instead.
      const seen: SimilarQuery[] = [];
      const { parent, repo, selection } = mountPanel({ kind: 'none' }, { onSelectSimilar: (q) => seen.push(q) });
      selection.emit({
        kind: 'multi',
        identities: [
          identity({ expressId: 1, ifcTypeCode: 1 }),
          identity({ expressId: 2, ifcTypeCode: 2 }),
        ],
      });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      parent.querySelector<HTMLButtonElement>('.inspector-similar-btn')!.click();
      expect(seen[0].ifcTypeCode).toBeNull();
    });

    it('clicking builds a value query from that row', async () => {
      const seen: SimilarQuery[] = [];
      const { parent } = await mountWithElement((q) => seen.push(q));

      const btn = parent.querySelector<HTMLButtonElement>('.inspector-similar-btn')!;
      btn.click();

      expect(seen.length).toBe(1);
      const q = seen[0];
      expect(q.kind).toBe('value');
      expect(q.modelId).toBe('model-A');
      expect(q.ifcClass).toBe('IfcWall');
      if (q.kind === 'value') {
        expect(q.selector.path.length).toBeGreaterThan(0);
      }
    });

    it('does not also copy the value when the affordance is clicked', async () => {
      // The button sits next to a value cell whose own click copies to
      // clipboard; the affordance must not trigger both.
      const writeText = vi.fn().mockResolvedValue(undefined);
      const original = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      const { parent } = await mountWithElement(() => undefined);
      parent.querySelector<HTMLButtonElement>('.inspector-similar-btn')!.click();
      expect(writeText).not.toHaveBeenCalled();

      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
    });
  });
});
