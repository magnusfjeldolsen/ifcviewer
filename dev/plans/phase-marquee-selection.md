> **Status: SHIPPED — historical design record.**
> Landed as PR #21 (2026-05-13). Kept because the reasoning is still the best
> explanation of *why* `MarqueeSelector` is built the way it is — in
> particular the decision to copy three's `SelectionBox` frustum construction
> while rejecting its bounding-sphere-centre test, which survives verbatim at
> `src/inspector/MarqueeSelector.ts:392`.
>
> **This is the pre-implementation design, not a record of what shipped.**
> Three things changed during manual smoke and are recorded in the roadmap's
> Done entry, not here: the stock `SelectionBox` far-plane normal flip, the
> `applyMany` lock asymmetry, and the per-frame render lag on big models that
> was deferred to `render-perf-orbit-lag`. Read the roadmap entry for the
> outcome; read this for the rationale.

---

# Phase — Alt-Drag Marquee Selection (window + crossing)

## TL;DR

Add **Alt+drag** marquee selection to the IFC viewer following the AutoCAD convention:
- **Right-to-left drag** = **crossing** selection (any element whose AABB intersects the 3D screen-frustum prism is selected). Green dashed marquee.
- **Left-to-right drag** = **window** selection (only elements fully inside the prism). Blue solid marquee.
- Direction-aware live color switching as the cursor crosses the start X.
- Modifier composition: `Alt` = replace, `Alt+Ctrl` = add, `Alt+Shift` = remove.
- Respects visibility: hidden models, partially-clipped elements are handled correctly.
- Builds on Phase 4's multi-select / intersection infrastructure — no new selection model.

Estimated complexity: **medium** (~1–2 days end-to-end, ~250 lines of new code + ~50 lines test + ~30 lines CSS + a 3-line API extension on `SelectionManager`).

**End goal:** users can pick large sets of elements with one gesture instead of N ctrl-clicks. This is the natural precursor to the future filter / aggregation workflows.

---

## Goal

When the user holds `Alt` and drags the left mouse button across the canvas:

1. A marquee rectangle overlay appears anchored to the cursor.
2. Drag direction determines mode (live update as cursor crosses start X):
   - Right → left = **crossing** (green dashed) — every element whose world-space AABB intersects the screen-rectangle's 3D frustum prism.
   - Left → right = **window** (blue solid) — every element whose world-space AABB has all 8 corners inside the prism.
3. On release, modifier composition decides `replace` / `add` / `remove` and calls `SelectionManager.applyMany(mode, identities[])`.
4. `Esc` during the drag dismisses the marquee with no selection change.

Selection respects:
- **Tool activity** — marquee bails when any tool is active or pivot-picking is on (consistent with single-click selection).
- **Clipping planes** — elements whose AABB is entirely on the cut-side of any active clip plane are excluded; partially-clipped elements remain selectable.
- **Hidden models** — `entry.visible === false` skips that model entirely.
- **Single-model-lock (Phase 4)** — when on, the result is constrained to the **first model the marquee hits** (in `ModelManager.getAllModels()` iteration order).

---

## Background & motivation

Phase 4 of the inspector landed multi-element selection via modifier-key clicking (`ctrl+click` add, `shift+click` remove). Real-world AEC workflows routinely need to pick **all walls in a storey** or **all elements in a façade** — N modifier-clicks doesn't scale.

The natural AEC interaction for this is the AutoCAD marquee. Same gesture exists in every CAD/BIM tool the user is likely to bring expectations from (Revit, ArchiCAD, Rhino, SketchUp, AutoCAD).

The future filter / aggregation features will *also* benefit: a user marquees a set of walls, opens the inspector, sees aggregate statistics. Marquee is a substrate, not just a UX nicety.

---

## Key technical findings (from research)

1. **Three.js's `SelectionBox` is not directly usable.** It tests only the bounding-*sphere center* inside the frustum (`SelectionBox.js:294-304`), which is neither true crossing nor true window. A tall wall with center outside a small marquee would be missed; a slab whose center sits inside the marquee but extends far outside would be incorrectly selected.

2. **`SelectionBox`'s frustum-construction technique is usable.** ~30 lines of NDC corner unprojection + 6-plane construction via `setFromCoplanarPoints`. We copy this verbatim.

3. **`SelectionHelper` is not usable as-is.** Hijacks every `pointerdown` (no Alt gating), no live class switching, would contend with OrbitControls and existing tools. We replicate the ~15 lines of DOM-div positioning logic in our own module.

4. **Three.js core gives us all the math primitives.** `Frustum.intersectsBox(box)` for crossing, manual 8-corner `Frustum.containsPoint` for window. Both fast (~50–300 FLOPs per element).

5. **Performance is fine at IFC scale.** ~10 ms for 50k meshes after a one-line `geometry.computeBoundingBox()` added to `ModelManager.addModel`. The ceiling is actually the existing emissive-highlight clone path (could lag at thousands of selected elements) — separate optimization for a future PR if needed.

6. **OrbitControls vs marquee** — we register our `pointerdown` with `{ capture: true }` so it runs ahead of OrbitControls in the bubble phase. We also call `viewer.setControlsEnabled(false)` during the drag for belt-and-braces.

7. **`SelectionManager.apply` only takes one identity.** Need to add `applyMany(mode, identities[])` — pure additive API, no existing test breaks.

---

## Confirmed scope decisions

| Decision | Choice |
|----------|--------|
| Tool composition | **Bail** — marquee silently no-ops when any tool is active or pivot-picking is on |
| Single-model-lock + marquee | **Keep only the first model the marquee hits** (in `ModelManager.getAllModels()` iteration order) |
| Clipping respect | **Yes** — exclude elements whose AABB is entirely on the cut-side of any active clip plane; partially-clipped elements stay selectable |
| Visual style | **AutoCAD convention** — blue solid window, green dashed crossing; live color flip as cursor crosses startX |
| `applyMany` API | **New method** on `SelectionManager` (not broaden `apply`) — preserves existing test impact |
| `applyMany('add')` semantics | **Always add**, never toggle — CAD-standard batch behavior |
| Window-mode geometry test | **8-corner AABB inside test** — conservative (rotated meshes' AABBs overstate footprint, so window mode may be slightly under-permissive). Per-vertex refinement deferred to v2 |
| Pre-compute bounding boxes | **Yes** — one line in `ModelManager.addModel` for predictable timing |
| Alt-click without drag | **No-op** — falls through to single-click `replace` (current behavior unchanged) |
| Soft cap boundary | **Stays in the panel** — SelectionManager stores all N; InspectorPanel renders "refine selection" if N > 1000 |

## Out of scope (v2+)

- Per-vertex refinement for rotated meshes in window mode (conservative AABB test accepted for v1).
- BVH / spatial index (current scale doesn't need it).
- Instanced / batched mesh handling (we don't ship instancing yet).
- Marquee on touch / mobile (only mouse-based modifier semantics; touch needs a different gesture).
- The emissive-highlight performance optimization for huge selections (separate PR if profiling demands).

---

## Architecture

### New file: `src/inspector/MarqueeSelector.ts` (~250 lines)

```ts
export interface MarqueeSelectorDeps {
  viewer: Viewer;
  modelManager: ModelManager;
  toolManager: ToolManager;
  selectionManager: SelectionManager;
  canvas?: HTMLCanvasElement;     // test override
}

type DragState =
  | { kind: 'idle' }
  | { kind: 'pending'; pointerId; startNDC; startClient; modifiers }
  | { kind: 'dragging'; pointerId; startNDC; startClient; currentNDC; modifiers;
      direction: 'window' | 'crossing'; marqueeEl };

export class MarqueeSelector {
  constructor(deps: MarqueeSelectorDeps);
  dispose(): void;

  // event handlers (private)
  private onPointerDown(e: PointerEvent): void;
  private onPointerMove(e: PointerEvent): void;
  private onPointerUp(e: PointerEvent): void;
  private onKeyDown(e: KeyboardEvent): void;
}

// Exported pure functions for unit-test isolation
export function buildSelectionFrustum(startNDC, endNDC, camera, deep): THREE.Frustum;
export function classifyMesh(mesh, frustum, tmpBox): 'crossing' | 'window' | 'outside';
export function bucketResults(classified, mode): ElementIdentity[];
```

State machine:
- `idle` → on Alt+pointerdown, transitions to `pending`. Capture-phase listener wins over OrbitControls. Stops propagation.
- `pending` → on pointermove with movement ≥ 3px CSS pixels, transitions to `dragging` and creates marquee DOM div.
- `pending` → on pointerup with movement < 3px, transitions to `idle` silently (the user clicked, not dragged; SelectionManager's normal click handler picks it up).
- `dragging` → on pointermove, updates marquee dims + direction (live class flip).
- `dragging` → on pointerup, builds frustum, classifies all meshes, calls `selectionManager.applyMany(mode, identities[])`.
- `dragging` → on Esc keydown (capture-phase listener installed during drag only), cancels with no selection change.

### Touched: `src/inspector/SelectionManager.ts` — new `applyMany` method

```ts
applyMany(mode: SelectionMode, identities: readonly ElementIdentity[]): SelectionState
```

- `replace` with `[]` → clears.
- `replace` with N → clear, then add each (dedup within batch).
- `add` with N → for each: if not in selection, add. Never toggle.
- `remove` with N → for each: if in selection, remove.
- Single-model-lock collapse rule: when `singleModelLock === true` AND a multi-select would span multiple models, **keep only the elements belonging to the first model the batch references** (i.e. iterate the batch, take the first identity's `modelId`, filter the batch to that model). Document this in the JSDoc.
- Emits `onChange` **once** per call (not per identity).

### Touched: `src/viewer/ModelManager.ts` — one line

```ts
// In addModel, after geometry.setIndex(...):
geometry.computeBoundingBox();  // Required for fast marquee selection; small one-time cost.
```

### Touched: `src/viewer/Viewer.ts` — new accessor

```ts
setControlsEnabled(enabled: boolean): void {
  this.controls.enabled = enabled;
}
```

Used by MarqueeSelector to pause OrbitControls during a drag.

### Wiring in `src/core/App.ts`

After `selectionManager` construction:
```ts
this.marqueeSelector = new MarqueeSelector({
  viewer: this.viewer,
  modelManager: this.modelManager,
  toolManager: this.toolManager,
  selectionManager: this.selectionManager,
});
```

And `marqueeSelector.dispose()` in `App.dispose()`.

### CSS additions in `src/styles.css`

```css
.marquee-window {
  position: fixed;
  pointer-events: none;
  background: rgba(50, 130, 255, 0.08);
  border: 1.5px solid rgba(50, 130, 255, 0.65);
  z-index: 100;
}
.marquee-crossing {
  position: fixed;
  pointer-events: none;
  background: rgba(0, 200, 0, 0.08);
  border: 1.5px dashed rgba(0, 180, 0, 0.7);
  z-index: 100;
}
```

---

## Algorithm

### Frustum construction (copied technique from `SelectionBox.js:158-200`)

```
1. Normalise rectangle in NDC: tl, tr, br, bl from min/max of start/end.
2. near = camera world position (setFromMatrixPosition).
3. Unproject the 4 NDC corners through the camera → tl/tr/br/bl in world.
4. Build far face: far_tl = (tl − near).normalize() × deep + near. Same for tr, br.
5. Build 6 Three.js Plane objects via setFromCoplanarPoints.
   - planes[0..3] = side faces
   - planes[4] = near face
   - planes[5] = far face (with normal multiplied by -1, winding gives inward)
6. Return new Frustum().
```

`deep` = `Math.max(camera.far, sceneBox.getSize().length() * 2)` — explicit to avoid the `Number.MAX_VALUE` precision quirk in `SelectionBox`.

### Per-mesh classification

```
function classify(mesh, frustum, clipPlanes, tmpBox):
  if mesh.geometry.boundingBox === null:
    mesh.geometry.computeBoundingBox()   // fallback if not pre-computed
  tmpBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld)

  # Clipping respect: any plane that fully clips this AABB → reject.
  for plane in clipPlanes:
    if all 8 corners of tmpBox have plane.distanceToPoint(corner) < 0:
      return 'outside'

  # Frustum tests.
  if not frustum.intersectsBox(tmpBox):
    return 'outside'

  # Window: all 8 corners inside the frustum.
  if all 8 corners of tmpBox are inside the frustum (containsPoint × 8):
    return 'window'

  return 'crossing'
```

### Mesh filtering — what we walk

Iterate `modelManager.getAllModels()` directly. For each entry:
- Skip if `entry.visible === false`.
- For each child mesh:
  - Skip if `!(child instanceof THREE.Mesh)`.
  - Skip if `typeof child.userData.expressID !== 'number'`.
  - Skip if `!child.visible`.

This naturally excludes pivot markers, clip helpers, measurement markers (they live on the scene root, not inside a model group).

### Element-level dedup

A single IFC element can have multiple meshes (e.g., a wall with two render geometries) sharing one `expressID`. Build a per-element bucket:

```ts
type Bucket = { all: number; window: number; touches: number; sample: ElementIdentity };
const buckets = new Map<string, Bucket>(); // key = `${modelId}:${expressId}`
```

Final filter:
- **Crossing mode**: include if `bucket.touches > 0` (any mesh touches).
- **Window mode**: include if `bucket.window === bucket.all` AND `bucket.all > 0` (all meshes fully inside).

Each surviving bucket contributes one `ElementIdentity`.

---

## Interaction details

### Modifier composition

| Modifiers           | Mode      |
|---------------------|-----------|
| Alt                 | `replace` |
| Alt + Ctrl (or Cmd) | `add`     |
| Alt + Shift         | `remove`  |
| Alt + Ctrl + Shift  | `remove`  (shift wins, matches existing single-click `pickMode`) |

Modifier state is locked at `pointerdown` — if the user releases Alt mid-drag we still complete the marquee (matches AutoCAD).

### Click-vs-drag threshold

3 CSS pixels — same constant as `MeasurementTool.CLICK_THRESHOLD`. Alt-pointerdown with movement < 3px → marquee never appears; SelectionManager handles it as a normal click (Alt is ignored in `pickMode`, so Alt-click acts as `replace`).

### OrbitControls coordination

- Register `pointerdown` with `{ capture: true }` so we run ahead of OrbitControls.
- When Alt is held, `event.preventDefault()` + `event.stopPropagation()` + `viewer.setControlsEnabled(false)`.
- On pointerup or Esc, `viewer.setControlsEnabled(true)`.

### Cursor

`cursor: crosshair` on the canvas during drag, reset on pointerup or Esc.

### Esc handling

A capture-phase `keydown` listener on `window` is installed when transitioning to `dragging`, removed on pointerup or Esc. It:
- Cancels the drag.
- `event.stopPropagation()` so the global Esc shortcut (`App.setupKeyboardShortcuts`) doesn't also fire.

---

## Implementation phases

This is a single coherent feature; one PR. Internal steps in commit order:

1. Confirm baseline green on main (`d8c6ec9` post-refactor).
2. Branch off main: `feature/marquee-selection`.
3. Touch: `Viewer.setControlsEnabled` + `ModelManager.addModel` precompute bounding box + `SelectionManager.applyMany` with tests.
4. New: `MarqueeSelector` module — pure functions first (`buildSelectionFrustum`, `classifyMesh`, `bucketResults`) + their tests.
5. New: `MarqueeSelector` event handlers + DOM marquee div + tests (jsdom event-driven).
6. Wire into `App` + CSS additions.
7. Full verification (test + lint + typecheck).
8. Manual smoke handoff.
9. PR to main.

One commit per logical step is fine — or three commits (API touches, MarqueeSelector module, wiring + CSS).

---

## Testing strategy

### Unit tests — pure functions

`tests/marquee-frustum.test.ts`:
- `buildSelectionFrustum` produces 6 planes for a known camera + NDC rectangle.
- Center point of rectangle at near distance is inside the frustum.
- Point clearly outside is outside.
- Right-to-left and left-to-right input give the same frustum.
- Zero-width rectangle handled gracefully.

`tests/marquee-classify.test.ts`:
- `classifyMesh` returns `outside` when AABB is wholly outside.
- Returns `crossing` when AABB straddles a side plane.
- Returns `window` when AABB is wholly inside.
- Respects `mesh.matrixWorld` transform (translate a mesh past the marquee).
- Returns `outside` when AABB is fully clipped by a passed-in clip plane.
- Returns the original classification when AABB straddles a clip plane.

`tests/marquee-bucket.test.ts`:
- Crossing mode: returns elements with any touching mesh.
- Window mode: returns only elements where all meshes are fully inside.
- Dedupes by `(modelId, expressId)`.
- Empty input → empty output.

### Integration tests — event-driven (jsdom)

`tests/marquee-selector.test.ts`:
- Alt+pointerdown with no movement → no commit.
- Alt+drag right-to-left → calls `applyMany('replace', [...])` with crossing-mode result (stubbed classifier).
- Alt+drag left-to-right → window mode.
- Alt+Ctrl-drag → `applyMany('add', ...)`.
- Alt+Shift-drag → `applyMany('remove', ...)`.
- Non-Alt drag → no marquee, no `applyMany`.
- Sub-3px movement → no marquee.
- Esc during drag → no commit; marquee div removed.
- Marquee bails when a tool is active.
- Marquee bails when pivot-picking is on.
- Hidden model excluded from results.
- Marquee div className flips live as cursor crosses startX.
- `dispose()` removes all listeners.

### `applyMany` tests

Extend `tests/inspector-selection.test.ts`:
- `replace` with empty array → clears.
- `replace` with one identity → equivalent to `apply('replace', id)`.
- `replace` with N → all N selected.
- `add` with N → no toggling; duplicates within batch deduped.
- `remove` with N → only intersection removed.
- `singleModelLock=true` + multi-model batch → keeps only first-model items.
- Emits `onChange` exactly once per call.

### Manual smoke checklist (for the PR)

1. Load a multi-storey IFC. Alt-drag left-to-right covering the whole storey from upper-left to lower-right. Confirm only fully-enclosed elements selected; marquee blue solid.
2. Same model, Alt-drag right-to-left. Confirm partially-clipped elements also included; marquee green dashed.
3. Alt-drag, release on canvas outside model → marquee dismissed; replace-empty clears selection.
4. Alt+Ctrl-drag adds to existing selection.
5. Alt+Shift-drag removes from existing selection.
6. Esc during drag dismisses with no selection change.
7. Esc after drag clears selection (existing Phase 2 behavior).
8. Drag direction changes live: cross startX → marquee color flips.
9. With section cut active, marquee a wall that's half cut → element is selected (visible part included).
10. With section cut active, marquee an element fully on the cut-side → element NOT selected.
11. With single-model-lock ON, marquee covering both A and B → only A selected (first model hit).
12. With single-model-lock OFF, marquee covering both A and B → both selected.
13. Clipping tool active → Alt-drag does nothing.
14. Measurement tool active → Alt-drag does nothing.
15. Pivot picking active → Alt-drag does nothing.
16. Performance: model with ~10k elements, marquee covering all → release-to-highlight latency feels instant.
17. Inspector panel updates to "N elements selected" after marquee commit.
18. Inspector panel renders "refine selection" message if marquee selects > 1000 elements (soft cap).

---

## Open items / future enhancements

1. **Per-vertex window-mode refinement** for rotated geometries — accept conservative AABB test for v1; revisit if user feedback demands.
2. **Emissive-highlight performance** at thousands of selected elements — separate optimization PR if profiling shows the cost.
3. **Touch / mobile** — marquee currently mouse-only. Touch needs a different gesture (two-finger?). Defer.
4. **InstancedMesh support** — only relevant if/when we move to instanced rendering for performance. Flag for later.
5. **Crossing-mode geometry refinement** — current crossing test uses AABB; could refine to per-triangle for tight geometries. Costly, defer.

---

## Definition of done (v1)

- Alt+drag right-to-left selects crossing-mode elements (any AABB touches frustum).
- Alt+drag left-to-right selects window-mode elements (all AABB corners inside frustum).
- Marquee color flips live based on direction.
- Alt+Ctrl-drag adds; Alt+Shift-drag removes.
- Esc during drag cancels cleanly.
- Marquee bails when any tool / pivot-picking is active.
- Marquee excludes fully-clipped-away elements but includes partially-clipped ones.
- Marquee excludes hidden models.
- Single-model-lock collapses cross-model marquees to first-model-hit.
- All vitest tests pass; lint + typecheck clean.
- Manual smoke checklist executed.
- PR opened, CI green, user-approved before merge.
