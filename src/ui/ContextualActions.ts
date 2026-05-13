/**
 * Floating contextual-action tray, bottom-right of the viewport.
 *
 * Each action registers with a visibility predicate and an optional event
 * source. When the source signals a state change, the tray re-evaluates
 * the predicate and toggles the button's DOM visibility. The tray itself
 * hides (via the `hidden` attribute) when no registered action is visible.
 *
 * This is the substrate for future contextual buttons (Remove measurements,
 * Show hidden elements, etc.); v1 ships with one button — Remove clipping —
 * registered by App.ts.
 */

export interface ContextualAction {
  /** Stable identifier — used for data-attribute on the DOM node and dedup. */
  id: string;
  /** Visible label next to the icon. */
  label: string;
  /** Glyph rendered to the left of the label (emoji or unicode). */
  icon: string;
  /** Predicate evaluated on every refresh; truthy → button visible. */
  isVisible: () => boolean;
  /** Invoked when the button is clicked. */
  onClick: () => void;
  /**
   * Optional event source. The tray calls `subscribe(refresh)` and stores
   * the returned unsubscribe; the action receives a `refresh` callback that
   * re-evaluates ALL predicates (cheap — O(actions)). Without `subscribe`,
   * the action is static and only updates when someone else triggers a
   * refresh (e.g. another action's subscribe firing).
   */
  subscribe?: (refresh: () => void) => () => void;
}

interface ActionEntry {
  action: ContextualAction;
  button: HTMLButtonElement;
  unsubscribe: (() => void) | null;
}

export class ContextualActions {
  private container: HTMLElement;
  private entries = new Map<string, ActionEntry>();
  private disposed = false;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'contextual-actions';
    this.container.hidden = true; // start hidden until at least one action is visible
    parent.appendChild(this.container);
  }

  /**
   * Register a contextual action. Builds the button, wires the optional
   * subscription, runs an initial visibility evaluation, and returns an
   * unsubscribe that deregisters the action (removes button + unhooks
   * subscription).
   *
   * Re-registering the same id (defined by `action.id`) deregisters the
   * previous entry first — last-write-wins. Caller error to do this, but
   * we don't leak DOM nodes if they do.
   */
  register(action: ContextualAction): () => void {
    if (this.disposed) {
      // No-op if already disposed; caller's unsubscribe is harmless.
      return () => {};
    }

    // Last-write-wins on duplicate id: remove the prior entry first.
    if (this.entries.has(action.id)) {
      this.deregisterEntry(action.id);
    }

    const button = document.createElement('button');
    button.className = 'contextual-action';
    button.type = 'button';
    button.dataset.actionId = action.id;

    const iconEl = document.createElement('span');
    iconEl.className = 'contextual-action-icon';
    iconEl.textContent = action.icon;

    const labelEl = document.createElement('span');
    labelEl.className = 'contextual-action-label';
    labelEl.textContent = action.label;

    button.appendChild(iconEl);
    button.appendChild(labelEl);
    button.addEventListener('click', () => {
      // Defensive: a stale click after deregistration would already have
      // the listener removed because the button is gone from the DOM.
      // No additional guard needed.
      action.onClick();
    });

    this.container.appendChild(button);

    const entry: ActionEntry = { action, button, unsubscribe: null };
    this.entries.set(action.id, entry);

    if (action.subscribe) {
      entry.unsubscribe = action.subscribe(() => this.refresh());
    }

    this.refresh();

    return () => this.deregisterEntry(action.id);
  }

  /**
   * Re-evaluate every action's predicate and update DOM visibility.
   * Public so callers with static (non-subscribed) actions can trigger a
   * refresh manually — though all v1 actions are subscribed.
   */
  refresh(): void {
    if (this.disposed) return;
    let anyVisible = false;
    for (const entry of this.entries.values()) {
      const visible = entry.action.isVisible();
      entry.button.hidden = !visible;
      if (visible) anyVisible = true;
    }
    this.container.hidden = !anyVisible;
  }

  /**
   * Tear down the tray. Unsubscribes every action's event source, removes
   * the container from the DOM, and clears internal state. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.unsubscribe) entry.unsubscribe();
    }
    this.entries.clear();
    if (this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  }

  private deregisterEntry(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.unsubscribe) entry.unsubscribe();
    if (entry.button.parentNode) {
      entry.button.parentNode.removeChild(entry.button);
    }
    this.entries.delete(id);
    this.refresh();
  }
}
