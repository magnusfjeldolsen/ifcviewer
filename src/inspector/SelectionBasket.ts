/**
 * Selection Basket — feature 1 of the Data Insight phase.
 *
 * A persistent, user-curated set of element identities that survives
 * selection changes and the session, so users can collect elements across
 * clicks / marquee / models and then act on them (recall, and later: filter,
 * color, aggregate). The interaction feels like a calculator's memory keys
 * (M+ / M− / MR / MC); see SelectionBasketPanel + App for the wiring.
 *
 * This module is the **model** only — pure, no DOM, no web-ifc. It is the
 * first concrete `Scope` (a set of element identities; see types.ts). Later
 * Data Insight features (filter, model) will also expose
 * `getContents(): ElementIdentity[]`, and we generalize the `Scope` shape
 * then — for now the basket just needs to *be* a Scope source.
 *
 * Identity bookkeeping mirrors SelectionManager: entries are keyed by
 * "<modelId>:<expressId>" so add/remove dedupe consistently and
 * model-removal pruning uses the same delimiter-aware prefix check.
 *
 * Spec: dev/plans/handoff-selection-basket.md.
 */

import type { ElementIdentity, Scope } from './types';

/** Serialized basket entry — the cheap session-persistence shape. */
export interface BasketEntry {
  modelId: string;
  expressId: number;
}

/** Internal key: "<modelId>:<expressId>" (same scheme as SelectionManager). */
type BasketKey = string;

function makeKey(modelId: string, expressId: number): BasketKey {
  return `${modelId}:${expressId}`;
}

/**
 * Build a minimal-but-valid ElementIdentity from a serialized entry. The
 * basket only persists (modelId, expressId); ifcClass / ifcTypeCode get
 * placeholder values, matching SelectionManager's `placeholderIdentity`.
 * Recall (MR) feeds these into SelectionManager, which highlights by
 * (modelId, expressId) alone — the placeholders are never read for that.
 */
function placeholderIdentity(modelId: string, expressId: number): ElementIdentity {
  return { modelId, expressId, ifcClass: '', ifcTypeCode: 0 };
}

export class SelectionBasket {
  /**
   * Ordered map of basket entries. A Map preserves insertion order, which
   * keeps `getContents()` / `serialize()` stable for the UI and session.
   */
  private entries = new Map<BasketKey, ElementIdentity>();

  /** Listeners notified whenever the basket contents change. */
  private changeListeners: Array<() => void> = [];

  // ── Queries ────────────────────────────────────────────────

  /** Number of elements currently in the basket. */
  size(): number {
    return this.entries.size;
  }

  /** True if the given element is in the basket. */
  has(modelId: string, expressId: number): boolean {
    return this.entries.has(makeKey(modelId, expressId));
  }

  /**
   * The basket's contents as a `Scope` (insertion-ordered identity list).
   * This is the read surface future Data Insight features consume.
   */
  getContents(): Scope {
    return Array.from(this.entries.values());
  }

  // ── Mutations ──────────────────────────────────────────────

  /**
   * Add identities to the basket, deduping by modelId:expressId (both within
   * the call and against existing contents). Emits onChange once iff at least
   * one new element was added. An empty list or an all-duplicate list is a
   * pure no-op (no notification).
   */
  add(identities: readonly ElementIdentity[]): void {
    let mutated = false;
    for (const id of identities) {
      const key = makeKey(id.modelId, id.expressId);
      if (this.entries.has(key)) continue;
      this.entries.set(key, id);
      mutated = true;
    }
    if (mutated) this.notifyChange();
  }

  /**
   * Remove identities from the basket. No-op per element that isn't present.
   * Emits onChange once iff at least one element was actually removed.
   */
  remove(identities: readonly ElementIdentity[]): void {
    let mutated = false;
    for (const id of identities) {
      const key = makeKey(id.modelId, id.expressId);
      if (this.entries.delete(key)) mutated = true;
    }
    if (mutated) this.notifyChange();
  }

  /** Empty the basket. No-op (no notification) when already empty. */
  clear(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.notifyChange();
  }

  /**
   * Drop every entry owned by the given model. Called when a model is
   * removed (App.onRemoveModel / resetView) so stale references don't
   * survive model teardown. Mirrors SelectionManager.onModelRemoved: the
   * delimiter-aware prefix check avoids confusing "model" with "model-2".
   * Emits onChange once iff something was pruned.
   */
  onModelRemoved(modelId: string): void {
    const prefix = `${modelId}:`;
    let mutated = false;
    for (const key of Array.from(this.entries.keys())) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        mutated = true;
      }
    }
    if (mutated) this.notifyChange();
  }

  // ── Persistence ────────────────────────────────────────────

  /** Serialize contents to the cheap session shape (insertion-ordered). */
  serialize(): BasketEntry[] {
    return Array.from(this.entries.values(), (id) => ({
      modelId: id.modelId,
      expressId: id.expressId,
    }));
  }

  /**
   * Replace the basket contents with the given serialized entries. Used on
   * session restore (after models are restored). Emits onChange once iff the
   * input is non-empty (an empty deserialize into an empty basket is a no-op,
   * matching the other mutators). Entries are deduped on the way in.
   */
  deserialize(entries: readonly BasketEntry[]): void {
    const had = this.entries.size > 0;
    this.entries.clear();
    for (const { modelId, expressId } of entries) {
      const key = makeKey(modelId, expressId);
      if (this.entries.has(key)) continue;
      this.entries.set(key, placeholderIdentity(modelId, expressId));
    }
    if (had || this.entries.size > 0) this.notifyChange();
  }

  // ── Observer ───────────────────────────────────────────────

  /** Subscribe to basket-content changes. Returns an unsubscribe callback. */
  onChange(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  private notifyChange(): void {
    for (const cb of this.changeListeners) cb();
  }
}
