import * as THREE from 'three';
import type { Viewer } from '../viewer/Viewer';
import type { ModelManager } from '../viewer/ModelManager';
import type { ToolManager } from '../tools/Tool';
import { raycastVisible } from '../utils/raycast';
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
 *   3. Highlight all meshes that share the selected `expressID` by cloning
 *      their materials and boosting emissive to the brand blue. On deselect,
 *      restore the original material reference and dispose the clone.
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
}

/** Color and intensity for the highlight emissive boost (brand blue). */
const HIGHLIGHT_COLOR = 0x3b82f6;
const HIGHLIGHT_INTENSITY = 0.3;

/** Movement threshold (in CSS pixels) for distinguishing click vs drag. */
const CLICK_THRESHOLD = 3;

/**
 * Phase 4 — localStorage key for the single-model-selection lock preference.
 * Default is `true`: most users only want intersection within one model at
 * a time, and cross-model multi-select is an explicit opt-out via the
 * inspector header checkbox.
 */
export const SINGLE_MODEL_LOCK_STORAGE_KEY = 'ifcviewer:inspectorSingleModelLock';

/** Snapshot of one mesh's pre-highlight material for restoration on deselect. */
interface MeshHighlight {
  mesh: THREE.Mesh;
  originalMaterial: THREE.Material | THREE.Material[];
}

/** Internal key: "<modelId>:<expressId>". */
type SelectionKey = string;

function makeKey(modelId: string, expressId: number): SelectionKey {
  return `${modelId}:${expressId}`;
}

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
   * Per-mesh highlight bookkeeping. Multiple keys can share a mesh in
   * pathological cases (different expressIDs on one mesh — currently
   * impossible because we filter by `expressID === target`, but the map
   * structure is by mesh.uuid for safety and direct lookup on cleanup).
   */
  private highlights = new Map<string, MeshHighlight>();

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
   * batch references multiple `modelId`s, the batch is filtered to the
   * **first model encountered** (iterating the input array). This collapses
   * cross-model marquees while preserving in-batch order. Note: this is
   * batch-level collapse only; `setSingleModelLock(true)` does its own
   * collapse of the existing selection.
   *
   * Emits `onChange` **once** per call, regardless of how many identities
   * mutated. No-op calls (e.g. `remove` with identities none of which are
   * selected, or `replace` from empty to empty) emit nothing.
   *
   * Returns the post-call state for callers that want it synchronously.
   */
  applyMany(mode: SelectionMode, identities: readonly ElementIdentity[]): SelectionState {
    // Single-model-lock collapse: keep only the first-encountered model.
    let batch = identities;
    if (this.singleModelLock && identities.length > 0) {
      const firstModel = identities[0].modelId;
      if (identities.some((id) => id.modelId !== firstModel)) {
        batch = identities.filter((id) => id.modelId === firstModel);
      }
    }

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
    }
    return this.getState();
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

  /** Drop all selection and restore materials. No-op if nothing selected. */
  clear(): void {
    if (this.selected.size === 0) return;
    this.clearInternal();
    this.notifyChange();
  }

  /**
   * Remove any selection entries owned by the given model. Called by
   * `App.removeModel` so stale references don't survive model teardown.
   * Note: when the model's group is removed from the scene, the meshes
   * are disposed by ModelManager — we drop our highlight bookkeeping
   * here without trying to restore materials on those dead meshes.
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
    // Drop highlight entries pointing at meshes from the removed model.
    // ModelManager disposed the materials already; we just clear our refs.
    for (const [uuid, hl] of Array.from(this.highlights)) {
      const owner = hl.mesh.parent;
      if (owner && owner.name === modelId) {
        this.highlights.delete(uuid);
      }
    }

    if (this.selected.size !== before) {
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
    this.updateMouse(e);
    const hit = raycastVisible(
      this.mouse,
      this.deps.viewer.getCamera(),
      this.deps.viewer.getScene(),
      this.deps.viewer.getRenderer(),
    );

    const mode = pickMode(e);

    if (!hit || !(hit.object instanceof THREE.Mesh)) {
      // No element under cursor.
      if (mode === 'replace') {
        this.clear();
      }
      // ctrl/shift on empty → no-op (matches Phase 2 spec).
      return;
    }

    const identity = identityFromHit(hit.object);
    if (!identity) return; // Mesh isn't part of a model group (helper/marker leaked through).

    this.apply(mode, identity);
  }

  // ── Highlight lifecycle ────────────────────────────────────

  private addInternal(key: SelectionKey, identity: ElementIdentity): void {
    if (this.selected.has(key)) return;
    this.selected.add(key);
    this.identities.set(key, identity);
    this.highlightExpress(identity.modelId, identity.expressId);
  }

  private removeInternal(key: SelectionKey): void {
    if (!this.selected.has(key)) return;
    const id = this.identities.get(key);
    this.selected.delete(key);
    this.identities.delete(key);
    if (id) this.unhighlightExpress(id.modelId, id.expressId);
  }

  private clearInternal(): void {
    for (const [, hl] of this.highlights) {
      restoreMaterial(hl);
    }
    this.highlights.clear();
    this.selected.clear();
    this.identities.clear();
  }

  private highlightExpress(modelId: string, expressId: number): void {
    const model = this.deps.modelManager.getModel(modelId);
    if (!model) return;

    for (const child of model.group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      if (child.userData.expressID !== expressId) continue;
      if (this.highlights.has(child.uuid)) continue; // Already highlighted.

      const original = child.material;
      const cloned = cloneWithEmissive(original);
      child.material = cloned;
      this.highlights.set(child.uuid, { mesh: child, originalMaterial: original });
    }
  }

  private unhighlightExpress(modelId: string, expressId: number): void {
    const model = this.deps.modelManager.getModel(modelId);
    if (!model) {
      // Model already removed; just drop bookkeeping.
      return;
    }
    for (const child of model.group.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      if (child.userData.expressID !== expressId) continue;
      const hl = this.highlights.get(child.uuid);
      if (!hl) continue;
      restoreMaterial(hl);
      this.highlights.delete(child.uuid);
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private updateMouse(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private notifyChange(): void {
    const state = this.getState();
    for (const cb of this.changeListeners) cb(state);
  }
}

// ── Module-private helpers ───────────────────────────────────

/** Map a pointer event's modifier keys to a SelectionMode. */
function pickMode(e: MouseEvent): SelectionMode {
  if (e.shiftKey) return 'remove';
  if (e.ctrlKey || e.metaKey) return 'add';
  return 'replace';
}

/**
 * Turn a hit mesh into a minimal ElementIdentity. Requires the mesh to
 * carry `userData.expressID` and live under a named model group (the
 * model group's `.name` is the App UUID). Returns null for helper meshes
 * or anything not parented to a model group.
 */
function identityFromHit(mesh: THREE.Mesh): ElementIdentity | null {
  const expressId = mesh.userData.expressID;
  if (typeof expressId !== 'number') return null;
  const parent = mesh.parent;
  if (!parent || !parent.name) return null;
  return placeholderIdentity(parent.name, expressId);
}

/**
 * Clone a mesh material (or array of materials) and apply an emissive
 * boost. We always *clone* so the unhighlight path can dispose the clone
 * without touching the shared original.
 */
function cloneWithEmissive(
  material: THREE.Material | THREE.Material[],
): THREE.Material | THREE.Material[] {
  if (Array.isArray(material)) {
    return material.map((m) => cloneSingleWithEmissive(m));
  }
  return cloneSingleWithEmissive(material);
}

function cloneSingleWithEmissive(material: THREE.Material): THREE.Material {
  const clone = material.clone();
  // Three.js material types that support emissive (Phong, Standard, Lambert,
  // Physical, etc.) all expose `.emissive` as a THREE.Color. Basic materials
  // don't — we silently skip those (the clone still gets installed, just
  // without a visible emissive boost).
  if ('emissive' in clone && clone.emissive instanceof THREE.Color) {
    clone.emissive.setHex(HIGHLIGHT_COLOR);
    if ('emissiveIntensity' in clone) {
      (clone as { emissiveIntensity: number }).emissiveIntensity = HIGHLIGHT_INTENSITY;
    }
  }
  return clone;
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

/** Restore the mesh's original material and dispose the highlight clone. */
function restoreMaterial(hl: MeshHighlight): void {
  const current = hl.mesh.material;
  hl.mesh.material = hl.originalMaterial;
  // Dispose what we put on the mesh (the clone), not the original.
  if (Array.isArray(current)) {
    for (const m of current) m.dispose();
  } else {
    current.dispose();
  }
}
