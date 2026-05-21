# Plan — Selection Basket (Data Insight, feature 1)

Implementation-ready plan. Branch `feature/selection-basket` off `main`.
Effort **M**. This is the first feature of the Data Insight phase
(`phase-data-insight.md`) and where the shared `Scope` concept is born.

## Goal

A persistent, user-curated **set of elements** that survives selection
changes and the session, so users can collect elements across clicks /
marquee / models and then act on them (later: filter, color, aggregate).
The interaction should feel like a calculator's memory keys.

**UX is the priority.** It must be obvious and low-friction; nothing modal
or noisy; keep the lightweight feel.

## The `Scope` concept (introduced here)

The basket is the first concrete **`Scope`** — a set of element identities.
Keep the abstraction minimal for now:

```ts
// src/inspector/types.ts (existing ElementIdentity is reused)
type Scope = readonly ElementIdentity[];   // a plain list; the basket produces one
```

Don't build a `Scope` class hierarchy yet — later features (filter, model)
will also expose `getContents(): ElementIdentity[]`, and we generalize then.
The basket just needs to *be* a `Scope` source.

## Behaviour — the four calculator actions

Mirrors a calculator's memory keys. (Calculator "clear memory" is **MC**.)

| Key | Action | Implementation |
|-----|--------|----------------|
| **M+** | Add the current live selection to the basket | `basket.add(selection.getState() identities)` |
| **M−** | Remove the current live selection from the basket | `basket.remove(...)` |
| **MR** | Recall — select the basket's contents (highlight them) | `selectionManager.applyMany('replace', basket.getContents())` |
| **MC** | Clear the basket | `basket.clear()` |

`add`/`remove` dedupe by `modelId:expressId` (same key SelectionManager uses).

## UX — placement, visibility, tooltips (the crux)

### Recommendation

Three surfaces, each pulling its weight, no redundancy:

1. **Entry point — "Add to basket" in the inspector header.** The inspector
   already appears on any live selection. Add one icon button there (tooltip
   **"Add to basket (M+)"**). This is how a basket is *started* — it solves
   the chicken-and-egg of "buttons only show once a basket exists."
   *(This is likely the green ▲ icon already sketched in the inspector.)*

2. **Basket panel — appears only when the basket is non-empty.** A small
   panel (suggest: top-left, under the Models tree) showing **"N in basket"**
   plus the calculator cluster **M+ · M− · MR · MC**, each with a tooltip:
   - **M+** — "Add selection to basket"
   - **M−** — "Remove selection from basket"
   - **MR** — "Select basket contents"
   - **MC** — "Clear basket"
   M+ / M− are **disabled** (greyed, tooltip still shown) when there is no
   live selection; MR / MC are always enabled while the basket is non-empty.
   This honours "the buttons appear once a basket exists" — the *cluster*
   only shows when the basket has content — while the inspector entry point
   covers the very first add.

3. **Contextual-tray "Clear basket"** — when the basket is non-empty, also
   register a **"Clear basket"** button in the bottom-right tray (same idiom
   as "Remove clipping"), so the basket can be cleared even when nothing is
   selected and the user's attention is elsewhere. (Per your explicit ask.)

Why enable/disable inside the cluster rather than show/hide each button:
calculator keys don't appear and vanish — greying is calmer and keeps the
layout stable. The *cluster* still appears/disappears with the basket, so
the screen stays empty until there's something to manage.

### Open decision (your call)

- **D1 — Is the split right?** Inspector "Add to basket" (start) + basket
  panel (manage, when non-empty) + tray "Clear". Alternative: a single
  always-present calculator cluster with everything greyed until usable.
  Recommendation: the split above — it matches "appear when basket present."

## Files

| File | Change |
|------|--------|
| `src/inspector/SelectionBasket.ts` | NEW — the basket model: `add` / `remove` / `clear` / `recall-contents` / `has` / `size` / `onChange` + serialize/deserialize. Pure, unit-testable. |
| `src/ui/SelectionBasketPanel.ts` | NEW — the basket panel (count + M+/M−/MR/MC cluster + tooltips). Subscribes to basket + selection state for enable/disable. |
| `src/inspector/InspectorPanel.ts` | Add the "Add to basket (M+)" header button (visible whenever the panel is). |
| `src/core/App.ts` | Construct the basket + panel; wire the 4 actions to SelectionManager; register the contextual-tray "Clear basket"; persist/restore the basket in the session. |
| `src/services/SessionStore.ts` | `SessionState` gains `basket?: { modelId: string; expressId: number }[]`. |
| `src/styles.css` | Basket panel styling — match the existing panel idiom (semi-transparent white, 8px radius, soft shadow). |

## Integration

- **Live selection** comes from `SelectionManager` (`getState()`, `onChange`,
  `applyMany`). M+/M− read the current state's identities; MR drives
  `applyMany('replace', contents)`.
- **Enable/disable** of M+/M− follows `SelectionManager.onChange`; the panel's
  visibility + count follow `basket.onChange`.
- **Contextual tray**: register like the existing "Remove clipping" —
  `isVisible: () => basket.size() > 0`, `onClick: () => basket.clear()`,
  `subscribe: (refresh) => basket.onChange(refresh)`.
- **Model removal**: when a model is removed (`onRemoveModel` / `resetView`),
  drop that model's entries from the basket (mirror
  `SelectionManager.onModelRemoved`).

## Session persistence

- On basket change, debounced-save the contents as
  `{ modelId, expressId }[]` into the session (reuse the `scheduleSave`
  path / `SessionStore.saveSession`). Honour the memory toggle.
- On restore: rehydrate the basket **after** models are restored (the
  identities only resolve once their models exist). Drop entries whose model
  didn't restore. The basket is metadata — no geometry — so it's cheap; no
  IDB needed, it rides in the localStorage session state.

## Edge cases

- **MR vs the single-model-lock (decided: MR bypasses it).** The lock is a
  **global, persisted user preference** — localStorage
  `ifcviewer:inspectorSingleModelLock` (default on), toggled by the inspector's
  "Single-model selection" checkbox; it governs how selection *additions*
  combine across models (ctrl-click, marquee). It is NOT tool-scoped.
  `applyMany('replace', …)` currently honours the lock (collapses the batch to
  the first model), so recall needs a **lock-bypassing path** — a new
  `SelectionManager` method (e.g. `selectExactly(identities)`) or an
  `applyMany(…, { bypassLock: true })` option — that selects all basket
  contents across models **without changing the setting**. This is the
  "be careful to avoid bugginess" point: don't toggle the lock, just bypass it
  for this one operation and leave the user's preference untouched.
- **M+ with nothing selected** → no-op (button disabled anyway).
- **M− removing elements not in the basket** → no-op per element.
- **Duplicate add** → deduped, no growth.
- **Recall after some basket elements' model was removed** → those are
  already pruned (see model removal).

## Test plan

**Automated** (the basket model is pure → strong unit coverage):
- `tests/selection-basket.test.ts` (NEW): add/remove dedupe; clear; size;
  has; `onChange` fires on mutate and not on no-op; serialize ↔ deserialize
  round-trip; model-removal pruning.
- `SelectionBasketPanel` (NEW test, jsdom): renders count; buttons fire the
  right basket/selection calls (mock); M+/M− disabled with no selection;
  panel hidden when basket empty.
- Wire-up assertions in an App-level or integration test where feasible
  (M+ adds the live selection; MR drives `applyMany`).

**Manual smoke**:
1. Select elements → inspector "Add to basket" → basket panel appears, count
   correct, geometry unaffected.
2. Select more → M+ → count grows; re-add same → no change (dedupe).
3. Select a subset → M− → count drops.
4. Clear selection, MR → basket contents become the live selection (high­lit).
5. Tray "Clear basket" (with nothing selected) → basket empties, panel hides.
6. Tooltips on every button read correctly.
7. Build a basket across **two models** → MR selects across both.
8. Reload the page → basket restores (after models load); a removed model's
   entries are gone.
9. No console errors; the panel matches the existing visual idiom.

## Out of scope (later Data Insight features)

Filtering, coloring, aggregation — they will *consume* the basket `Scope`
but are separate cards. This feature only establishes the basket + the
`Scope.getContents()` shape they'll read.

## Decisions — CONFIRMED 2026-05-21 (build to these)

- **D1 — CONFIRMED:** the three-surface UX split above (inspector "Add to
  basket" entry · basket panel that appears only when non-empty · contextual-
  tray "Clear basket"), with tooltips and M+/M− greyed when no live selection.
- **D2 — CONFIRMED:** the basket persists in the session (rides in the
  localStorage session state; rehydrated after models restore).
- **D3 — CONFIRMED:** MR ignores the single-model-lock — recall selects the
  whole basket across models via a lock-bypassing path that does NOT mutate
  the setting. See the lock note under Edge cases.
