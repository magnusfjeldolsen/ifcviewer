---
name: Tool/manager observer pattern
description: Project convention for adding event-listener surfaces to tools and managers (SelectionManager.onChange shape)
type: project
---

The project's observable pattern across SelectionManager, ToolManager, and now ClippingTool is:

```ts
private stateListeners: Array<() => void> = [];   // or Array<(state: T) => void>

onChange(cb: () => void): () => void {
  this.stateListeners.push(cb);
  return () => {
    this.stateListeners = this.stateListeners.filter((l) => l !== cb);
  };
}

private notifyChange(): void {
  for (const cb of this.stateListeners) cb();
}
```

Conventions to copy:
- Listener array reassigned (not spliced) on unsubscribe — safe under in-flight iteration.
- Notify fires AFTER the transition is fully applied, never partway through.
- `dispose()` sets `stateListeners = []` after the final transition fires.
- For transitions that internally call a teardown function (e.g. re-place: createClipPlane calls removeClipPlane), the inner call's notifier should be guarded so it only fires on actual transitions (had-prior-state check). Otherwise observers see spurious "remove" events that didn't happen.

**Why:** The pattern lets feature UI (e.g. ContextualActions tray) wire to state without polling and without coupling to internals. Tested in tests/clipping-tool.test.ts and tests/contextual-actions.test.ts.

**How to apply:** When adding any observable state to a tool/manager, use this exact shape — it's what App.ts wires into, and consumers like ContextualActions assume it.
