import type { ModelManager } from './ModelManager';
import type { HistoryManager } from '../core/history/HistoryManager';
import { mementoCommand } from '../core/history/mementoCommand';
import { makeKey } from '../inspector/elementKey';
import type { Scope } from '../inspector/types';

/**
 * Element appearance — per-element visibility + transparency overrides.
 *
 * One manager, ONE state per element (decision A4): `'hidden' | 'transparent'`,
 * absent ⇒ `'normal'`. A new op OVERRIDES the current one — there is no
 * combined transparent+hidden.
 *
 *   priority:  hidden  >  transparent  >  (base)      and highlight composes on top
 *
 * The state is pushed to the renderer through ModelManager's element API:
 * - **hidden** → `setHidden(…, true)`: not drawn, not picked, not framed.
 * - **transparent** → `setOpacity(…, TRANSPARENCY_OPACITY)`.
 * - **normal** → visible, own opacity.
 *
 * Highlight, colour, opacity and visibility are independent per-element
 * attributes in the renderer, so the precedence above holds without any
 * reconciliation between this manager and SelectionManager: a hidden element
 * is not drawn whatever else is set, and the highlight composes on top of
 * whatever opacity the element has.
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
}

/** Internal key: "<modelId>:<expressId>" (same scheme as SelectionManager). */
type AppearanceKey = string;

export class AppearanceManager {
  private deps: AppearanceManagerDeps;

  /** Element → state. Absent ⇒ 'normal'. */
  private states = new Map<AppearanceKey, AppearanceState>();

  /** Elements whose state changed since the renderer was last told. */
  private dirty = new Set<AppearanceKey>();

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

  // ── User ops (each = one undoable command) ──────────────────

  /** Hide every element in the scope. Overrides any prior state. */
  hide(scope: Scope): void {
    this.runOp('hidden', scope, 'Hide elements');
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

    for (const modelId of this.deps.modelManager.getModelIds()) {
      for (const expressId of this.deps.modelManager.elementIds(modelId)) {
        const key = makeKey(modelId, expressId);
        if (keep.has(key)) {
          // Scope element → normal/visible.
          if (this.states.get(key) !== undefined) {
            this.clearState(key);
            mutated = true;
          }
        } else if (this.states.get(key) !== 'hidden') {
          // Complement → hidden.
          this.setState(key, 'hidden');
          mutated = true;
        }
      }
    }

    this.flush();
    this.finishOp(mutated, before, 'Isolate elements');
  }

  /** Clear all hidden state (restore visibility). Leaves transparency intact. */
  showAll(): void {
    this.clearAll('hidden', 'Show all');
  }

  /** Make every element in the scope transparent. Overrides any prior state. */
  transparent(scope: Scope): void {
    this.runOp('transparent', scope, 'Make transparent');
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
    this.flush();
    this.finishOp(mutated, before, 'Make opaque');
  }

  /** Clear all transparent state (the tray recovery action). */
  clearTransparency(): void {
    this.clearAll('transparent', 'Clear transparency');
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
   * model isn't loaded still record state (harmless) but apply no effect.
   */
  deserialize(entries: readonly AppearanceEntry[]): void {
    for (const { modelId, expressId, state } of entries) {
      this.setState(makeKey(modelId, expressId), state);
    }
    this.flush();
    if (entries.length > 0) this.notifyChange();
  }

  /**
   * Drop every entry owned by the given model (model removal). Delimiter-aware
   * prefix check so "m1" doesn't also prune "m1-2". A SYSTEM change — fires
   * onChange iff something was pruned, pushes no undo command. The model's
   * geometry is gone (ModelManager disposed it); this only drops bookkeeping.
   */
  onModelRemoved(modelId: string): void {
    const prefix = `${modelId}:`;
    let mutated = false;
    for (const key of Array.from(this.states.keys())) {
      if (key.startsWith(prefix)) {
        this.states.delete(key);
        this.dirty.delete(key);
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

  /** Set `target` on each scope element, recording one command iff anything changed. */
  private runOp(target: AppearanceState, scope: Scope, label: string): void {
    const before = this.serialize();
    let mutated = false;
    for (const id of scope) {
      const key = makeKey(id.modelId, id.expressId);
      if (this.states.get(key) === target) continue; // no-op for this element
      this.setState(key, target);
      mutated = true;
    }
    this.flush();
    this.finishOp(mutated, before, label);
  }

  /** Clear every element in `state` back to normal, as one command. */
  private clearAll(state: AppearanceState, label: string): void {
    const before = this.serialize();
    let mutated = false;
    for (const [key, s] of Array.from(this.states)) {
      if (s === state) {
        this.clearState(key);
        mutated = true;
      }
    }
    this.flush();
    this.finishOp(mutated, before, label);
  }

  private setState(key: AppearanceKey, state: AppearanceState): void {
    this.states.set(key, state);
    this.dirty.add(key);
  }

  private clearState(key: AppearanceKey): void {
    this.states.delete(key);
    this.dirty.add(key);
  }

  /**
   * Tell the renderer about every element whose state changed, grouped so a
   * model gets at most four calls however many elements moved.
   */
  private flush(): void {
    if (this.dirty.size === 0) return;
    const byModel = new Map<string, { hide: number[]; show: number[]; fade: number[]; unfade: number[] }>();
    for (const key of this.dirty) {
      const idx = key.indexOf(':');
      const modelId = key.slice(0, idx);
      const expressId = Number(key.slice(idx + 1));
      let lists = byModel.get(modelId);
      if (!lists) byModel.set(modelId, (lists = { hide: [], show: [], fade: [], unfade: [] }));
      const state = this.states.get(key);
      (state === 'hidden' ? lists.hide : lists.show).push(expressId);
      (state === 'transparent' ? lists.fade : lists.unfade).push(expressId);
    }
    this.dirty.clear();
    const mm = this.deps.modelManager;
    for (const [modelId, l] of byModel) {
      if (!mm.getModel(modelId)) continue; // model not live (e.g. deserialize before load)
      if (l.hide.length) mm.setHidden(modelId, l.hide, true);
      if (l.show.length) mm.setHidden(modelId, l.show, false);
      if (l.fade.length) mm.setOpacity(modelId, l.fade, TRANSPARENCY_OPACITY);
      if (l.unfade.length) mm.setOpacity(modelId, l.unfade, null);
    }
    this.deps.requestRender?.();
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
   * apply). Elements not in the snapshot return to normal, then the snapshot
   * is applied. Notifies but does NOT record (HistoryManager has isApplying()
   * true while this runs).
   */
  private restoreState(entries: readonly AppearanceEntry[]): void {
    const target = new Map<AppearanceKey, AppearanceState>();
    for (const { modelId, expressId, state } of entries) {
      target.set(makeKey(modelId, expressId), state);
    }
    for (const key of Array.from(this.states.keys())) {
      if (!target.has(key)) this.clearState(key);
    }
    for (const [key, state] of target) {
      if (this.states.get(key) !== state) this.setState(key, state);
    }
    this.flush();
    this.notifyChange();
  }

  private notifyChange(): void {
    this.deps.requestRender?.();
    for (const cb of this.changeListeners) cb();
  }
}
