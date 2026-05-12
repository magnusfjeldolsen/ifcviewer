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
import { intersectProperties, getDistinctValuesForPath } from './intersection';

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

/**
 * Soft cap on the number of selected elements before the panel bails out
 * of intersection rendering. Past this, body shows a "refine selection"
 * message; identity summary still renders. Exported so it's tunable from
 * tests / future config without touching the panel internals.
 */
export const MULTI_SELECT_SOFT_CAP = 1000;

/**
 * Cap on the number of distinct values listed in the varies tooltip
 * before a "+N more" suffix takes over.
 */
const VARIES_TOOLTIP_CAP = 5;

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
  | { kind: 'multi-loaded'; props: ElementProperties; key: string; identities: ElementIdentity[] }
  | { kind: 'multi-cap'; key: string; identities: ElementIdentity[] }
  | { kind: 'error'; identity: ElementIdentity; message: string; key: string };

/**
 * Build the identity-list cache key for a multi-state. Used to detect
 * "same selection re-emitted" and to discard stale multi-fetch results.
 * Order matters because the user's most-recent click trails the list,
 * and changing that order is itself a meaningful selection change.
 */
function multiKey(identities: readonly ElementIdentity[]): string {
  return identities.map((i) => `${i.modelId}:${i.expressId}`).join('|');
}

/** Listener subscription returned by onChange. */
export type Unsubscribe = () => void;

export interface SelectionSource {
  onChange(listener: (state: SelectionState) => void): Unsubscribe;
  getState(): SelectionState;
  /**
   * Phase 4 — current state of the single-model-selection lock. Optional
   * so test fixtures and Phase 2/3 callers that don't carry a lock still
   * compile. The InspectorPanel falls back to `true` (the default) when
   * the source doesn't expose it.
   */
  isSingleModelLockEnabled?: () => boolean;
  /**
   * Phase 4 — flip the single-model-selection lock. Optional for the same
   * reason as above. The checkbox is only rendered when this is present.
   */
  setSingleModelLock?: (enabled: boolean) => void;
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
  /** Vertical "Inspector" label shown only in the collapsed state. */
  private collapsedLabel: HTMLElement;
  /**
   * Phase 4 — row containing the "Single-model selection" checkbox. Only
   * shown when a selection exists *and* the selection source exposes a
   * `setSingleModelLock` setter.
   */
  private lockRow: HTMLElement;
  private lockCheckbox: HTMLInputElement;
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

  /**
   * The ElementProperties currently being rendered into the body. Used by
   * leaf-row builders to look up varies tooltips via getDistinctValuesForPath.
   * `null` while no body is rendered (hidden / fetching / over cap).
   */
  private currentProps: ElementProperties | null = null;

  constructor(parent: HTMLElement, deps: InspectorPanelDeps, selection: SelectionSource) {
    this.repository = deps.repository;
    this.deps = deps;
    this.selection = selection;
    this.view = readPersistedView();

    this.container = document.createElement('div');
    this.container.className = 'inspector-panel hidden';
    parent.appendChild(this.container);

    // Vertical "Inspector" label — only visible when the panel is collapsed.
    // Stylesheet hides it by default; `.collapsed` shows it.
    this.collapsedLabel = document.createElement('div');
    this.collapsedLabel.className = 'inspector-collapsed-label';
    this.collapsedLabel.textContent = 'Inspector';
    this.collapsedLabel.setAttribute('aria-hidden', 'true');
    this.container.appendChild(this.collapsedLabel);

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

    // Phase 4 — Single-model-selection checkbox row. Hidden when there
    // is no selection or when the SelectionSource doesn't expose a lock
    // setter (Phase 3 / test fixtures).
    this.lockRow = document.createElement('div');
    this.lockRow.className = 'inspector-lock-row hidden';
    const lockLabel = document.createElement('label');
    lockLabel.className = 'inspector-lock-label';
    this.lockCheckbox = document.createElement('input');
    this.lockCheckbox.type = 'checkbox';
    this.lockCheckbox.className = 'inspector-lock-checkbox';
    this.lockCheckbox.checked =
      this.selection.isSingleModelLockEnabled?.() ?? true;
    this.lockCheckbox.addEventListener('change', () => {
      this.selection.setSingleModelLock?.(this.lockCheckbox.checked);
    });
    const lockText = document.createElement('span');
    lockText.textContent = 'Single-model selection';
    lockLabel.appendChild(this.lockCheckbox);
    lockLabel.appendChild(lockText);
    this.lockRow.appendChild(lockLabel);
    this.header.appendChild(this.lockRow);

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
    // Re-render the body if we're in a loaded state (single OR multi).
    if (this.render.kind === 'loaded' || this.render.kind === 'multi-loaded') {
      this.renderBody(this.render.props);
    }
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
      this.beginMultiFetch(state.identities);
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

  /**
   * Phase 4 — multi-element selection path.
   *
   * Behaviour:
   *   1. Identity summary in the header renders synchronously from the
   *      identity list (no fetch needed for the count / class mix).
   *   2. If `identities.length > MULTI_SELECT_SOFT_CAP`, body shows the
   *      "Too many selected" message and we don't fetch anything.
   *   3. Otherwise, fetch all elements in parallel via repository.get.
   *      When the last fetch resolves, run `intersectProperties` and feed
   *      the synthetic result into the same Tree / Flat renderers used
   *      for single-select.
   *   4. Stale guarding: each multi-fetch tags itself with the identity-
   *      list key. If a newer selection arrives mid-flight, the older
   *      result is discarded.
   */
  private beginMultiFetch(identities: readonly ElementIdentity[]): void {
    const key = `__multi__:${multiKey(identities)}`;

    // Cheap "same multi re-emitted" guard. Selection sources sometimes
    // re-emit identical state (e.g. SelectionManager.setSingleModelLock
    // fires onChange even when nothing changes).
    if (this.render.kind !== 'hidden' && this.getCurrentKey() === key) {
      return;
    }

    this.inflightKey = key;
    if (this.spinnerTimer) {
      clearTimeout(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.show();
    this.body.textContent = '';
    this.countPill.textContent = '';
    this.renderMultiHeader(identities);

    // Soft cap.
    if (identities.length > MULTI_SELECT_SOFT_CAP) {
      this.render = { kind: 'multi-cap', key, identities: [...identities] };
      this.renderMultiCap();
      return;
    }

    // Spinner if the fetch takes longer than 50ms.
    this.spinnerTimer = setTimeout(() => {
      if (this.inflightKey === key) {
        this.renderSpinner();
      }
    }, SPINNER_DELAY_MS);

    // Per-element fetches. The repository memoizes per (modelId, expressId)
    // so repeated multi-fetches over overlapping selections are cheap.
    const fetches = identities.map((id) =>
      this.repository.get(id.modelId, id.expressId),
    );

    Promise.all(fetches)
      .then((results) => {
        if (this.inflightKey !== key) return; // Stale.
        if (this.spinnerTimer) {
          clearTimeout(this.spinnerTimer);
          this.spinnerTimer = null;
        }
        const synthetic = intersectProperties(results);
        this.render = {
          kind: 'multi-loaded',
          props: synthetic,
          key,
          identities: [...identities],
        };
        this.renderMultiHeader(identities, synthetic);
        this.renderBody(synthetic);
      })
      .catch((err) => {
        if (this.inflightKey !== key) return; // Stale.
        if (this.spinnerTimer) {
          clearTimeout(this.spinnerTimer);
          this.spinnerTimer = null;
        }
        const message = err instanceof Error ? err.message : 'Failed to fetch properties';
        console.error('InspectorPanel: multi-fetch failed', err);
        // Use the first identity as a placeholder for the error tag —
        // there's no single identity to attribute the error to, but the
        // render-tag shape requires one.
        this.render = {
          kind: 'error',
          identity: identities[0],
          message,
          key,
        };
        this.renderError(message);
      });
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
    this.refreshLockRow(/* hasSelection */ false);
  }

  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.container.classList.toggle('collapsed', this.collapsed);
    this.collapseBtn.textContent = this.collapsed ? '▶' : '◀'; // ▶ / ◀
    this.collapseBtn.title = this.collapsed ? 'Expand panel' : 'Collapse panel';
    this.collapsedLabel.setAttribute('aria-hidden', this.collapsed ? 'false' : 'true');
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

    this.refreshLockRow(/* hasSelection */ true);
  }

  /**
   * Show/hide the single-model-lock checkbox row based on whether the
   * panel currently has a selection AND the SelectionSource supports the
   * lock (i.e. exposes `setSingleModelLock`). Sync the checkbox state to
   * the source on every refresh — covers external mutations of the lock
   * via SelectionManager events.
   */
  private refreshLockRow(hasSelection: boolean): void {
    const supports = typeof this.selection.setSingleModelLock === 'function';
    if (!hasSelection || !supports) {
      this.lockRow.classList.add('hidden');
      return;
    }
    this.lockRow.classList.remove('hidden');
    this.lockCheckbox.checked =
      this.selection.isSingleModelLockEnabled?.() ?? true;
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

  /**
   * Render the multi-select header summary:
   *   - Title: "N elements selected".
   *   - Subhead: ifcClass mix (e.g. "2 IfcWall · 1 IfcDoor", or "3 IfcWall").
   *   - Single-model name row if all elements share one model and more
   *     than one model is loaded.
   *   - Count pill: "X common properties" (only once `synthetic` is supplied).
   *
   * `synthetic` is the intersection result; null while the fetch is in
   * flight or when over the soft cap (in which case the pill stays empty).
   */
  private renderMultiHeader(
    identities: readonly ElementIdentity[],
    synthetic: ElementProperties | null = null,
  ): void {
    const n = identities.length;
    this.titleEl.textContent = `${n} elements selected`;
    this.titleEl.title = `${n} elements selected`;
    this.subhead.textContent = '';

    // Class mix subhead.
    const classMix = summarizeClassMix(identities);
    const mixRow = document.createElement('div');
    mixRow.className = 'inspector-class-row inspector-multi-mix';
    const mixSpan = document.createElement('span');
    mixSpan.className = 'inspector-class';
    mixSpan.textContent = classMix;
    mixRow.appendChild(mixSpan);
    this.subhead.appendChild(mixRow);

    // Single-model row only when all share one model AND >1 models loaded.
    const firstModel = identities[0].modelId;
    const sharedModel = identities.every((i) => i.modelId === firstModel)
      ? firstModel
      : null;
    const modelCount = this.deps.getModelCount ? this.deps.getModelCount() : 1;
    if (sharedModel && modelCount > 1) {
      const info = this.deps.getModelInfo?.(sharedModel);
      if (info?.name) {
        const modelRow = document.createElement('div');
        modelRow.className = 'inspector-model-row';
        modelRow.textContent = info.name;
        modelRow.title = info.name;
        this.subhead.appendChild(modelRow);
      }
    }

    if (synthetic) {
      const count = totalPropertyCount(synthetic);
      this.countPill.textContent = `${count} common ${count === 1 ? 'property' : 'properties'}`;
    } else {
      this.countPill.textContent = '';
    }

    // Always re-evaluate the lock row visibility on every multi header pass.
    this.refreshLockRow(/* hasSelection */ true);
  }

  /**
   * Soft-cap render: show the "refine selection" message in the body.
   * The header (identity summary) stays in place.
   */
  private renderMultiCap(): void {
    this.body.textContent = '';
    const msg = document.createElement('div');
    msg.className = 'inspector-multi-cap';
    msg.textContent = 'Too many selected for inspection — refine selection';
    this.body.appendChild(msg);
  }

  private renderBody(props: ElementProperties): void {
    this.body.textContent = '';
    // Remember the currently-rendered props so leaf-row builders can look
    // up varies distinct-values (which live on a non-enumerable property
    // attached by intersectProperties — see getDistinctValuesForPath).
    this.currentProps = props;
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
          // Direct rows live at path "Identity.<key>" in the flat array.
          container.appendChild(this.buildPropertyRow(node, 0, 'Identity'));
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
      // Group properties live at path "<group.name>.<key>" in the flat array.
      body.appendChild(this.buildPropertyRow(propNode, 0, group.name));
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

  /**
   * One `Name = Value [unit]` row, recursive for IfcComplexProperty.
   *
   * `pathPrefix` is the dotted path up to (but not including) `node.key`,
   * used to reconstruct the row's flat-path for varies tooltip lookups.
   * Pass undefined to skip the path-based tooltip (e.g. for direct
   * identity rows, which never carry varies values in practice).
   */
  private buildPropertyRow(
    node: PropertyNode,
    depth: number,
    pathPrefix?: string,
  ): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'inspector-row-wrapper';
    wrapper.style.paddingLeft = `${Math.min(depth, MAX_COMPLEX_DEPTH) * 12}px`;

    const ownPath = pathPrefix ? `${pathPrefix}.${node.key}` : undefined;

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
          const row = this.buildPropertyRow(child, MAX_COMPLEX_DEPTH, ownPath);
          // Mark with ellipsis prefix to signal depth-flatten.
          const nameEl = row.querySelector('.inspector-row-name');
          if (nameEl && nameEl.textContent) nameEl.textContent = `… ${nameEl.textContent}`;
          body.appendChild(row);
        }
      } else {
        for (const child of node.value.children) {
          body.appendChild(this.buildPropertyRow(child, depth + 1, ownPath));
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

    const valEl = this.buildValueElement(node.value, node.unit, ownPath);

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
  private buildValueElement(value: PropertyValue, unit?: string, path?: string): HTMLElement {
    const span = document.createElement('span');
    span.className = 'inspector-row-value';
    if (value.kind === 'varies') {
      span.classList.add('inspector-row-varies');
      span.textContent = 'varies';
      if (path && this.currentProps) {
        span.title = this.formatVariesTooltip(path);
      }
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
      // Tooltip lists the distinct values from the intersection input.
      // Falls back to a plain label if no distinct map is available.
      if (this.currentProps) {
        valueCell.title = this.formatVariesTooltip(r.path);
      }
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

  /**
   * Build the tooltip text for a varies row at `path`. Lists up to
   * `VARIES_TOOLTIP_CAP` distinct display values, followed by "+N more"
   * if there are extras. Empty strings render as "(empty)" so the user
   * sees that a blank value is a real distinct entry.
   */
  private formatVariesTooltip(path: string): string {
    if (!this.currentProps) return 'varies';
    const distinct = getDistinctValuesForPath(this.currentProps, path);
    if (distinct.length === 0) return 'varies';
    const shown = distinct.slice(0, VARIES_TOOLTIP_CAP).map((v) => v === '' ? '(empty)' : v);
    const extra = distinct.length - VARIES_TOOLTIP_CAP;
    const lines = ['Distinct values:', ...shown.map((s) => `• ${s}`)];
    if (extra > 0) lines.push(`+${extra} more`);
    return lines.join('\n');
  }
}

/**
 * Summarize the ifcClass mix of a multi-selection for the subhead.
 *
 *   - All same class → "N IfcWall".
 *   - Mixed → "2 IfcWall · 1 IfcDoor" (sorted desc by count, then asc by name).
 */
function summarizeClassMix(identities: readonly ElementIdentity[]): string {
  const counts = new Map<string, number>();
  for (const id of identities) {
    const c = id.ifcClass && id.ifcClass !== '' ? id.ifcClass : 'Element';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  return entries.map(([cls, n]) => `${n} ${cls}`).join(' · ');
}
