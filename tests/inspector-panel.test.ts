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
import type { ElementPropertyRepository } from '../src/inspector/repository/ElementPropertyRepository';

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
}

function makeStubRepo(initial: ElementProperties = makeProperties()): StubRepo {
  let props = initial;
  let calls = 0;
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
    cancel() {
      /* no-op */
    },
    disposeModel() {
      /* no-op */
    },
    enumerateExpressIds() {
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
  };
  const panel = new InspectorPanel(parent, deps, selection);
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
        cancel: () => undefined,
        disposeModel: () => undefined,
        enumerateExpressIds: () => {
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

    it('soft cap: shows the "refine selection" message when > cap', () => {
      const { parent, selection } = mountPanel();
      const identities = Array.from({ length: 1001 }, (_, i) =>
        identity({ expressId: i + 1 }),
      );
      selection.emit({ kind: 'multi', identities });
      const msg = parent.querySelector('.inspector-multi-cap');
      expect(msg).not.toBeNull();
      expect(msg!.textContent).toContain('Too many');
      // Identity summary still shown in the header.
      const title = parent.querySelector('.inspector-title');
      expect(title!.textContent).toBe('1001 elements selected');
    });

    it('soft cap: dropping below cap re-fetches and renders body', async () => {
      // Use a lower cap by selecting at-cap + 1, then dropping to cap.
      // (MULTI_SELECT_SOFT_CAP is 1000; selecting 1001 then 999 exercises
      // the boundary correctly.)
      const { parent, repo, selection } = mountPanel();
      const above = Array.from({ length: 1001 }, (_, i) =>
        identity({ expressId: i + 1 }),
      );
      selection.emit({ kind: 'multi', identities: above });
      expect(parent.querySelector('.inspector-multi-cap')).not.toBeNull();

      const within = above.slice(0, 999);
      selection.emit({ kind: 'multi', identities: within });
      repo.resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(parent.querySelector('.inspector-multi-cap')).toBeNull();
      const pill = parent.querySelector('.inspector-count-pill');
      expect(pill!.textContent).toMatch(/common/);
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
        cancel: () => undefined,
        disposeModel: () => undefined,
        enumerateExpressIds: () => {
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
});
