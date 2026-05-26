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
 * Phase 4 adds multi-element selection with property intersection, varies
 * sentinel, and the single-model-lock checkbox in the header.
 *
 * The panel only owns DOM construction, lifecycle, and the fetch/render
 * state machine. Each of the three render flavors (single header, multi
 * header, tree body, flat body) lives in its own `panel/render*.ts`
 * module — they take pure inputs + a context object and write to slots
 * owned by the panel. See those files for rendering details.
 *
 * Spec: dev/plans/phase-element-inspector.md, "UI design" section.
 */

import type {
  ElementIdentity,
  ElementProperties,
  SelectionState,
} from './types';
import type { ElementPropertyRepository } from './repository/ElementPropertyRepository';
import { intersectProperties, getDistinctValuesForPath } from './intersection';
import {
  renderHeader as renderHeaderInto,
  renderMultiHeader as renderMultiHeaderInto,
  type HeaderRenderContext,
} from './panel/renderHeader';
import { renderTree as renderTreeInto, type TreeRenderContext } from './panel/renderTree';
import { renderFlat as renderFlatInto, type FlatRenderContext } from './panel/renderFlat';

/** Persistence key for the user's last-used view (Tree vs Flat). */
const VIEW_STORAGE_KEY = 'ifcviewer:inspectorView';

/** Delay before showing the spinner. Avoids flicker for sub-50ms fetches. */
const SPINNER_DELAY_MS = 50;

/** Truncate values longer than this in display — tooltip carries the full text. */
const VALUE_TRUNCATE_AT = 80;

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

  /** Build the context object the header renderers need. */
  private headerCtx(): HeaderRenderContext {
    return {
      titleEl: this.titleEl,
      subhead: this.subhead,
      countPill: this.countPill,
      getModelCount: () => this.deps.getModelCount?.() ?? 1,
      getModelInfo: (modelId) => this.deps.getModelInfo?.(modelId),
      copyWithFlash: (el, text) => {
        void this.copyWithFlash(el, text);
      },
      refreshLockRow: (hasSelection) => this.refreshLockRow(hasSelection),
    };
  }

  private renderHeader(identity: ElementIdentity, props: ElementProperties | null): void {
    renderHeaderInto(identity, props, this.headerCtx());
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

  private renderMultiHeader(
    identities: readonly ElementIdentity[],
    synthetic: ElementProperties | null = null,
  ): void {
    renderMultiHeaderInto(identities, synthetic, this.headerCtx());
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
    if (this.view === 'tree') {
      renderTreeInto(this.body, props, this.treeCtx());
    } else {
      renderFlatInto(this.body, props, this.flatCtx());
    }
  }

  /** Build the context object the tree renderer needs. */
  private treeCtx(): TreeRenderContext {
    return {
      valueTruncateAt: VALUE_TRUNCATE_AT,
      copyWithFlash: (el, text) => {
        void this.copyWithFlash(el, text);
      },
      formatVariesTooltip: (path) => this.formatVariesTooltip(path),
      hasCurrentProps: () => this.currentProps !== null,
    };
  }

  /** Build the context object the flat renderer needs. */
  private flatCtx(): FlatRenderContext {
    return {
      valueTruncateAt: VALUE_TRUNCATE_AT,
      copyWithFlash: (el, text) => {
        void this.copyWithFlash(el, text);
      },
      formatVariesTooltip: (path) => this.formatVariesTooltip(path),
      hasCurrentProps: () => this.currentProps !== null,
      getFlatFilter: () => this.flatFilter,
      setFlatFilter: (value) => {
        this.flatFilter = value;
      },
      getDebounceTimer: () => this.filterDebounce,
      setDebounceTimer: (handle) => {
        this.filterDebounce = handle;
      },
    };
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
