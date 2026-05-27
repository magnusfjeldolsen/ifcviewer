import * as THREE from 'three';
import type { ModelManager } from './ModelManager';
import type { HistoryManager } from '../core/history/HistoryManager';
import { mementoCommand } from '../core/history/mementoCommand';
import type { Scope } from '../inspector/types';

/**
 * Element appearance — per-element visibility + transparency overrides.
 *
 * One manager, ONE state per element (decision A4): `'hidden' | 'transparent'`,
 * absent ⇒ `'normal'`. A new op OVERRIDES the current one — there is no
 * combined transparent+hidden. The manager normalize-then-applies: before
 * applying any new state it fully restores the element to base (pristine
 * material reference + `visible = true`), THEN applies the new state. That one
 * rule makes every transition robust (transparent→hidden→normal, etc.) with no
 * leaked transparency-variant materials.
 *
 *   priority:  hidden  >  transparent  >  (base)      and highlight composes on top
 *
 * - **hidden** → `mesh.visible = false`.
 * - **transparent** → swap to a transparent material clone {transparent:true,
 *   opacity:0.25}, derived from the PRISTINE original (never from "whatever is
 *   currently on the mesh", so an already-highlighted mesh doesn't capture its
 *   highlight variant as base — see the interplay note below).
 * - **normal** → restore the pristine original material + `visible = true`.
 *
 * ## Shared-material safety (the highlight-variant trick)
 * Materials are shared by color within a model (ModelManager materialCache), so
 * we cannot set `material.opacity` directly — it would fade every same-colored
 * element. SelectionManager already solves this for highlighting via a per-mesh
 * material clone cached in a WeakMap keyed by the original; transparency mirrors
 * that as `transparencyVariants`. Two meshes that share a pristine material
 * share their transparent clone.
 *
 * ## Highlight ↔ appearance interplay (App-orchestrated)
 * App owns the precedence chain `hidden > transparent > highlighted > base`. To
 * keep this order-independent, AppearanceManager derives its base from the
 * PRISTINE original (via `pristineFor`, a write-once store shared with App /
 * SelectionManager). `getBaseForMesh(mesh, pristine)` returns the material the
 * highlight should compose on top of: the transparent clone if the element is
 * transparent, else the pristine original. After any appearance op touching
 * selected meshes, App calls `selectionManager.refreshHighlights()`.
 *
 * ## Undo (decision: each op is ONE undoable command)
 * Optional `history` dep mirrors SelectionManager / SelectionBasket: each USER
 * op (hide / isolate / show-all / transparent / opaque) pushes exactly one
 * `mementoCommand(before, after, restore)` whose memento is the serialized
 * state. SYSTEM changes (onModelRemoved prune, deserialize session restore)
 * push none, guarded by `history.isApplying()`.
 *
 * See dev/plans/handoff-element-appearance.md.
 */

/** Per-element appearance state. Absence in the map ⇒ 'normal'. */
export type AppearanceState = 'hidden' | 'transparent';

/** Opacity for the transparent state (A3 — clearly see-through but visible). */
export const TRANSPARENCY_OPACITY = 0.25;

/** Serialized appearance entry — the cheap session-persistence shape. */
export interface AppearanceEntry {
  modelId: string;
  expressId: number;
  state: AppearanceState;
}

export interface AppearanceManagerDeps {
  modelManager: ModelManager;
  /** Render-on-demand hook (appearance mutates without moving the camera). */
  requestRender?: () => void;
  /**
   * Optional undo/redo history. When present, each USER op pushes exactly one
   * command; SYSTEM changes (prune, deserialize) push none. When absent,
   * behaviour is identical minus the recording — preserving simple usage.
   */
  history?: HistoryManager;
  /**
   * Optional pristine-material provider. Returns the mesh's load-time material,
   * captured write-once in a store SHARED with App / SelectionManager so the
   * base is the true pristine regardless of which subsystem touched the mesh
   * first. When omitted, the manager captures `mesh.material` once internally
   * (correct for standalone use where nothing else mutates the mesh).
   */
  pristineFor?: (mesh: THREE.Mesh) => THREE.Material | THREE.Material[];
}

/** Internal key: "<modelId>:<expressId>" (same scheme as SelectionManager). */
type AppearanceKey = string;

function makeKey(modelId: string, expressId: number): AppearanceKey {
  return `${modelId}:${expressId}`;
}

export class AppearanceManager {
  private deps: AppearanceManagerDeps;

  /** Element → state. Absent ⇒ 'normal'. */
  private states = new Map<AppearanceKey, AppearanceState>();

  /**
   * Cache: pristine original material → shared transparent clone. Mirrors
   * SelectionManager.highlightVariants. Two meshes that share a pristine
   * material share the same transparent clone. NEVER dispose a variant on
   * restore — it may still be in use by another transparent mesh, and a future
   * re-transparent must reuse it. Releases when the original is GC'd.
   */
  private transparencyVariants = new WeakMap<THREE.Material, THREE.Material>();

  /**
   * Fallback pristine store used only when `deps.pristineFor` is absent.
   * Write-once per mesh so the first capture is the true load-time material.
   */
  private ownPristine = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();

  /** Listeners notified whenever appearance state changes. */
  private changeListeners: Array<() => void> = [];

  constructor(deps: AppearanceManagerDeps) {
    this.deps = deps;
  }

  // ── Queries ────────────────────────────────────────────────

  /** Current appearance state for an element ('normal' when absent). */
  getStateFor(modelId: string, expressId: number): 'normal' | AppearanceState {
    return this.states.get(makeKey(modelId, expressId)) ?? 'normal';
  }

  /** True if any element is hidden (drives the tray "Show N hidden"). */
  hasHidden(): boolean {
    for (const s of this.states.values()) if (s === 'hidden') return true;
    return false;
  }

  /** Count of currently-hidden elements (for the tray label). */
  hiddenCount(): number {
    let n = 0;
    for (const s of this.states.values()) if (s === 'hidden') n++;
    return n;
  }

  /** True if any element is transparent (drives the tray "Clear transparency"). */
  hasTransparent(): boolean {
    for (const s of this.states.values()) if (s === 'transparent') return true;
    return false;
  }

  /**
   * The material the highlight should compose on top of for this mesh: the
   * transparent clone if the element is transparent, else the pristine
   * original. Consumed by SelectionManager via the `appearanceBaseFor` provider
   * so the highlight derives from the appearance base, not a stale material.
   *
   * `pristine` is passed in (App's shared write-once store) so this is purely a
   * function of pristine + recorded state — order-independent.
   */
  getBaseForMesh(
    mesh: THREE.Mesh,
    pristine: THREE.Material | THREE.Material[],
  ): THREE.Material | THREE.Material[] {
    const expressId = mesh.userData.expressID;
    const modelId = mesh.parent?.name;
    if (typeof expressId === 'number' && modelId) {
      const state = this.states.get(makeKey(modelId, expressId));
      if (state === 'transparent') return this.getTransparencyVariant(pristine);
    }
    return pristine;
  }

  // ── User ops (each = one undoable command) ──────────────────

  /** Hide every element in the scope. Overrides any prior state. */
  hide(scope: Scope): void {
    this.runOp((key) => this.states.set(key, 'hidden'), scope, 'Hide elements');
  }

  /**
   * Hide everything NOT in the scope; set scope elements to normal. The
   * most-used BIM verb. Recorded as ONE command, so undo restores the prior
   * per-element visibility (already-hidden elements stay hidden) in one step.
   * v1: scope = selection only (A5).
   */
  isolate(scope: Scope): void {
    const before = this.serialize();
    const keep = new Set(scope.map((id) => makeKey(id.modelId, id.expressId)));
    let mutated = false;

    for (const entry of this.deps.modelManager.getAllModels()) {
      for (const expressId of entry.meshesByExpressId.keys()) {
        const key = makeKey(entry.id, expressId);
        if (keep.has(key)) {
          // Scope element → normal/visible.
          if (this.states.get(key) !== undefined) {
            this.clearState(key);
            mutated = true;
          }
        } else {
          // Complement → hidden.
          if (this.states.get(key) !== 'hidden') {
            this.setState(key, 'hidden');
            mutated = true;
          }
        }
      }
    }

    this.finishOp(mutated, before, 'Isolate elements');
  }

  /** Clear all hidden state (restore visibility). Leaves transparency intact. */
  showAll(): void {
    const before = this.serialize();
    let mutated = false;
    for (const [key, state] of Array.from(this.states)) {
      if (state === 'hidden') {
        this.clearState(key);
        mutated = true;
      }
    }
    this.finishOp(mutated, before, 'Show all');
  }

  /** Make every element in the scope transparent. Overrides any prior state. */
  transparent(scope: Scope): void {
    this.runOp((key) => this.states.set(key, 'transparent'), scope, 'Make transparent');
  }

  /** Make every element in the scope opaque (clear transparent state → normal). */
  opaque(scope: Scope): void {
    const before = this.serialize();
    let mutated = false;
    for (const id of scope) {
      const key = makeKey(id.modelId, id.expressId);
      if (this.states.get(key) === 'transparent') {
        this.clearState(key);
        mutated = true;
      }
    }
    this.finishOp(mutated, before, 'Make opaque');
  }

  /** Clear all transparent state (the tray recovery action). */
  clearTransparency(): void {
    const before = this.serialize();
    let mutated = false;
    for (const [key, state] of Array.from(this.states)) {
      if (state === 'transparent') {
        this.clearState(key);
        mutated = true;
      }
    }
    this.finishOp(mutated, before, 'Clear transparency');
  }

  // ── Persistence ────────────────────────────────────────────

  /** Serialize to the session shape ({modelId, expressId, state}[]). */
  serialize(): AppearanceEntry[] {
    const out: AppearanceEntry[] = [];
    for (const [key, state] of this.states) {
      const idx = key.indexOf(':');
      out.push({
        modelId: key.slice(0, idx),
        expressId: Number(key.slice(idx + 1)),
        state,
      });
    }
    return out;
  }

  /**
   * Rehydrate the state map AND re-apply the visual effect for live models
   * (session restore). A SYSTEM change — pushes no undo command. Entries whose
   * model isn't loaded still record state (harmless) but apply no mesh effect.
   */
  deserialize(entries: readonly AppearanceEntry[]): void {
    for (const { modelId, expressId, state } of entries) {
      const key = makeKey(modelId, expressId);
      this.setState(key, state);
    }
    if (entries.length > 0) this.notifyChange();
  }

  /**
   * Drop every entry owned by the given model (model removal). Delimiter-aware
   * prefix check so "m1" doesn't also prune "m1-2". A SYSTEM change — fires
   * onChange iff something was pruned, pushes no undo command. We do NOT touch
   * meshes (ModelManager disposed them); just drop bookkeeping.
   */
  onModelRemoved(modelId: string): void {
    const prefix = `${modelId}:`;
    let mutated = false;
    for (const key of Array.from(this.states.keys())) {
      if (key.startsWith(prefix)) {
        this.states.delete(key);
        mutated = true;
      }
    }
    if (mutated) this.notifyChange();
  }

  // ── Observer ───────────────────────────────────────────────

  /** Subscribe to appearance-state changes. Returns an unsubscribe callback. */
  onChange(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  // ── Internals ──────────────────────────────────────────────

  /**
   * Run a simple per-scope op: set/clear the state for each scope element via
   * `mutate`, applying the visual effect, recording one command iff anything
   * actually changed.
   */
  private runOp(
    mutate: (key: AppearanceKey, id: { modelId: string; expressId: number }) => void,
    scope: Scope,
    label: string,
  ): void {
    const before = this.serialize();
    let mutated = false;
    for (const id of scope) {
      const key = makeKey(id.modelId, id.expressId);
      const target = label === 'Hide elements' ? 'hidden' : 'transparent';
      if (this.states.get(key) === target) continue; // no-op for this element
      mutate(key, id);
      this.applyToMeshes(id.modelId, id.expressId);
      mutated = true;
    }
    this.finishOp(mutated, before, label);
  }

  /** Record state without applying the effect (used by deserialize too). */
  private setState(key: AppearanceKey, state: AppearanceState): void {
    this.states.set(key, state);
    const idx = key.indexOf(':');
    this.applyToMeshes(key.slice(0, idx), Number(key.slice(idx + 1)));
  }

  /** Clear state (→ normal) and restore the meshes to base. */
  private clearState(key: AppearanceKey): void {
    this.states.delete(key);
    const idx = key.indexOf(':');
    this.applyToMeshes(key.slice(0, idx), Number(key.slice(idx + 1)));
  }

  /**
   * Apply the current recorded state to every mesh of an element, using the
   * normalize-then-apply rule: first restore pristine material + visible=true,
   * then apply hidden/transparent. One code path → robust transitions.
   */
  private applyToMeshes(modelId: string, expressId: number): void {
    const model = this.deps.modelManager.getModel(modelId);
    if (!model) return; // model not live (e.g. deserialize before load)
    const meshes = model.meshesByExpressId.get(expressId);
    if (!meshes) return;

    const state = this.states.get(makeKey(modelId, expressId));
    for (const mesh of meshes) {
      const pristine = this.pristineOf(mesh);
      // Normalize to base.
      mesh.material = pristine;
      mesh.visible = true;
      // Apply the new state.
      if (state === 'hidden') {
        mesh.visible = false;
      } else if (state === 'transparent') {
        mesh.material = this.getTransparencyVariant(pristine);
      }
    }
    this.deps.requestRender?.();
  }

  /** Pristine material for a mesh — injected store, else internal write-once. */
  private pristineOf(mesh: THREE.Mesh): THREE.Material | THREE.Material[] {
    if (this.deps.pristineFor) return this.deps.pristineFor(mesh);
    let p = this.ownPristine.get(mesh);
    if (!p) {
      p = mesh.material;
      this.ownPristine.set(mesh, p);
    }
    return p;
  }

  /**
   * Return a (possibly cached) transparent variant of the pristine material.
   * Two meshes sharing a pristine material share the SAME variant reference.
   */
  private getTransparencyVariant(
    pristine: THREE.Material | THREE.Material[],
  ): THREE.Material | THREE.Material[] {
    if (Array.isArray(pristine)) {
      return pristine.map((m) => this.getOrBuildVariant(m));
    }
    return this.getOrBuildVariant(pristine);
  }

  private getOrBuildVariant(original: THREE.Material): THREE.Material {
    let variant = this.transparencyVariants.get(original);
    if (!variant) {
      variant = original.clone();
      variant.transparent = true;
      variant.opacity = TRANSPARENCY_OPACITY;
      variant.depthWrite = false; // avoid see-through artifacts on overlapping faces
      this.transparencyVariants.set(original, variant);
    }
    return variant;
  }

  /** Finish an op: notify + record one command iff anything changed. */
  private finishOp(mutated: boolean, before: AppearanceEntry[], label: string): void {
    if (!mutated) return;
    this.notifyChange();
    this.recordCommand(label, before);
  }

  /**
   * Push one undo command capturing before→current serialized state. No-op when
   * there's no history dep or while a command is re-applying (the isApplying
   * guard — a restore must NOT push a fresh command). Call only after the
   * mutation + notifyChange.
   */
  private recordCommand(label: string, before: AppearanceEntry[]): void {
    const history = this.deps.history;
    if (!history || history.isApplying()) return;
    const after = this.serialize();
    history.push(mementoCommand(label, before, after, (entries) => this.restoreState(entries)));
  }

  /**
   * Restore the appearance to exactly the given serialized state (undo/redo
   * apply). Clears all current state + meshes to base, then re-applies the
   * snapshot. Notifies but does NOT record (HistoryManager has isApplying()
   * true while this runs).
   */
  private restoreState(entries: readonly AppearanceEntry[]): void {
    // First normalize every element currently in a non-normal state that is
    // NOT in the target snapshot, so removed entries return to base.
    const target = new Map<AppearanceKey, AppearanceState>();
    for (const { modelId, expressId, state } of entries) {
      target.set(makeKey(modelId, expressId), state);
    }
    for (const key of Array.from(this.states.keys())) {
      if (!target.has(key)) {
        this.clearState(key); // → normal, restore meshes
      }
    }
    // Now apply the target snapshot.
    for (const [key, state] of target) {
      if (this.states.get(key) !== state) {
        this.setState(key, state);
      }
    }
    this.notifyChange();
  }

  private notifyChange(): void {
    this.deps.requestRender?.();
    for (const cb of this.changeListeners) cb();
  }
}
