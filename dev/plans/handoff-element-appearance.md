# Plan — Element Appearance (hide / isolate · transparent / opaque)

Implementation-ready plan. Branch `feature/element-appearance` off `main`.
Effort **M**. The first `Scope` *consumer* of `phase-scope-ops-and-undo.md`:
per-element visibility and transparency overrides, driven from the context menu
(`handoff-context-menu.md`) and a multi-selection, made reversible by
undo/redo (`handoff-undo-redo.md`). Supersedes and expands the roadmap's
`element-visibility` card (adds isolate + transparency + undo).

## Goal

Act on a `Scope` (live selection, or a single right-clicked element) to:
- **Hide** / **Show all** — element-level visibility (today it's per-model).
- **Isolate** — hide everything *except* the scope (the most-used BIM verb).
- **Make transparent** / **Make opaque** — fade elements so you can see through
  to what's behind.

Every op is **one undoable command** and is recoverable from an always-present
escape hatch in the contextual tray. The user is never trapped with invisible
or faded geometry.

## One appearance system (recommended)

Model both states in **one** manager rather than two that fight over
`mesh.material`. An element is in exactly one appearance state:

```ts
// src/viewer/AppearanceManager.ts
type AppearanceState = 'hidden' | 'transparent';   // absent ⇒ 'normal'
```

`AppearanceManager` holds `Map<elementKey, AppearanceState>` (key
`"<modelId>:<expressId>"`, same scheme as SelectionManager/basket) and resolves
each affected mesh:

```
priority:  hidden  >  transparent  >  (base)        and highlight composes on top
```

- **hidden** → `mesh.visible = false`.
- **transparent** → swap to a transparent material clone.
- **normal** → restore the original material + `mesh.visible = true`.

**States are mutually exclusive** (CONFIRMED, A4): an element has exactly one
appearance state, and a new op **overrides** the current one — we do not track
"transparent *and* hidden". Hiding a transparent element makes it `hidden`
(its transparency is dropped); unhiding returns it to `normal` (not back to
transparent).

**Transition robustness is the requirement here** (user's explicit concern).
Make the manager **normalize-then-apply**: before applying any new state, fully
restore the element to base (original material reference + `visible = true`),
*then* apply the new state. That single rule guarantees clean transitions in
every direction — transparent→hidden→normal, transparent→normal,
hidden→transparent — with no leaked transparency-variant materials and no
double-applied overlays. One code path, no special-casing per transition.

### Reuse the highlight-variant trick for transparency
Materials are **shared by color** within a model (`ModelManager` materialCache),
so you cannot set `material.opacity` directly — it would fade every same-colored
element. `SelectionManager` already solves exactly this for highlighting:
per-mesh material clone, cached in a `WeakMap<Material, Material>` keyed by the
original, restored on clear. Transparency is the same pattern with
`{ transparent: true, opacity: 0.25 }` instead of an emissive boost — mirror
`highlightVariants` as `transparencyVariants`.

### The interplay risk (call out for review)
A mesh that is **both transparent and selected** needs both overlays. Define a
single resolution: AppearanceManager owns the *base-state* material (original or
transparent clone); SelectionManager's highlight derives its variant from
**whatever AppearanceManager currently left on the mesh**. When appearance
changes for a selected mesh, re-derive the highlight for those meshes. Keep one
clear precedence (`hidden > transparent > highlighted > base`) and a single
place that reconciles it. This is the main engineering risk — budget for it.

## Mechanics (cheap, reuses existing plumbing)

- **Element lookup** is already O(1): `ModelEntry.meshesByExpressId:
  Map<number, Mesh[]>`. Hide/transparent iterate the scope's meshes via this
  index — no scene traversal.
- **Hide** → `mesh.visible = false` + `viewer.requestRender()`.
- **Isolate(scope)** → set every element *not* in the scope to `hidden` (per
  model), scope elements to `normal`. (Implementation: hide all, then show the
  scope, recorded as one command.)
- **Show all** → clear all `hidden` entries.
- **Transparent** → transparency-variant material swap; **Make opaque** /
  **Clear transparency** → restore.
- **Render-on-demand**: every mutation calls `requestRender()` (same contract
  ModelManager.setVisible uses).

## Interactions to get right

- **Raycast / picking**: hidden meshes are auto-excluded — `raycastVisible`
  uses `scene.traverseVisible`. Transparent meshes **stay pickable** (you want
  to select them) — keep them visible, just faded.
- **Marquee classifier** (`MarqueeSelector.classifyMesh`) → skip hidden meshes.
- **Fit-to-view / bounding box**: `ModelManager.getBoundingBox` currently
  expands by the whole group regardless of element visibility. Make
  fit/`getBoundingBox` ignore hidden meshes so "fit" frames what's visible.
  (Verify Box3 behaviour and add a test.)
- **Model removal**: prune that model's appearance entries (mirror
  `SelectionManager.onModelRemoved` / `SelectionBasket.onModelRemoved`).
- **Session persistence** (A2, recommend yes): persist appearance overrides in
  the localStorage session state like the basket (`{ modelId, expressId,
  state }[]`), rehydrated after models restore, dropping entries whose model
  didn't return. Metadata only — cheap.
- **Undo** (built-in): each op pushes one `mementoCommand` whose before/after is
  the affected elements' prior/next appearance states (see
  `handoff-undo-redo.md`). Undoing "Isolate" restores the previous visibility of
  everything it hid, in one step.

## Surfaces

- **Context menu** (`handoff-context-menu.md`): Hide / Isolate / Show all /
  Make transparent / Make opaque.
- **Contextual tray** (`src/ui/ContextualActions.ts`), same idiom as "Remove
  clipping": **"👁 Show N hidden"** when anything is hidden; **"◐ Clear
  transparency"** when anything is transparent. Always-available recovery.
- (Optional) the inspector header could host the same verbs for the current
  selection — defer unless wanted.

## Files

| File | Change |
|------|--------|
| `src/viewer/AppearanceManager.ts` | NEW — state map, resolve, hide/show/isolate/transparent/opaque over a Scope, `onChange`, serialize/deserialize, `onModelRemoved`. |
| `src/inspector/SelectionManager.ts` | Coordinate highlight with appearance (re-derive highlight variant from the appearance-applied material). |
| `src/viewer/ModelManager.ts` | `getBoundingBox` ignores hidden meshes (fit-to-visible). |
| `src/inspector/MarqueeSelector.ts` | Skip hidden meshes in `classifyMesh`. |
| `src/core/App.ts` | Construct AppearanceManager; wire context-menu + tray actions; push undo commands; persist/restore; prune on model removal. |
| `src/styles.css` | Tray button styling (reuses existing). |

## Test plan

**Automated** (the state model is pure-ish; material/visibility assert against THREE meshes):
- `tests/element-appearance.test.ts` (NEW): hide sets `mesh.visible=false`;
  show-all restores; isolate hides the complement only; transparent swaps to a
  transparent clone and opaque restores the original reference; shared-color
  meshes don't cross-contaminate (the variant trick); state map CRUD +
  `onChange` (fires on mutate, not on no-op); serialize↔deserialize round-trip;
  `onModelRemoved` pruning; mutually-exclusive state transitions (hide a
  transparent element → hidden; unhide → normal).
- `getBoundingBox` ignores hidden meshes (extend `model-manager.test.ts`).
- Undo: hide N → undo restores visibility in one step (extend the history
  tests); isolate → undo restores prior per-element visibility.
- Highlight + transparency interplay: a selected, transparent mesh shows both;
  clearing transparency keeps the highlight; deselect keeps transparency.

**Manual smoke**:
1. Select several → context-menu Hide → they vanish; tray "Show N hidden"
   appears; click it → they return. Ctrl+Z also returns them.
2. Select one → Isolate → only it remains; Show all restores; Ctrl+Z restores.
3. Make transparent → see through to elements behind; same-colored elements
   elsewhere are unaffected; Make opaque / tray "Clear transparency" restores.
4. Select a transparent element → it still highlights; deselect → still faded.
5. Reload → hidden/transparent state restores after models load (if A2 = yes).
6. Hidden elements aren't pickable; transparent ones still are.

## Open decisions

- **A1 — one appearance system vs two managers.** Recommend **one** (above).
- **A2 — persist appearance across reload?** Recommend **yes** (rides the
  session state like the basket).
- **A3 — transparency opacity.** Recommend **0.25** (clearly see-through but
  still visible); make it a constant, tunable later via the settings panel.
- **A5 — isolate scope = selection only, or also "isolate this element's
  type/class"?** Recommend selection-only for v1; type/class isolate can ride
  on `select-similar` later.

## Confirmed (build to this)

- **A4 — mutually exclusive states.** One appearance state per element; a new
  op overrides the current one. No combined transparent+hidden. The manager
  normalizes to base before applying the new state, so transitions
  (transparent→hidden, etc.) are robust.
