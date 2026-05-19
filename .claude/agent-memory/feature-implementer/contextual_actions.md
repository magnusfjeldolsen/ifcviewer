---
name: Contextual actions tray
description: Bottom-right floating tray for state-dependent action buttons; how to add new buttons
type: project
---

`src/ui/ContextualActions.ts` is the shared substrate for state-conditional buttons that appear at the viewport's bottom-right corner. Currently hosts "Remove clipping"; future plug-ins planned for "Remove measurements", "Show hidden elements", "Reset transparency".

To add a new contextual button:

```ts
this.contextualActions.register({
  id: 'unique-stable-id',
  label: 'Visible label',
  icon: '⊡',                                    // emoji or unicode glyph
  isVisible: () => someTool.hasState(),
  onClick: () => someTool.clearState(),
  subscribe: (refresh) => someTool.onStateChange(refresh),
});
```

The owning tool/manager must expose:
- A predicate accessor like `hasClipPlane(): boolean` — synchronous, cheap, idempotent.
- An `onStateChange(cb): () => void` subscription matching the SelectionManager/ToolManager listener pattern. See `observer_pattern.md`.

**Dispose ordering**: in `App.dispose()`, `contextualActions.dispose()` must run BEFORE the disposers of the underlying tool/manager sources (e.g. before `toolManager.dispose()`), so the tray unsubscribes from a still-live source. The field is initialized in `start()`, so the dispose call must be guarded (`if (this.contextualActions)`).

**Why:** Building this as a reusable tray now (Dalux-style "Fjern utsnitt") creates the substrate for future contextual buttons without three button-placement systems later. The Remove-clipping ticket was the v1 catalyst.

**How to apply:** Whenever a feature lands a new "clear / remove / undo just this state" operation, prefer adding a contextual button over a global Reset.
