# Phase — Contextual action buttons (bottom-right floating tray)

## TL;DR

Add a Dalux-style **floating contextual button tray** at the bottom-right of the viewport that surfaces actions only when they're relevant. Ship v1 with one button — **Remove clipping plane** — that appears whenever a clip plane is active and removes only the clip plane (preserving measurements, selections, camera, and everything else). Container is forward-compatible: future buttons ("Remove all measurements", "Show hidden elements", etc.) plug in by registering with the tray.

Internally:
- New `src/ui/ContextualActions.ts` — a thin container that owns the DOM tray and renders/hides registered buttons based on their visibility predicates.
- `ClippingTool` exposes a `hasClipPlane(): boolean` accessor and an `onStateChange(cb): Unsubscribe` event hook so the tray re-renders only on actual state transitions (no polling).
- One register call in `App.ts` wires the clipping-removal button.

No new keyboard shortcuts. Single PR, ~150 lines + tests.

---

## Why this matters

- **User-visible problem:** today, removing a clip plane requires either re-entering placement mode (replace it) or pressing Reset View (which clears measurements and everything else too). There's no way to dismiss only the clip plane.
- **Forward compatibility:** the user has flagged future features (hidden elements, transparified elements) that will want the same contextual-button pattern. Building the tray now is cheaper than building three button-placement systems later.
- **Dalux idiom:** the user explicitly cited Dalux's "Fjern utsnitt" + "Fjern målinger" buttons at bottom-right. Familiar to AEC users.

Roadmap card: this work creates a new entry `contextual-action-tray-and-remove-clipping` (see "Roadmap update" at the bottom of this plan).

---

## Design

### Visibility predicate model

Each button is registered with the tray as:

```ts
interface ContextualAction {
  id: string;                                  // stable, used for DOM data-* and dedupe
  label: string;                               // shown next to icon
  icon: string;                                // emoji or unicode glyph
  isVisible: () => boolean;                    // predicate; tray polls this on subscribed events
  onClick: () => void;                         // invoked when user clicks
  subscribe?: (refresh: () => void) => Unsubscribe;  // optional event source so the tray re-evaluates on changes
}
```

Buttons without a `subscribe` are static — the tray evaluates them once on mount. With `subscribe`, the tray re-runs `isVisible()` whenever the source signals a change. This is the same shape we use for `SelectionManager.onChange` — clean, framework-free.

### `ContextualActions` module

```ts
export class ContextualActions {
  constructor(parent: HTMLElement);
  register(action: ContextualAction): Unsubscribe;   // call returns a function to deregister
  dispose(): void;
}
```

`register` returns its own unsubscribe so the caller (App) can clean up. Internally the tray maintains:
- A `Map<id, ContextualAction>` of registered actions.
- A `Map<id, Unsubscribe>` of subscriptions (the result of each `action.subscribe(refresh)` call).
- A single `refresh()` method that re-evaluates all `isVisible()` predicates and shows/hides DOM nodes accordingly.

DOM structure:
```
<div class="contextual-actions" hidden?>  <!-- hidden when no actions visible -->
  <button class="contextual-action" data-action-id="...">
    <span class="contextual-action-icon">✂</span>
    <span class="contextual-action-label">Remove clipping</span>
  </button>
  <!-- one button per visible action -->
</div>
```

CSS matching the project's existing panel idiom (see `.model-panel` and `.inspector-panel` in `src/styles.css` — semi-transparent white card, 8px radius, soft shadow, no explicit border; brand-blue accent `#3b82f6`):

```css
.contextual-actions {
  position: absolute;
  bottom: 40px;          /* clears the #app-footer at bottom:0 */
  right: 12px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}
.contextual-actions[hidden] { display: none; }

.contextual-action {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 8px;                      /* matches .model-panel / .inspector-panel */
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); /* matches existing panels */
  font-size: 13px;
  font-family: inherit;                    /* respects body system-ui */
  color: #374151;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
}
.contextual-action:hover {
  background: rgba(255, 255, 255, 1);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
}
.contextual-action:active {
  background: #f3f4f6;
}
.contextual-action-icon { font-size: 14px; color: #3b82f6; }  /* brand blue */
.contextual-action-label { white-space: nowrap; }
```

The agent should read `src/styles.css` first and confirm these tokens still match the live conventions before writing — if the panel idiom has shifted, align with current rather than this spec.

### `ClippingTool` API additions

Two small additions, both purely additive:

```ts
/** True when a clip plane is active. */
hasClipPlane(): boolean;

/** Subscribe to plane state transitions (create / remove). Returns unsubscribe. */
onStateChange(cb: () => void): () => void;
```

State emits on:
- `createClipPlane()` (after the plane is constructed) → `notifyStateChange()`
- `removeClipPlane()` (after teardown) → `notifyStateChange()`

Pattern matches `SelectionManager.onChange`. No public API removal — pure addition.

### Wiring in `App.start()`

After `clippingTool` is constructed and before `viewer.animate()`:

```ts
const appEl = document.getElementById('app')!;
this.contextualActions = new ContextualActions(appEl);

this.contextualActions.register({
  id: 'remove-clipping',
  label: 'Remove clipping',
  icon: '✂',                                 // alternatives: ✕, 🗙 — confirm in smoke
  isVisible: () => this.clippingTool.hasClipPlane(),
  onClick: () => this.clippingTool.clearClipPlane(),
  subscribe: (refresh) => this.clippingTool.onStateChange(refresh),
});
```

In `App.dispose`:

```ts
this.contextualActions.dispose();
```

---

## Files to touch

| File | Change |
|------|--------|
| `src/tools/ClippingTool.ts` | Add `hasClipPlane()`, `onStateChange(cb)`, internal `notifyStateChange()`. Call notifier at the end of `createClipPlane()` and `removeClipPlane()`. Add `private stateListeners: Array<() => void> = []` and clear in `dispose()`. |
| `src/ui/ContextualActions.ts` (NEW) | The tray container per the design above. |
| `src/styles.css` | Add `.contextual-actions` block. |
| `src/core/App.ts` | Construct `ContextualActions`, register the remove-clipping button, dispose on teardown. Field declaration alongside other UI components. |
| `tests/contextual-actions.test.ts` (NEW) | Tests: button visible only when `isVisible()` returns true; click fires `onClick`; `subscribe()` re-evaluates predicates; `register()` deregistration removes the button from DOM; `dispose()` removes all listeners and the DOM tray. |
| `tests/clipping-tool.test.ts` (NEW, small) | Tests for the new ClippingTool API: `hasClipPlane()` reflects current state; `onStateChange(cb)` fires on create + remove + dispose; unsubscribe stops firing. **No test for the actual placement/drag math — that's covered by `tests/clipping-math.test.ts`.** |
| `dev/plans/roadmap.md` | Add the new card to Queued; move to Done when shipped. |

**Files NOT to touch:**
- `src/inspector/*` — unrelated.
- `src/tools/MeasurementTool.ts` — future "Remove measurements" button will live here when that ships, not now.
- `src/utils/raycast.ts` — unrelated.
- Other tools' state — only ClippingTool's clip plane lifecycle changes.

---

## Step-by-step

1. **Confirm baseline green** on main: `npm test` (365 passing), `npm run lint`, `npm run typecheck`.
2. **Branch:** `git checkout main && git pull --ff-only && git checkout -b feature/contextual-action-buttons`.
3. **Extend `ClippingTool`** with `hasClipPlane()` + `onStateChange()` + `notifyStateChange()`. Wire notifier into `createClipPlane()` and `removeClipPlane()`. Add tests in `tests/clipping-tool.test.ts`.
4. **Run tests** — new `ClippingTool` tests pass; existing tests untouched.
5. **Build `ContextualActions`** in `src/ui/ContextualActions.ts`. Pure DOM, no framework. Tests in `tests/contextual-actions.test.ts` cover: register, refresh on subscribe, deregister, dispose.
6. **Add CSS** in `src/styles.css`.
7. **Wire in `App.ts`:** construct `contextualActions`, register the remove-clipping button after `clippingTool` is constructed, dispose in `App.dispose`.
8. **Run the full suite** — must be green (target: 365 → 365 + ~12 = ~377 tests).
9. **Lint + typecheck** — clean.
10. **Manual smoke** (see below).
11. **Update roadmap:** add new card, move to Done on merge.
12. **Single commit** with title `Add contextual action tray + Remove clipping button`.

---

## Tests

### `tests/clipping-tool.test.ts` (NEW)

Setup: minimal stub renderer/scene/camera/canvas, instantiate `ClippingTool`. We're not testing placement math (already in `clipping-math.test.ts`); we're testing the state-observability surface.

Cases:
1. `hasClipPlane()` returns `false` initially.
2. Manually invoking `createClipPlane()` (after setting `planeNormal` / `planePoint`) flips `hasClipPlane()` to `true`.
3. `clearClipPlane()` flips it back to `false`.
4. `onStateChange(cb)` fires once on create, once on clear.
5. `onStateChange` returns an unsubscribe function; after calling it, the listener no longer fires.
6. Multiple listeners receive notifications independently; one unsubscribing doesn't affect others.
7. `dispose()` clears all listeners (a post-dispose state change would be a no-op — but since dispose also clears the plane, this is automatically true).

### `tests/contextual-actions.test.ts` (NEW)

Use `// @vitest-environment jsdom`. Mount in a fresh `<div>` per test (matches `tests/cookie-banner.test.ts` pattern).

Cases:
1. Empty tray (no registrations) renders the container but it's `hidden` (or has no visible children).
2. Register a static action with `isVisible: () => true` → button appears with the right label and icon.
3. Register a static action with `isVisible: () => false` → button does NOT appear.
4. Action with `subscribe` callback: flipping the source state and invoking the `refresh()` callback updates DOM visibility.
5. Click on a button fires `onClick`.
6. `register()`'s return-value unsubscribe removes the button from DOM.
7. `dispose()` removes the tray container and unhooks all subscriptions.
8. Two actions registered; one visible, one not → only the visible one renders. Flipping both via `refresh()` updates correctly.
9. Tray re-orders deterministically by registration order (not strictly required but verify so layout is stable).

---

## Manual smoke tests

Run after dev server is up. Load any IFC.

### Core flow
1. No clip plane initially → **no button visible** at bottom-right (footer is the only thing there).
2. Press ✂ → click on a surface → clip plane appears.
3. **Bottom-right button appears**: "✂ Remove clipping" (or chosen icon + label).
4. Click the button → **clip plane and gizmo disappear**. Button hides.
5. No other state changes: measurements (if placed) still visible, selections still highlighted, camera unchanged.

### State preservation (the user's specific concern)
6. Place a clip plane. Take a measurement (M → click two points). Verify measurement visible.
7. Click "Remove clipping" → measurement is **still visible**.
8. Place clip plane again. Click an element → inspector panel + highlight appear.
9. Click "Remove clipping" → element is **still highlighted**, panel still shows its properties.
10. Place clip plane. Orbit / zoom / pan to a specific camera position.
11. Click "Remove clipping" → camera position unchanged. No fit-to-box, no jump.

### Edge cases
12. Reset View while button is visible → clip plane clears, button hides.
13. Press C while button is visible → re-enters placement mode (existing C-shortcut behavior). Button remains visible until new plane is placed (or stays — verify).
14. Place plane, click Remove, place new plane on a different surface → button reappears for the new plane.
15. Multiple rapid Remove clicks (impossible after first since button hides, but the tray must not crash if a stale click somehow fires).

### Layout
16. Resize browser window narrow → button stays bottom-right, not clipped by footer.
17. Cookie banner expanded (if applicable) → no overlap with Remove button (cookie banner is bottom-left, button is bottom-right, no conflict expected).
18. Inspector panel expanded → no overlap (inspector is bottom-left).

### Visual / styling
19. Hover state visible (background lightens).
20. Click visual feedback works (active state if styled).
21. Icon + label readable; not truncated.

### Console
22. No red errors at any step. No NaN warnings.

---

## Out of scope (future tickets)

1. **Remove measurements** button — uses the same tray when `MeasurementTool` adds equivalent `hasMeasurements()` + `onStateChange()` accessors. Follow-up PR.
2. **Show hidden elements** button — depends on the future visibility-management feature. Not designed yet.
3. **Reset transparency** button — depends on the future transparency/ghost-mode feature.
4. **Keyboard shortcut** for Remove clipping (e.g. `Shift+C`) — could conflict with future shortcuts. Defer.
5. **Animation** on show/hide — nice-to-have, not v1.
6. **Tray collapse / expand** when many buttons accumulate — only relevant once we have 4+ contextual actions.

---

## Risks & gotchas

1. **z-index conflicts** — `.contextual-actions` uses `z-index: 50`. Cookie banner is `z-index: 100`, help overlay is much higher. Inspector panel is `z-index: 10`. So our tray sits above the inspector / canvas, below modals. Verify the cookie banner expanded form doesn't overlap visually (it's bottom-left, ours is bottom-right, so they shouldn't even share space — but confirm in smoke).

2. **Footer overlap** — `#app-footer` is `position: fixed; bottom: 0; right: 0` per `styles.css:907`. Our button is at `bottom: 40px; right: 12px`. Should not overlap, but the footer's height isn't fixed in code — verify visually.

3. **Subscription leak** — if `App.dispose` isn't called (e.g. SPA route change without proper teardown), the `clippingTool.onStateChange` subscription leaks. Acceptable for a single-page viewer where dispose only runs on tab close.

4. **Static actions** (those without `subscribe`) need manual `refresh()` calls. The remove-clipping action has `subscribe`, so this isn't an issue today, but document the pattern so future contributors don't accidentally register static actions that never update.

5. **`dispose()` ordering in `App.dispose`** — `contextualActions.dispose()` should run BEFORE `clippingTool.dispose()` to avoid listener-after-source teardown issues. Alphabetic order in current `App.dispose` won't naturally give us this; explicitly order it.

---

## Roadmap update

Add to `dev/plans/roadmap.md` under Queued:

```markdown
### `contextual-action-tray-and-remove-clipping` — Bottom-right floating action tray + Remove clipping button
- **Status:** queued
- **Effort:** S
- **Why:** Today, removing a clip plane requires Reset View (which clears measurements + everything else) or re-entering placement mode (which replaces). Users want a single button that drops only the clip plane while keeping every other state. Building this as a reusable tray (Dalux-style "Fjern utsnitt" / "Fjern målinger") also creates the substrate for future "Remove measurements" / "Show hidden" / "Reset transparency" buttons.
- **What:**
  - New `src/ui/ContextualActions.ts` — tray container with `register(action)` API.
  - `ClippingTool.hasClipPlane()` + `onStateChange()` accessors; notify on create + remove.
  - `App.ts` wires the Remove clipping button using `clippingTool.clearClipPlane()` (audited safe — touches only plane state).
  - CSS for `.contextual-actions` and `.contextual-action`.
- **Risks:** z-index conflict with footer; subscription lifecycle. Both documented in the plan.
- **Source:** `dev/plans/phase-contextual-action-buttons.md`.
```

Move to Done on PR merge with one-line outcome (e.g. "Tray + one button shipped; ClippingTool gained onStateChange. Two follow-up tickets opened for measurements / hidden-elements buttons.").

---

## Definition of done

- Button appears bottom-right iff a clip plane is active.
- Clicking the button removes the clip plane and gizmo.
- Measurements, selections, camera state, and inspector contents all unchanged after click.
- All existing tests still pass; new tests pass; lint + typecheck clean.
- Manual smoke checklist executed.
- Roadmap card moved to Done with PR # and outcome line.
