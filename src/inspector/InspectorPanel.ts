/**
 * Phase 3 of the Element Properties Inspector.
 *
 * DOM-driven panel (no framework) that subscribes to `SelectionManager.onChange`
 * and renders the properties of the currently selected element. The panel:
 *
 *   - Stays hidden when no element is selected (or while no model is loaded).
 *   - On a single-element selection, fetches properties via the repository,
 *     populates the header (identity), shows a count pill, and renders either
 *     a Tree or Flat view of the properties — switchable via icon toggle.
 *   - Shows a spinner if a fetch takes longer than ~50ms (avoids flicker on
 *     fast hits) and an inline error banner on failure.
 *   - Cancels stale fetches by checking the current selection key before
 *     committing rendered results.
 *
 * Multi-select rendering, intersection, varies sentinel, and the single-
 * model-lock checkbox are intentionally NOT implemented here — they land
 * in Phase 4. A multi-select snapshot just shows a short "coming in
 * Phase 4" message, keeping the panel hidden noise-free until then.
 *
 * Spec: dev/plans/phase-element-inspector.md, "UI design" section.
 */

import type {
  ElementIdentity,
  ElementProperties,
  PropertyFlatRow,
  PropertyGroup,
  PropertyNode,
  PropertyValue,
  SelectionState,
} from './types';
import type { ElementPropertyRepository } from './repository/ElementPropertyRepository';
import { displayStringForValue } from './repository/WebIfcPropertyRepository';

/** Persistence key for the user's last-used view (Tree vs Flat). */
const VIEW_STORAGE_KEY = 'ifcviewer:inspectorView';

/** Delay before showing the spinner. Avoids flicker for sub-50ms fetches. */
const SPINNER_DELAY_MS = 50;

/** Filter input debounce in the Flat view. */
const FILTER_DEBOUNCE_MS = 100;

/** Truncate values longer than this in display — tooltip carries the full text. */
const VALUE_TRUNCATE_AT = 80;

/** Truncate the GUID at this many chars in the header. */
const GUID_TRUNCATE_AT = 20;

/** Max nesting depth before complex properties flatten with a "…" prefix. */
const MAX_COMPLEX_DEPTH = 6;

/** Brief visual flash duration for a successful copy-to-clipboard. */
const COPY_FLASH_MS = 600;

export type ViewMode = 'tree' | 'flat';

export interface InspectorPanelDeps {
  repository: ElementPropertyRepository;
  /**
   * Called when the panel needs to show a model-name row in the header
   * (i.e. when more than one model is loaded). Returns undefined if no
   * record is available.
   */
  getModelInfo?: (modelId: string) => { name: string } | undefined;
  /**
   * Returns the number of currently loaded models, used to decide whether
   * to show the model-name row. Optional — defaults to 1.
   */
  getModelCount?: () => number;
}

/** Internal "what is the panel currently rendering" tag. */
type RenderTag =
  | { kind: 'hidden' }
  | { kind: 'fetching'; identity: ElementIdentity; key: string }
  | { kind: 'loaded'; props: ElementProperties; key: string }
  | { kind: 'error'; identity: ElementIdentity; message: string; key: string };

/** Listener subscription returned by onChange. */
export type Unsubscribe = () => void;

export interface SelectionSource {
  onChange(listener: (state: SelectionState) => void): Unsubscribe;
  getState(): SelectionState;
}

/** Read the persisted view mode, defaulting to tree. */
function readPersistedView(): ViewMode {
  try {
    const v = window.localStorage?.getItem(VIEW_STORAGE_KEY);
    return v === 'flat' ? 'flat' : 'tree';
  } catch {
    return 'tree';
  }
}

/** Persist the user's view choice. */
function writePersistedView(view: ViewMode): void {
  try {
    window.localStorage?.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    /* ignore — storage may be disabled */
  }
}

/** Identity key matching SelectionManager's internal one. */
function makeKey(identity: { modelId: string; expressId: number }): string {
  return `${identity.modelId}:${identity.expressId}`;
}

/** Best-effort copy via the async clipboard API, falling back to noop. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

/** Display title for an element. Prefers name; falls back to "<class> #<id>". */
function titleForIdentity(identity: ElementIdentity): string {
  if (identity.name && identity.name.trim() !== '') return identity.name;
  const cls = identity.ifcClass && identity.ifcClass !== '' ? identity.ifcClass : 'Element';
  return `${cls} #${identity.expressId}`;
}

/** Truncate `s` to `n` chars with an ellipsis. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

/** Total leaf-row count (used for the header pill). */
function totalPropertyCount(props: ElementProperties): number {
  return props.flat.length;
}

/** Tree-view row count for one group: leaves only (complex props recurse). */
function groupLeafCount(group: PropertyGroup): number {
  let n = 0;
  const walk = (nodes: PropertyNode[]): void => {
    for (const node of nodes) {
      if (node.value.kind === 'complex') walk(node.value.children);
      else n++;
    }
  };
  walk(group.properties);
  return n;
}

export class InspectorPanel {
  private container: HTMLElement;
  private header: HTMLElement;
  private subhead: HTMLElement;
  private titleEl: HTMLElement;
  private collapseBtn: HTMLButtonElement;
  private countPill: HTMLElement;
  private toggleTree: HTMLButtonElement;
  private toggleFlat: HTMLButtonElement;
  private body: HTMLElement;

  private repository: ElementPropertyRepository;
  private deps: InspectorPanelDeps;
  private selection: SelectionSource;
  private unsubscribeSelection: Unsubscribe;

  private view: ViewMode;
  private collapsed = false;
  private flatFilter = '';
  private filterDebounce: ReturnType<typeof setTimeout> | null = null;
  private spinnerTimer: ReturnType<typeof setTimeout> | null = null;
  private render: RenderTag = { kind: 'hidden' };

  /** Latest in-flight fetch key — newer fetches invalidate older ones. */
  private inflightKey: string | null = null;

  constructor(parent: HTMLElement, deps: InspectorPanelDeps, selection: SelectionSource) {
    this.repository = deps.repository;
    this.deps = deps;
    this.selection = selection;
    this.view = readPersistedView();

    this.container = document.createElement('div');
    this.container.className = 'inspector-panel hidden';
    parent.appendChild(this.container);

    // ── Header ──
    this.header = document.createElement('div');
    this.header.className = 'inspector-header';
    this.container.appendChild(this.header);

    const titleRow = document.createElement('div');
    titleRow.className = 'inspector-title-row';
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'inspector-title';
    this.titleEl.textContent = '';
    titleRow.appendChild(this.titleEl);

    const titleActions = document.createElement('div');
    titleActions.className = 'inspector-title-actions';
    this.collapseBtn = document.createElement('button');
    this.collapseBtn.className = 'inspector-collapse-btn';
    this.collapseBtn.title = 'Collapse panel';
    this.collapseBtn.textContent = '◀'; // ◀
    this.collapseBtn.addEventListener('click', () => this.toggleCollapse());
    const closeBtn = document.createElement('button');
    closeBtn.className = 'inspector-close-btn';
    closeBtn.title = 'Close';
    closeBtn.textContent = '✕'; // ✕
    closeBtn.addEventListener('click', () => this.hide());
    titleActions.appendChild(this.collapseBtn);
    titleActions.appendChild(closeBtn);
    titleRow.appendChild(titleActions);
    this.header.appendChild(titleRow);

    // Subhead: class · tag, GUID row, model name
    this.subhead = document.createElement('div');
    this.subhead.className = 'inspector-subhead';
    this.header.appendChild(this.subhead);

    // Phase 4 placeholder — single-model-selection checkbox row goes here.
    // Intentionally left empty in Phase 3.

    // ── Toolbar (pill + view toggle) ──
    const toolbar = document.createElement('div');
    toolbar.className = 'inspector-toolbar';
    this.countPill = document.createElement('span');
    this.countPill.className = 'inspector-count-pill';
    this.countPill.textContent = '';
    toolbar.appendChild(this.countPill);

    const toggleGroup = document.createElement('div');
    toggleGroup.className = 'inspector-view-toggle';
    this.toggleTree = document.createElement('button');
    this.toggleTree.className = 'inspector-view-btn';
    this.toggleTree.title = 'Tree view';
    this.toggleTree.setAttribute('aria-pressed', this.view === 'tree' ? 'true' : 'false');
    this.toggleTree.dataset.view = 'tree';
    this.toggleTree.textContent = '🌳'; // 🌳
    this.toggleTree.addEventListener('click', () => this.setView('tree'));
    this.toggleFlat = document.createElement('button');
    this.toggleFlat.className = 'inspector-view-btn';
    this.toggleFlat.title = 'Flat list view';
    this.toggleFlat.setAttribute('aria-pressed', this.view === 'flat' ? 'true' : 'false');
    this.toggleFlat.dataset.view = 'flat';
    this.toggleFlat.textContent = '📋'; // 📋
    this.toggleFlat.addEventListener('click', () => this.setView('flat'));
    if (this.view === 'tree') this.toggleTree.classList.add('active');
    else this.toggleFlat.classList.add('active');
    toggleGroup.appendChild(this.toggleTree);
    toggleGroup.appendChild(this.toggleFlat);
    toolbar.appendChild(toggleGroup);
    this.container.appendChild(toolbar);

    // ── Body ──
    this.body = document.createElement('div');
    this.body.className = 'inspector-body';
    this.container.appendChild(this.body);

    // Subscribe to selection changes.
    this.unsubscribeSelection = selection.onChange((s) => this.onSelectionChange(s));
    // Drive initial state.
    this.onSelectionChange(selection.getState());
  }

  // ── Public API ────────────────────────────────────────────

  getView(): ViewMode {
    return this.view;
  }

  setView(view: ViewMode): void {
    if (this.view === view) return;
    this.view = view;
    writePersistedView(view);
    this.toggleTree.setAttribute('aria-pressed', view === 'tree' ? 'true' : 'false');
    this.toggleFlat.setAttribute('aria-pressed', view === 'flat' ? 'true' : 'false');
    this.toggleTree.classList.toggle('active', view === 'tree');
    this.toggleFlat.classList.toggle('active', view === 'flat');
    // Re-render the body if we're in a loaded state.
    if (this.render.kind === 'loaded') this.renderBody(this.render.props);
  }

  isHidden(): boolean {
    return this.container.classList.contains('hidden');
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  dispose(): void {
    this.unsubscribeSelection();
    if (this.spinnerTimer) clearTimeout(this.spinnerTimer);
    if (this.filterDebounce) clearTimeout(this.filterDebounce);
    this.container.remove();
  }

  // ── Selection plumbing ────────────────────────────────────

  private onSelectionChange(state: SelectionState): void {
    if (state.kind === 'none') {
      this.hide();
      return;
    }
    if (state.kind === 'multi') {
      // Phase 4 will replace this; for Phase 3 we show a placeholder.
      this.renderMultiPlaceholder(state.identities.length);
      return;
    }
    // Single
    const identity = state.identities[0];
    const key = makeKey(identity);
    if (this.render.kind !== 'hidden' && this.getCurrentKey() === key) {
      // Same selection re-emitted; ignore to avoid flicker.
      return;
    }
    this.beginFetch(identity, key);
  }

  private getCurrentKey(): string | null {
    if (this.render.kind === 'hidden') return null;
    return this.render.key;
  }

  private beginFetch(identity: ElementIdentity, key: string): void {
    this.inflightKey = key;
    this.render = { kind: 'fetching', identity, key };
    this.show();
    this.renderHeader(identity, null);
    this.body.textContent = '';
    this.countPill.textContent = '';

    // Spinner only appears after SPINNER_DELAY_MS — keeps the panel calm
    // when fetches are sub-50ms (typical on small models).
    if (this.spinnerTimer) clearTimeout(this.spinnerTimer);
    this.spinnerTimer = setTimeout(() => {
      if (this.render.kind === 'fetching' && this.render.key === key) {
        this.renderSpinner();
      }
    }, SPINNER_DELAY_MS);

    this.repository
      .get(identity.modelId, identity.expressId)
      .then((props) => {
        if (this.inflightKey !== key) return; // Stale.
        // Use the enriched identity from the repository (it has ifcClass,
        // GlobalId, Name, etc.). Carry over what we had as a fallback.
        const enriched: ElementIdentity = {
          ...identity,
          ...props.identity,
        };
        const propsWithEnrichedIdentity: ElementProperties = {
          ...props,
          identity: enriched,
        };
        if (this.spinnerTimer) {
          clearTimeout(this.spinnerTimer);
          this.spinnerTimer = null;
        }
        this.render = { kind: 'loaded', props: propsWithEnrichedIdentity, key };
        this.renderHeader(enriched, propsWithEnrichedIdentity);
        this.renderBody(propsWithEnrichedIdentity);
      })
      .catch((err) => {
        if (this.inflightKey !== key) return; // Stale.
        if (this.spinnerTimer) {
          clearTimeout(this.spinnerTimer);
          this.spinnerTimer = null;
        }
        const message = err instanceof Error ? err.message : 'Failed to fetch properties';
        console.error('InspectorPanel: fetch failed', err);
        this.render = { kind: 'error', identity, message, key };
        this.renderHeader(identity, null);
        this.renderError(message);
      });
  }

  // ── Rendering ─────────────────────────────────────────────

  private show(): void {
    this.container.classList.remove('hidden');
  }

  private hide(): void {
    this.container.classList.add('hidden');
    this.render = { kind: 'hidden' };
    this.inflightKey = null;
    if (this.spinnerTimer) {
      clearTimeout(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.body.textContent = '';
    this.subhead.textContent = '';
    this.countPill.textContent = '';
    this.titleEl.textContent = '';
  }

  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.container.classList.toggle('collapsed', this.collapsed);
    this.collapseBtn.textContent = this.collapsed ? '▶' : '◀'; // ▶ / ◀
    this.collapseBtn.title = this.collapsed ? 'Expand panel' : 'Collapse panel';
  }

  private renderHeader(identity: ElementIdentity, props: ElementProperties | null): void {
    this.titleEl.textContent = titleForIdentity(identity);
    this.titleEl.title = titleForIdentity(identity);
    this.subhead.textContent = '';

    // Class · Tag row
    const classRow = document.createElement('div');
    classRow.className = 'inspector-class-row';
    const classSpan = document.createElement('span');
    classSpan.className = 'inspector-class';
    classSpan.textContent = identity.ifcClass && identity.ifcClass !== ''
      ? identity.ifcClass
      : 'Element';
    classRow.appendChild(classSpan);
    if (identity.tag) {
      const sep = document.createElement('span');
      sep.className = 'inspector-sep';
      sep.textContent = ' · ';
      classRow.appendChild(sep);
      const tagSpan = document.createElement('span');
      tagSpan.className = 'inspector-tag';
      tagSpan.textContent = `Tag ${identity.tag}`;
      classRow.appendChild(tagSpan);
    }
    this.subhead.appendChild(classRow);

    // GUID row
    if (identity.globalId) {
      const guidRow = document.createElement('div');
      guidRow.className = 'inspector-guid-row';
      const label = document.createElement('span');
      label.className = 'inspector-guid-label';
      label.textContent = 'GUID ';
      const guidBtn = document.createElement('button');
      guidBtn.className = 'inspector-guid-btn';
      guidBtn.type = 'button';
      guidBtn.textContent = truncate(identity.globalId, GUID_TRUNCATE_AT);
      guidBtn.title = `${identity.globalId} (click to copy)`;
      guidBtn.addEventListener('click', () => {
        void this.copyWithFlash(guidBtn, identity.globalId!);
      });
      guidRow.appendChild(label);
      guidRow.appendChild(guidBtn);
      this.subhead.appendChild(guidRow);
    }

    // Model name row (only if more than one model loaded)
    const modelCount = this.deps.getModelCount ? this.deps.getModelCount() : 1;
    if (modelCount > 1) {
      const info = this.deps.getModelInfo?.(identity.modelId);
      if (info?.name) {
        const modelRow = document.createElement('div');
        modelRow.className = 'inspector-model-row';
        modelRow.textContent = info.name;
        modelRow.title = info.name;
        this.subhead.appendChild(modelRow);
      }
    }

    if (props) {
      const count = totalPropertyCount(props);
      this.countPill.textContent = `${count} ${count === 1 ? 'property' : 'properties'}`;
    } else {
      this.countPill.textContent = '';
    }
  }

  private renderSpinner(): void {
    this.body.textContent = '';
    const spinner = document.createElement('div');
    spinner.className = 'inspector-spinner';
    spinner.textContent = 'Loading...';
    this.body.appendChild(spinner);
  }

  private renderError(message: string): void {
    this.body.textContent = '';
    const banner = document.createElement('div');
    banner.className = 'inspector-error';
    banner.textContent = `Couldn't load properties: ${message}`;
    this.body.appendChild(banner);
  }

  private renderMultiPlaceholder(count: number): void {
    this.show();
    this.titleEl.textContent = `${count} elements selected`;
    this.titleEl.title = `${count} elements selected`;
    this.subhead.textContent = '';
    this.countPill.textContent = '';
    this.body.textContent = '';
    const note = document.createElement('div');
    note.className = 'inspector-multi-placeholder';
    note.textContent = 'Multi-element inspection arrives in Phase 4.';
    this.body.appendChild(note);
    // Use a synthetic render tag so subsequent same-multi events skip re-render.
    this.render = {
      kind: 'loaded',
      props: {
        identity: { modelId: '__multi__', expressId: count, ifcClass: '', ifcTypeCode: 0 },
        direct: [],
        psets: [],
        qtos: [],
        materials: [],
        flat: [],
        fetchedAt: Date.now(),
      },
      key: `__multi__:${count}`,
    };
  }

  private renderBody(props: ElementProperties): void {
    this.body.textContent = '';
    if (this.view === 'tree') this.renderTree(props);
    else this.renderFlat(props);
  }

  // ── Tree view ─────────────────────────────────────────────

  private renderTree(props: ElementProperties): void {
    // Identity section (only if any identity rows exist).
    if (props.direct.length > 0) {
      this.body.appendChild(this.buildSection('Identity', props.direct.length, () => {
        const container = document.createElement('div');
        container.className = 'inspector-rows';
        for (const node of props.direct) {
          container.appendChild(this.buildPropertyRow(node, 0));
        }
        return container;
      }));
    }

    // Property Sets (each pset is itself a nested collapsible).
    if (props.psets.length > 0) {
      const header = `Property Sets`;
      const total = props.psets.reduce((n, g) => n + groupLeafCount(g), 0);
      this.body.appendChild(this.buildSection(header, total, () => {
        const container = document.createElement('div');
        container.className = 'inspector-group-list';
        for (const group of props.psets) {
          container.appendChild(this.buildGroup(group));
        }
        return container;
      }));
    }

    // Quantities
    if (props.qtos.length > 0) {
      const total = props.qtos.reduce((n, g) => n + groupLeafCount(g), 0);
      this.body.appendChild(this.buildSection('Quantities', total, () => {
        const container = document.createElement('div');
        container.className = 'inspector-group-list';
        for (const group of props.qtos) {
          container.appendChild(this.buildGroup(group));
        }
        return container;
      }));
    }

    // Materials
    if (props.materials.length > 0) {
      this.body.appendChild(this.buildSection('Materials', props.materials.length, () => {
        const container = document.createElement('div');
        container.className = 'inspector-rows';
        for (const mat of props.materials) {
          const row = document.createElement('div');
          row.className = 'inspector-row';
          const name = document.createElement('span');
          name.className = 'inspector-row-name';
          if (mat.kind === 'material-ref') {
            name.textContent = mat.materialName;
          } else {
            name.textContent = displayStringForValue(mat);
          }
          row.appendChild(name);
          container.appendChild(row);
        }
        return container;
      }));
    }

    if (this.body.childElementCount === 0) {
      const empty = document.createElement('div');
      empty.className = 'inspector-empty';
      empty.textContent = 'No properties available.';
      this.body.appendChild(empty);
    }
  }

  /** A top-level collapsible section with row-count badge. */
  private buildSection(
    title: string,
    rowCount: number,
    bodyFactory: () => HTMLElement,
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'inspector-section';
    const head = document.createElement('button');
    head.className = 'inspector-section-head';
    head.type = 'button';
    head.setAttribute('aria-expanded', 'true');
    const caret = document.createElement('span');
    caret.className = 'inspector-caret';
    caret.textContent = '▾'; // ▾
    const label = document.createElement('span');
    label.className = 'inspector-section-label';
    label.textContent = title;
    const count = document.createElement('span');
    count.className = 'inspector-section-count';
    count.textContent = String(rowCount);
    head.appendChild(caret);
    head.appendChild(label);
    head.appendChild(count);

    const body = document.createElement('div');
    body.className = 'inspector-section-body';
    body.appendChild(bodyFactory());

    head.addEventListener('click', () => {
      const expanded = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      body.style.display = expanded ? 'none' : '';
      caret.textContent = expanded ? '▸' : '▾'; // ▸ / ▾
    });

    section.appendChild(head);
    section.appendChild(body);
    return section;
  }

  /** One pset / qto group with its own collapsible header. */
  private buildGroup(group: PropertyGroup): HTMLElement {
    const node = document.createElement('div');
    node.className = 'inspector-group';

    const head = document.createElement('button');
    head.className = 'inspector-group-head';
    head.type = 'button';
    head.setAttribute('aria-expanded', 'true');
    const caret = document.createElement('span');
    caret.className = 'inspector-caret';
    caret.textContent = '▾';
    const label = document.createElement('span');
    label.className = 'inspector-group-label';
    label.textContent = group.name;
    if (group.inheritedFromType) {
      const badge = document.createElement('span');
      badge.className = 'inspector-badge';
      badge.textContent = 'from type';
      badge.title = 'Inherited from the element type';
      label.appendChild(document.createTextNode(' '));
      label.appendChild(badge);
    }
    const count = document.createElement('span');
    count.className = 'inspector-group-count';
    count.textContent = String(groupLeafCount(group));
    head.appendChild(caret);
    head.appendChild(label);
    head.appendChild(count);

    const body = document.createElement('div');
    body.className = 'inspector-group-body';
    for (const propNode of group.properties) {
      body.appendChild(this.buildPropertyRow(propNode, 0));
    }

    head.addEventListener('click', () => {
      const expanded = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      body.style.display = expanded ? 'none' : '';
      caret.textContent = expanded ? '▸' : '▾';
    });

    node.appendChild(head);
    node.appendChild(body);
    return node;
  }

  /** One `Name = Value [unit]` row, recursive for IfcComplexProperty. */
  private buildPropertyRow(node: PropertyNode, depth: number): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'inspector-row-wrapper';
    wrapper.style.paddingLeft = `${Math.min(depth, MAX_COMPLEX_DEPTH) * 12}px`;

    if (node.value.kind === 'complex') {
      const head = document.createElement('button');
      head.className = 'inspector-complex-head';
      head.type = 'button';
      head.setAttribute('aria-expanded', 'false'); // start collapsed
      const caret = document.createElement('span');
      caret.className = 'inspector-caret';
      caret.textContent = '▸';
      const name = document.createElement('span');
      name.className = 'inspector-row-name';
      name.textContent = node.key;
      const childCount = document.createElement('span');
      childCount.className = 'inspector-complex-count';
      childCount.textContent = `(${node.value.children.length})`;
      head.appendChild(caret);
      head.appendChild(name);
      head.appendChild(childCount);

      const body = document.createElement('div');
      body.className = 'inspector-complex-body';
      body.style.display = 'none';

      // Beyond MAX_COMPLEX_DEPTH, flatten children with a "…" prefix marker.
      if (depth >= MAX_COMPLEX_DEPTH) {
        for (const child of node.value.children) {
          const row = this.buildPropertyRow(child, MAX_COMPLEX_DEPTH);
          // Mark with ellipsis prefix to signal depth-flatten.
          const nameEl = row.querySelector('.inspector-row-name');
          if (nameEl && nameEl.textContent) nameEl.textContent = `… ${nameEl.textContent}`;
          body.appendChild(row);
        }
      } else {
        for (const child of node.value.children) {
          body.appendChild(this.buildPropertyRow(child, depth + 1));
        }
      }

      head.addEventListener('click', () => {
        const expanded = head.getAttribute('aria-expanded') === 'true';
        head.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        body.style.display = expanded ? 'none' : '';
        caret.textContent = expanded ? '▸' : '▾';
      });

      wrapper.appendChild(head);
      wrapper.appendChild(body);
      return wrapper;
    }

    // Leaf row
    const row = document.createElement('div');
    row.className = 'inspector-row';

    const name = document.createElement('span');
    name.className = 'inspector-row-name';
    name.textContent = node.key;
    if (node.description) name.title = node.description;

    const eq = document.createElement('span');
    eq.className = 'inspector-row-eq';
    eq.textContent = ' = ';

    const valEl = this.buildValueElement(node.value, node.unit);

    if (node.inheritedFromType) {
      const badge = document.createElement('span');
      badge.className = 'inspector-badge';
      badge.textContent = 'from type';
      row.appendChild(badge);
    }
    row.appendChild(name);
    row.appendChild(eq);
    row.appendChild(valEl);
    wrapper.appendChild(row);
    return wrapper;
  }

  /** Element containing the formatted value + optional unit pill. */
  private buildValueElement(value: PropertyValue, unit?: string): HTMLElement {
    const span = document.createElement('span');
    span.className = 'inspector-row-value';
    if (value.kind === 'varies') {
      span.classList.add('inspector-row-varies');
      span.textContent = 'varies';
      return span;
    }
    const full = displayStringForValue(value);
    span.title = `${full}${full ? ' ' : ''}(click to copy)`;
    span.textContent = truncate(full || '—', VALUE_TRUNCATE_AT);
    if (full && full.length > VALUE_TRUNCATE_AT) span.classList.add('inspector-truncated');
    span.tabIndex = 0;
    span.setAttribute('role', 'button');
    span.addEventListener('click', () => {
      if (!full) return;
      void this.copyWithFlash(span, full);
    });

    if (unit) {
      const pill = document.createElement('span');
      pill.className = 'inspector-unit-pill';
      pill.textContent = unit;
      const container = document.createElement('span');
      container.className = 'inspector-value-with-unit';
      container.appendChild(span);
      container.appendChild(pill);
      return container;
    }
    return span;
  }

  // ── Flat view ─────────────────────────────────────────────

  private renderFlat(props: ElementProperties): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'inspector-flat';

    const filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.className = 'inspector-filter';
    filterInput.placeholder = 'Filter properties…';
    filterInput.value = this.flatFilter;
    filterInput.addEventListener('input', () => {
      if (this.filterDebounce) clearTimeout(this.filterDebounce);
      this.filterDebounce = setTimeout(() => {
        this.flatFilter = filterInput.value.trim().toLowerCase();
        applyFilter();
      }, FILTER_DEBOUNCE_MS);
    });
    wrapper.appendChild(filterInput);

    const table = document.createElement('div');
    table.className = 'inspector-flat-table';
    const headerRow = document.createElement('div');
    headerRow.className = 'inspector-flat-row inspector-flat-header';
    for (const label of ['Name', 'Value', 'Unit']) {
      const cell = document.createElement('span');
      cell.className = 'inspector-flat-cell';
      cell.textContent = label;
      headerRow.appendChild(cell);
    }
    table.appendChild(headerRow);

    // Rows already sorted alphabetically by path in repository's buildFlatRows.
    const rows: HTMLElement[] = [];
    for (const r of props.flat) {
      const row = this.buildFlatRow(r);
      rows.push(row);
      table.appendChild(row);
    }
    wrapper.appendChild(table);

    if (props.flat.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'inspector-empty';
      empty.textContent = 'No properties available.';
      wrapper.appendChild(empty);
    }

    this.body.appendChild(wrapper);

    const applyFilter = (): void => {
      const q = this.flatFilter;
      for (let i = 0; i < props.flat.length; i++) {
        const match = q === '' || props.flat[i].path.toLowerCase().includes(q);
        rows[i].style.display = match ? '' : 'none';
      }
    };
    applyFilter();
  }

  private buildFlatRow(r: PropertyFlatRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'inspector-flat-row';
    row.dataset.path = r.path;

    const nameCell = document.createElement('span');
    nameCell.className = 'inspector-flat-cell inspector-flat-name';
    nameCell.textContent = r.path;
    nameCell.title = r.description ? `${r.path}\n${r.description}` : r.path;

    const valueCell = document.createElement('span');
    valueCell.className = 'inspector-flat-cell inspector-flat-value';
    if (r.rawValue.kind === 'varies') {
      valueCell.classList.add('inspector-row-varies');
      valueCell.textContent = 'varies';
    } else {
      const display = r.displayValue || '';
      const shown = display === '' ? '—' : truncate(display, VALUE_TRUNCATE_AT);
      valueCell.textContent = shown;
      if (display && display.length > VALUE_TRUNCATE_AT) {
        valueCell.classList.add('inspector-truncated');
      }
      valueCell.title = display ? `${display} (click to copy)` : '';
      valueCell.addEventListener('click', () => {
        if (!display) return;
        void this.copyWithFlash(valueCell, display);
      });
    }

    const unitCell = document.createElement('span');
    unitCell.className = 'inspector-flat-cell inspector-flat-unit';
    unitCell.textContent = r.unit ?? '';

    row.appendChild(nameCell);
    row.appendChild(valueCell);
    row.appendChild(unitCell);
    return row;
  }

  // ── Copy-to-clipboard with brief visual confirmation ──────

  private async copyWithFlash(el: HTMLElement, text: string): Promise<void> {
    const ok = await copyToClipboard(text);
    if (!ok) return;
    el.classList.add('inspector-copied');
    setTimeout(() => el.classList.remove('inspector-copied'), COPY_FLASH_MS);
  }
}
