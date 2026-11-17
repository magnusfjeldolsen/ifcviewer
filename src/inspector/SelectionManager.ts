import * as THREE from 'three';
import type { Viewer } from '../viewer/Viewer';
import type { ModelManager } from '../viewer/ModelManager';
import type { ToolManager } from '../tools/Tool';
import { raycastVisible } from '../utils/raycast';
import { elementOfHit } from '../viewer/ModelBatch';
import type { HistoryManager } from '../core/history/HistoryManager';
import { mementoCommand } from '../core/history/mementoCommand';
import { makeKey } from './elementKey';
import type { Candidate } from './candidateMath';
import type { ElementIdentity, SelectionMode, SelectionState } from './types';

/**
 * Phase 2 of the Element Properties Inspector.
 *
 * Responsibilities:
 *   1. Listen for left-click on the viewer canvas (click = pointerdown +
 *      pointerup with < 3px movement, same threshold as MeasurementTool).
 *   2. When no tool is active and pivot picking is off, raycast and translate
 *      the hit into a selection change with mode determined by modifier keys:
 *        - no modifier → 'replace' (or 'clear' on empty hit)
 *        - ctrl/cmd    → 'add' (toggle: deselect if already in selection)
 *        - shift       → 'remove' (no-op if not selected; no-op on empty hit)
 *   3. Highlight every piece of the selected element in the brand blue, via
 *      ModelManager's per-element highlight flag; clear it on deselect.
 *   4. Expose `clear()` and `onModelRemoved(modelId)` so App can keep the
 *      selection in sync with `removeModel` and `resetView`.
 *
 * Out of scope (later phases):
 *   - Fetching properties for an inspector panel (Phase 3).
 *   - The single-model-lock checkbox and intersection logic (Phase 4).
 *
 * Identity caveat: Phase 2 only carries `(modelId, expressId)` meaningfully.
 * The ElementIdentity shape requires `ifcClass` and `ifcTypeCode`; we fill
 * them with placeholders (`''`, 0) here and let Phase 3 populate the rest
 * from the property repository once the panel is wired in.
 */

export interface SelectionManagerDeps {
  viewer: Viewer;
  modelManager: ModelManager;
  toolManager: ToolManager;
  /** Optional override for unit-tests that don't want to spin up a real Viewer. */
  canvas?: HTMLCanvasElement;
  /**
   * Optional undo/redo history. When present, each USER-initiated selection
   * mutation (single apply, batch applyMany, recall selectExactly, user
   * clear) pushes exactly one command; SYSTEM changes (onModelRemoved
   * pruning, the lock-collapse) push none. When absent, behaviour is
   * identical to before — preserving the existing test baseline.
   */
  history?: HistoryManager;
  /**
   * Optional pick arbitration (D9). When wired, a click first asks the
   * candidate system what is under the cursor: elements outrank the
   * annotations drawn over them, so this normally answers `'element'` and the
   * click falls through to the path below unchanged. When `Tab` has cycled to
   * something else — a measurement today, a snap point later — the click is
   * handed to that provider instead and the element selection is left alone.
   *
   * Structural on purpose: `CandidateResolver` satisfies it, and so does a
   * two-method stub in a test. Absent means today's behaviour exactly, which
   * is what keeps the existing selection suite meaningful.
   */
  candidates?: {
    activeAt(clientX: number, clientY: number): Candidate | null;
    pick(candidate: Candidate, mode: SelectionMode): void;
  };
}

/** Movement threshold (in CSS pixels) for distinguishing click vs drag. */
const CLICK_THRESHOLD = 3;

/**
 * Phase 4 — localStorage key for the single-model-selection lock preference.
 * Default is `true`: most users only want intersection within one model at
 * a time, and cross-model multi-select is an explicit opt-out via the
 * inspector header checkbox.
 */
export const SINGLE_MODEL_LOCK_STORAGE_KEY = 'ifcviewer:inspectorSingleModelLock';

/** Internal key: "<modelId>:<expressId>". */
type SelectionKey = string;

function placeholderIdentity(modelId: string, expressId: number): ElementIdentity {
  // Phase 2 carries only modelId + expressId meaningfully. ifcClass /
  // ifcTypeCode get filled by Phase 3 via the property repository.
  return { modelId, expressId, ifcClass: '', ifcTypeCode: 0 };
}

export class SelectionManager {
  private deps: SelectionManagerDeps;
  private canvas: HTMLCanvasElement;
  private mouse = new THREE.Vector2();

  /**
   * Ordered set of selected element keys. Insertion order is preserved so
   * Phase 4 can do "switch to last-clicked model" when the lock toggle goes
   * on with a mixed-model selection.
   */
  private selected = new Set<SelectionKey>();

  /**
   * Identity per key. Kept in sync with `selected`. Phase 3 will enrich
   * these entries when the repository fills in ifcClass, name, globalId, etc.
   */
  private identities = new Map<SelectionKey, ElementIdentity>();

  /**
   * Cached centre of the selection's world bounds, for `getSelectionCenter`.
   * Recomputed lazily because the union runs over every selected piece, and
   * a marquee selection can hold tens of thousands of them.
   */
  private selectionCenter: THREE.Vector3 | null = null;
  private selectionCenterDirty = true;

  /** Listeners notified whenever the selection state changes. */
  private changeListeners: Array<(state: SelectionState) => void> = [];

  /**
   * Phase 4: when true, an `'add'` (ctrl+click) pick coming from a different
   * model than the existing selection collapses the existing selection and
   * starts fresh in the clicked model. Persisted to localStorage.
   */
  private singleModelLock: boolean;

  // Click-vs-drag tracking on pointerdown.
  private pointerDownPos = { x: 0, y: 0 };
  private pointerDownButton = -1;

  // Bound handlers (stable references for add/removeEventListener).
  private boundOnPointerDown: (e: PointerEvent) => void;
  private boundOnPointerUp: (e: PointerEvent) => void;

  constructor(deps: SelectionManagerDeps) {
    this.deps = deps;
    this.canvas = deps.canvas ?? deps.viewer.getCanvas();
    this.singleModelLock = readPersistedLock();
    this.boundOnPointerDown = this.onPointerDown.bind(this);
    this.boundOnPointerUp = this.onPointerUp.bind(this);
    this.canvas.addEventListener('pointerdown', this.boundOnPointerDown);
    this.canvas.addEventListener('pointerup', this.boundOnPointerUp);
  }

  // ── Public API ─────────────────────────────────────────────

  /** Current selection state, in the same shape consumed by `SelectionState`. */
  getState(): SelectionState {
    const ids = Array.from(this.selected, (k) => this.identities.get(k)!).filter(
      (id): id is ElementIdentity => id !== undefined,
    );
    if (ids.length === 0) return { kind: 'none' };
    if (ids.length === 1) return { kind: 'single', identities: [ids[0]] };
    // Multi: if the lock is on and all selected elements share one model,
    // surface that as lockedModelId for downstream consumers (the
    // InspectorPanel uses it to label the header). If the lock is off
    // we still report a single-model selection's lockedModelId because
    // the inspector header benefits from knowing the lone model id.
    const firstModel = ids[0].modelId;
    const sameModel = ids.every((id) => id.modelId === firstModel);
    return {
      kind: 'multi',
      identities: ids,
      lockedModelId: sameModel ? firstModel : undefined,
    };
  }

  /**
   * Centre of the current selection's world bounding box, or null when
   * nothing is selected (or nothing selected is currently loaded).
   *
   * The viewer uses this as a fallback orbit pivot when the cursor is over
   * empty space — with something selected, that is almost always what the
   * user means to turn around.
   */
  getSelectionCenter(): THREE.Vector3 | null {
    if (this.selectionCenterDirty) {
      this.selectionCenterDirty = false;
      this.selectionCenter = this.computeSelectionCenter();
    }
    return this.selectionCenter ? this.selectionCenter.clone() : null;
  }

  private computeSelectionCenter(): THREE.Vector3 | null {
    if (this.selected.size === 0) return null;
    const bounds = this.deps.modelManager.getElementsBoundingBox(this.identities.values());
    return bounds.isEmpty() ? null : bounds.getCenter(new THREE.Vector3());
  }

  /** Phase 4 — current single-model-lock state (for the inspector checkbox). */
  isSingleModelLockEnabled(): boolean {
    return this.singleModelLock;
  }

  /**
   * Phase 4 — toggle the single-model-lock state. Persists to localStorage
   * and emits onChange so the panel's checkbox stays in sync. When the
   * lock turns on with a mixed-model selection active, the selection
   * collapses to the most-recently-clicked model's elements (preserving
   * insertion order from the Set). This is the documented Phase 4 spec.
   */
  setSingleModelLock(enabled: boolean): void {
    if (this.singleModelLock === enabled) return;
    this.singleModelLock = enabled;
    writePersistedLock(enabled);

    let mutated = false;
    if (enabled && this.selected.size > 0) {
      // Determine the most-recently-clicked model. Sets in JS preserve
      // insertion order, so the last entry's model is the one to keep.
      const keys = Array.from(this.selected);
      const lastKey = keys[keys.length - 1];
      const lastId = this.identities.get(lastKey);
      if (lastId) {
        const keepModel = lastId.modelId;
        for (const key of keys) {
          const id = this.identities.get(key);
          if (!id) continue;
          if (id.modelId !== keepModel) {
            this.removeInternal(key);
            mutated = true;
          }
        }
      }
    }

    // Always notify so the checkbox UI re-renders, even when nothing in
    // the selection changed. (Listeners can choose to ignore identical
    // state via shallow equality.)
    if (mutated || this.selected.size === 0) {
      this.notifyChange();
    } else {
      // No element drops but consumers still need to know the flag changed
      // (e.g. to refresh the checkbox). Re-emit current state.
      this.notifyChange();
    }
  }

  /** Subscribe to selection-state changes. Returns an unsubscribe callback. */
  onChange(listener: (state: SelectionState) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  /**
   * Apply a selection change for the given identity. Public so tests and
   * future features (e.g. selection-from-tree-panel) can drive selection
   * without going through a canvas click. Returns the new state.
   */
  apply(mode: SelectionMode, identity: ElementIdentity): SelectionState {
    const key = makeKey(identity.modelId, identity.expressId);
    const before = this.snapshotSelection();

    if (mode === 'replace') {
      if (this.selected.size === 1 && this.selected.has(key)) {
        // Same element re-picked: no-op (preserves identity and highlight).
        return this.getState();
      }
      this.clearInternal();
      this.addInternal(key, identity);
    } else if (mode === 'add') {
      // Phase 4 single-model lock: ctrl+click in a *different* model
      // clears the existing selection and restarts in the new model.
      // When the lock is off or the new pick is in the same model, the
      // original Phase 2 toggle/add behaviour applies.
      if (this.singleModelLock && this.selected.size > 0) {
        const existingModel = this.firstSelectedModelId();
        if (existingModel !== null && existingModel !== identity.modelId) {
          // Cross-model ctrl+click while locked → behave as replace.
          this.clearInternal();
          this.addInternal(key, identity);
          this.notifyChange();
          this.recordCommand('Change selection', before);
          return this.getState();
        }
      }
      if (this.selected.has(key)) {
        this.removeInternal(key);
      } else {
        this.addInternal(key, identity);
      }
    } else {
      // 'remove'
      if (this.selected.has(key)) {
        this.removeInternal(key);
      }
      // else: no-op (shift+click on unselected does nothing)
    }

    this.notifyChange();
    this.recordCommand('Change selection', before);
    return this.getState();
  }

  /**
   * Batch variant of `apply` used by Alt-drag marquee selection.
   *
   * Semantics:
   *   - `replace` with [] → clear and notify (if anything was selected).
   *   - `replace` with N → clear, then add each (dedup within batch).
   *   - `add` with N → for each: if not in selection, add. **Never toggles**
   *     (CAD-standard batch behavior; differs from `apply('add', …)`).
   *   - `remove` with N → for each: if in selection, remove.
   *
   * Single-model-lock collapse: when `singleModelLock === true` and the
   * batch references multiple `modelId`s, the batch is filtered to a
   * single "locked" model.
   *   - For `add`/`remove`: the locked model is the **existing selection's
   *     model** (preserves user intent — they can keep building selection
   *     in their current model regardless of marquee iteration order).
   *     Falls back to the first identity in the batch if the selection is
   *     empty.
   *   - For `replace`: the existing selection is being cleared anyway, so
   *     the locked model is the **first identity in the batch**.
   * Note: this is batch-level collapse only; `setSingleModelLock(true)`
   * does its own collapse of the existing selection.
   *
   * Emits `onChange` **once** per call, regardless of how many identities
   * mutated. No-op calls (e.g. `remove` with identities none of which are
   * selected, or `replace` from empty to empty) emit nothing.
   *
   * Returns the post-call state for callers that want it synchronously.
   */
  applyMany(mode: SelectionMode, identities: readonly ElementIdentity[]): SelectionState {
    // Single-model-lock collapse:
    //   - For add/remove, preserve the existing selection's model so the
    //     user's locked context wins regardless of marquee iteration order.
    //   - For replace, the selection is cleared anyway → use batch[0].
    let batch = identities;
    if (this.singleModelLock && identities.length > 0) {
      const existingModel = mode !== 'replace' ? this.firstSelectedModelId() : null;
      const lockedModel = existingModel ?? identities[0].modelId;
      if (identities.some((id) => id.modelId !== lockedModel)) {
        batch = identities.filter((id) => id.modelId === lockedModel);
      }
    }

    const before = this.snapshotSelection();
    let mutated = false;
    const seen = new Set<SelectionKey>();

    if (mode === 'replace') {
      // Clear existing selection first.
      if (this.selected.size > 0) {
        this.clearInternal();
        mutated = true;
      }
      for (const id of batch) {
        const key = makeKey(id.modelId, id.expressId);
        if (seen.has(key)) continue; // Dedup within the batch.
        seen.add(key);
        this.addInternal(key, id);
        mutated = true;
      }
    } else if (mode === 'add') {
      for (const id of batch) {
        const key = makeKey(id.modelId, id.expressId);
        if (seen.has(key)) continue; // Dedup within the batch.
        seen.add(key);
        if (this.selected.has(key)) continue; // Never toggles.
        this.addInternal(key, id);
        mutated = true;
      }
    } else {
      // 'remove'
      for (const id of batch) {
        const key = makeKey(id.modelId, id.expressId);
        if (seen.has(key)) continue; // Dedup within the batch.
        seen.add(key);
        if (!this.selected.has(key)) continue; // No-op on unselected.
        this.removeInternal(key);
        mutated = true;
      }
    }

    if (mutated) {
      this.notifyChange();
      this.recordCommand('Change selection', before);
    }
    return this.getState();
  }

  /**
   * Select EXACTLY the given identities, replacing whatever is selected —
   * **bypassing the single-model lock**. Unlike `applyMany('replace', …)`,
   * which collapses a cross-model batch to one model when the lock is on,
   * this selects every identity across every model regardless of the lock,
   * and crucially does NOT mutate the persisted lock preference.
   *
   * This is the recall path for the Selection Basket (MR): the basket can
   * span models, and recalling it must highlight all of its contents without
   * silently changing the user's "Single-model selection" setting. (See
   * dev/plans/handoff-selection-basket.md, edge case "MR vs the
   * single-model-lock".)
   *
   * Semantics:
   *   - Clears the current selection (replace).
   *   - Adds each identity, deduped within the batch.
   *   - Empty input → clears (returns to none).
   *   - Emits onChange once iff anything changed.
   *
   * Returns the post-call state.
   */
  selectExactly(identities: readonly ElementIdentity[]): SelectionState {
    const before = this.snapshotSelection();
    const mutated = this.setExactlyInternal(identities);
    if (mutated) {
      this.notifyChange();
      this.recordCommand('Recall selection', before);
    }
    return this.getState();
  }

  /**
   * Core "select exactly these identities" mutation, bypassing the
   * single-model lock and WITHOUT notifying or recording. Returns whether
   * anything changed. Shared by the public `selectExactly` (which notifies +
   * records) and the undo/redo `restoreSelection` path (which notifies but is
   * guarded against recording by `history.isApplying()`).
   */
  private setExactlyInternal(identities: readonly ElementIdentity[]): boolean {
    let mutated = false;
    const seen = new Set<SelectionKey>();

    if (this.selected.size > 0) {
      this.clearInternal();
      mutated = true;
    }

    for (const id of identities) {
      const key = makeKey(id.modelId, id.expressId);
      if (seen.has(key)) continue; // Dedup within the batch.
      seen.add(key);
      this.addInternal(key, id);
      mutated = true;
    }

    return mutated;
  }

  /**
   * Return the modelId of the first selected element, or null if the
   * selection is empty. Used by the single-model-lock check in `apply`.
   */
  private firstSelectedModelId(): string | null {
    for (const key of this.selected) {
      const id = this.identities.get(key);
      if (id) return id.modelId;
    }
    return null;
  }

  // ── Undo / redo plumbing ────────────────────────────────────

  /**
   * Capture the current selection as an insertion-ordered identity list — the
   * memento `before`/`after` for an undo command. A fresh array each call, so
   * the command can hold it without aliasing live state.
   */
  private snapshotSelection(): readonly ElementIdentity[] {
    return Array.from(this.selected, (k) => this.identities.get(k)!).filter(
      (id): id is ElementIdentity => id !== undefined,
    );
  }

  /**
   * Restore the selection to exactly the given identities (undo/redo apply).
   * Bypasses the single-model lock — a cross-model selection must restore
   * faithfully without mutating the user's lock preference — and notifies so
   * the panel/highlight update. Recording is suppressed because the
   * HistoryManager has `isApplying()` true while this runs.
   */
  private restoreSelection(identities: readonly ElementIdentity[]): void {
    const mutated = this.setExactlyInternal(identities);
    if (mutated) this.notifyChange();
  }

  /**
   * Push one undo command capturing the transition from `before` to the
   * current selection. No-op when:
   *   - there's no history dep,
   *   - a command is already re-applying (the `isApplying()` guard — the
   *     single most important correctness rule: an undo's restore must NOT
   *     push a fresh command), or
   *   - the selection didn't actually change (so a shift+click on an
   *     unselected element, or a same-element re-pick, records nothing even
   *     though the public method still notifies as before).
   * Call only AFTER the mutation + notifyChange.
   */
  private recordCommand(label: string, before: readonly ElementIdentity[]): void {
    const history = this.deps.history;
    if (!history || history.isApplying()) return;
    const after = this.snapshotSelection();
    if (sameSelection(before, after)) return;
    history.push(
      mementoCommand(label, before, after, (ids) => this.restoreSelection(ids)),
    );
  }

  /** Drop all selection and its highlight. No-op if nothing selected. */
  clear(): void {
    if (this.selected.size === 0) return;
    const before = this.snapshotSelection();
    this.clearInternal();
    this.notifyChange();
    this.recordCommand('Clear selection', before);
  }

  /**
   * Remove any selection entries owned by the given model. Called by
   * `App.removeModel` so stale references don't survive model teardown.
   * The model's geometry (and with it the highlight) goes with the model,
   * so this only drops bookkeeping.
   */
  onModelRemoved(modelId: string): void {
    const before = this.selected.size;
    const prefix = `${modelId}:`;

    for (const key of Array.from(this.selected)) {
      if (key.startsWith(prefix)) {
        this.selected.delete(key);
        this.identities.delete(key);
      }
    }

    if (this.selected.size !== before) {
      this.selectionCenterDirty = true;
      this.notifyChange();
    }
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.boundOnPointerDown);
    this.canvas.removeEventListener('pointerup', this.boundOnPointerUp);
    this.clearInternal();
    this.changeListeners = [];
  }

  // ── Pointer handling ───────────────────────────────────────

  private onPointerDown(e: PointerEvent): void {
    // Track left-button position so onPointerUp can decide click-vs-drag.
    if (e.button === 0) {
      this.pointerDownPos = { x: e.clientX, y: e.clientY };
      this.pointerDownButton = 0;
    } else {
      this.pointerDownButton = e.button;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button !== 0 || this.pointerDownButton !== 0) {
      this.pointerDownButton = -1;
      return;
    }
    this.pointerDownButton = -1;

    // Tool/pivot ownership: bail without consuming the click.
    if (this.deps.toolManager.getActiveTool() !== null) return;
    if (this.deps.viewer.isPivotPicking()) return;

    // Click vs drag.
    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    if (Math.hypot(dx, dy) >= CLICK_THRESHOLD) return;

    this.handleClick(e);
  }

  private handleClick(e: PointerEvent): void {
    // Pick arbitration (D9). Elements rank above everything drawn on top of
    // them, so this only diverts the click when the user has cycled past the
    // element with `Tab` — or when there is no element under the cursor at all
    // and only an annotation is there.
    const candidates = this.deps.candidates;
    if (candidates) {
      const active = candidates.activeAt(e.clientX, e.clientY);
      if (active && active.kind !== 'element') {
        // Same modifier reading the element path uses, so Ctrl+click means
        // "add to the selection" whichever kind of thing is under the cursor.
        candidates.pick(active, pickMode(e));
        return;
      }
    }

    this.updateMouse(e);
    const hit = raycastVisible(
      this.mouse,
      this.deps.viewer.getCamera(),
      this.deps.viewer.getScene(),
      this.deps.viewer.getRenderer(),
    );

    const mode = pickMode(e);

    if (!hit) {
      // No element under cursor.
      if (mode === 'replace') {
        this.clear();
      }
      // ctrl/shift on empty → no-op (matches Phase 2 spec).
      return;
    }

    const element = elementOfHit(hit);
    if (!element) return; // Not a model piece (helper/marker leaked through).

    this.apply(mode, placeholderIdentity(element.modelId, element.expressId));
  }

  // ── Highlight lifecycle ────────────────────────────────────

  private addInternal(key: SelectionKey, identity: ElementIdentity): void {
    if (this.selected.has(key)) return;
    this.selected.add(key);
    this.identities.set(key, identity);
    this.selectionCenterDirty = true;
    this.highlightExpress(identity.modelId, identity.expressId);
  }

  private removeInternal(key: SelectionKey): void {
    if (!this.selected.has(key)) return;
    const id = this.identities.get(key);
    this.selected.delete(key);
    this.identities.delete(key);
    this.selectionCenterDirty = true;
    if (id) this.unhighlightExpress(id.modelId, id.expressId);
  }

  private clearInternal(): void {
    // One call per model, however many elements were selected.
    const byModel = new Map<string, number[]>();
    for (const id of this.identities.values()) {
      let list = byModel.get(id.modelId);
      if (!list) byModel.set(id.modelId, (list = []));
      list.push(id.expressId);
    }
    for (const [modelId, ids] of byModel) this.deps.modelManager.setHighlighted(modelId, ids, false);
    this.selected.clear();
    this.identities.clear();
    this.selectionCenterDirty = true;
  }

  /**
   * The highlight is a per-element flag in the renderer, independent of the
   * element's colour, opacity and visibility, so it composes on top of
   * whatever AppearanceManager has set (a transparent element shows faded and
   * highlighted) and needs no reconciliation when that changes.
   */
  private highlightExpress(modelId: string, expressId: number): void {
    this.deps.modelManager.setHighlighted(modelId, [expressId], true);
  }

  private unhighlightExpress(modelId: string, expressId: number): void {
    this.deps.modelManager.setHighlighted(modelId, [expressId], false);
  }

  // ── Helpers ────────────────────────────────────────────────

  private updateMouse(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private notifyChange(): void {
    // Highlight + unhighlight only change per-element state — the camera
    // doesn't move, so OrbitControls won't fire 'change' to wake the render
    // loop. Trigger it here so the highlight is drawn.
    this.deps.viewer.requestRender();
    const state = this.getState();
    for (const cb of this.changeListeners) cb(state);
  }
}

// ── Module-private helpers ───────────────────────────────────

/**
 * Order-insensitive equality of two selection snapshots by their
 * `modelId:expressId` keys. Used to skip recording an undo command when a
 * "mutation" left the selection unchanged (shift+click on an unselected
 * element, same-element re-pick, etc.).
 */
function sameSelection(
  a: readonly ElementIdentity[],
  b: readonly ElementIdentity[],
): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map((id) => makeKey(id.modelId, id.expressId)));
  for (const id of b) {
    if (!keys.has(makeKey(id.modelId, id.expressId))) return false;
  }
  return true;
}

/** Map a pointer event's modifier keys to a SelectionMode. */
function pickMode(e: MouseEvent): SelectionMode {
  if (e.shiftKey) return 'remove';
  if (e.ctrlKey || e.metaKey) return 'add';
  return 'replace';
}

/**
 * Read the persisted single-model-lock flag.
 * Default: `true` (Phase 4 spec — most users want one-model intersection).
 */
function readPersistedLock(): boolean {
  try {
    const v = window.localStorage?.getItem(SINGLE_MODEL_LOCK_STORAGE_KEY);
    if (v === null || v === undefined) return true;
    return v === 'true';
  } catch {
    return true;
  }
}

function writePersistedLock(enabled: boolean): void {
  try {
    window.localStorage?.setItem(SINGLE_MODEL_LOCK_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    /* ignore — storage may be disabled */
  }
}
