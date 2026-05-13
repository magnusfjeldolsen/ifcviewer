# Phase — Clipping tool UX fix (direction + speed)

## TL;DR

Replace the hard-coded `screen-Y delta → plane-normal direction` mapping in `ClippingTool.onPointerMove` with **screen-space projection of the plane normal**, and replace the model-size-based `speed` heuristic with **perspective-aware world-units-per-pixel** at the handle's depth.

Net effect:
- **Horizontal clips no longer feel inverted** — dragging the gizmo in the direction the normal points on screen always pushes the plane forward along its normal, regardless of which axis the normal is on.
- **Cursor and plane move at the same speed** — drag the gizmo 100 px in screen space → the plane moves 100 px in screen space, at any camera distance.

Bonus: deletes the per-frame `scene.traverse` in `getModelSize()` (called from every `pointermove`), small perf win on big models.

Estimated effort: **~60 lines net change**, single PR. Pure math fix — no API change, no architectural shift.

---

## Why this matters

Roadmap card: `clipping-ux-papercuts` in `dev/plans/roadmap.md`.

Two distinct UX bugs reported by the user:

1. **Direction inverted on horizontal surfaces.** Clicking the top of a slab → plane normal points down (after the `.negate()` at line 124). Dragging the cursor down on screen makes the plane move *up* instead of *down* — the user expects the gizmo to follow the cursor visually.
2. **Speed mismatch.** The cursor moves N pixels but the plane moves M units, where N and M aren't consistent. Far camera → plane crawls behind cursor; close camera → plane flies away.

Both bugs originate in the same code block. One fix covers both.

---

## Root cause (in code)

### Bug A — direction inverted

**Location:** `src/tools/ClippingTool.ts:270-277`.

```ts
const deltaY = e.clientY - this.dragPrevY;          // +deltaY = cursor moved DOWN
const speed = this.getModelSize() * 0.002;
const movement = -deltaY * speed;                   // negate so down-drag pushes forward
this.clipPlane.constant -= movement;
```

The code assumes "screen-Y delta directly maps to plane-normal direction". That's only true when the plane normal is roughly orthogonal to screen-Y. For a horizontal slab clip (normal = ±Y world), the mapping is wrong.

Worked example:
- User clicks top of slab → `face.normal = (0, 1, 0)`.
- `ClippingTool.ts:124` does `.negate()` → `planeNormal = (0, -1, 0)`.
- Cursor moves down → `deltaY = +20`.
- `movement = -20 × speed` → negative value.
- `clipPlane.constant -= negative` → `constant` increases.
- `THREE.Plane`: distance from origin along normal is `-constant`. Bigger `constant` with `-Y` normal → plane is **higher** in world.
- User sees: cursor down, plane up. **Inverted.**

For vertical-wall clips, the same code "happens to work" because moving the cursor down typically means pushing the plane away from the viewer along a roughly-screen-Z direction — the sign convention happens to align.

### Bug B — cursor speed ≠ plane speed

**Location:** same block, line 274:
```ts
const speed = this.getModelSize() * 0.002;
```

`getModelSize()` returns the model's world-space diagonal — independent of camera distance. So pixels-to-world conversion is wrong unless the camera happens to be at "the right" distance. Worse, the scale changes with model size: a tiny model with a near camera will have one feel; a giant model with a far camera will have another.

The correct conversion at a perspective camera is **distance-dependent**:
```
worldPerPixel_at_depth_d = (2 × d × tan(fov/2)) / canvasHeight
```

Where `d` is the camera-to-handle distance.

### Removed: per-frame `getModelSize` traversal

`getModelSize()` at lines 308-318 walks the entire scene with `traverse`. Called from every `pointermove` while dragging. On a 100k-mesh model that's ~10 ms wasted per frame just to compute a constant that doesn't even need to change during a drag.

---

## Proposed fix

### The math

Given:
- Handle world position `H`.
- Plane normal `N` (unit vector in world space).
- Camera `C` (perspective).
- Canvas rect `(W, height)` in pixels.
- Cursor pixel delta `(ΔpxX, ΔpxY)` (screen pixels, +Y down).

Step 1: project `H` and `H + N` to NDC space, then to pixel offsets from the handle's screen position.
```
H_ndc  = H.project(C)
N_ndc  = (H + N).project(C)
N_px   = ( (N_ndc.x - H_ndc.x) × (W/2),
           -(N_ndc.y - H_ndc.y) × (height/2) )   // NDC-Y is flipped vs screen-Y
```

Step 2: normalize `N_px` to get the screen-space direction the normal points.
```
N_px_hat = N_px / |N_px|                    // edge case: |N_px| ≈ 0 → see below
```

Step 3: project the cursor delta onto that direction.
```
pixels_along_normal = (ΔpxX, ΔpxY) · N_px_hat
```

Step 4: convert pixels to world units using the perspective-aware factor at the handle's depth.
```
d                 = |C.position - H|
worldPerPixel     = (2 × d × tan(fovRad/2)) / height
worldDelta        = pixels_along_normal × worldPerPixel
```

Step 5: apply.
```
clipPlane.constant -= worldDelta
```

The sign: in `THREE.Plane`, signed distance from origin to plane along normal is `-constant`. Subtracting `worldDelta` (positive when cursor moves in the direction the normal points on screen) means the plane moves *forward along its normal*. That's the user expectation — drag in the direction of the visible arrow → plane moves in that direction.

### Edge case: normal parallel to view direction

If the user has clicked a surface whose normal points directly at the camera (e.g. a wall face dead-on), then `N` projects to a near-zero screen vector. `|N_px|` ≈ 0. Dividing by it gives garbage.

Guard: if `|N_px| < ε` (say `1e-3` in pixels), skip the move. The user can orbit slightly and try again. Document inline.

This is the same problem the user would have visually: you can't see the "depth" of a clip plane that's edge-on to the screen.

### Pure-function extraction (for tests)

Extract the math as a module-private pure function so it's testable without DOM:

```ts
// Inside ClippingTool.ts (or a new src/tools/clippingMath.ts if it grows):
export function computePlaneDelta(args: {
  handlePos: THREE.Vector3;
  planeNormal: THREE.Vector3;
  camera: THREE.PerspectiveCamera;
  canvasRect: { width: number; height: number };
  cursorDeltaPx: { x: number; y: number };
}): number {
  // returns worldDelta to subtract from clipPlane.constant.
  // returns 0 if normal projects to a near-zero screen vector.
}
```

Co-locating in ClippingTool.ts is fine for v1; only split into a new file if it grows or if other tools need it.

---

## Files to touch

| File | Change |
|------|--------|
| `src/tools/ClippingTool.ts` | (1) Replace `dragPrevY: number` field with `dragPrev: THREE.Vector2`. (2) Replace the drag math in `onPointerMove`. (3) Update `onPointerDown` to write both X and Y to `dragPrev`. (4) Delete `getModelSize()` method. (5) Add `computePlaneDelta` pure function (module-private export so tests can import). |
| `tests/clipping-math.test.ts` (NEW) | Pure-function tests for `computePlaneDelta`: covers all 6 axis-aligned normals on a perspective camera, the near-zero-projection guard, distance-invariance of the screen-to-world scale, sign convention. |
| `tests/clipping-tool.test.ts` (NEW or extend existing) | Optional jsdom test that drives a `pointerdown → pointermove → pointerup` sequence with stubbed deps and asserts `clipPlane.constant` moves in the expected direction. Skip if existing test infra in `tests/tool-manager.test.ts` doesn't easily extend; the pure-function tests are the primary safety net. |
| `dev/plans/roadmap.md` | Move `clipping-ux-papercuts` to Done section with the PR number and one-line outcome. |

**Files NOT to touch:**
- `src/utils/raycast.ts` — unrelated.
- `src/core/App.ts` — ClippingTool is constructed and disposed as today; no wiring change.
- `src/tools/Tool.ts` — interface unchanged.
- Anything in `src/inspector/` — unrelated.

---

## Step-by-step

1. **Confirm baseline green.** On main: `npm test`, `npm run lint`, `npm run typecheck` should all pass. If anything is red, STOP.
2. **Branch off main:** `git checkout main && git pull --ff-only && git checkout -b feature/clipping-ux-fix`.
3. **Extract `computePlaneDelta` first.** Add the pure function to `ClippingTool.ts` (module-private export). Write `tests/clipping-math.test.ts` against it. Get the tests green BEFORE wiring it into the tool. This is the safety net: even if the integration goes wrong, the math is provably correct.
4. **Update the field.** Replace `private dragPrevY = 0;` with `private dragPrev = new THREE.Vector2();`.
5. **Update `onPointerDown` (line 258).** Replace `this.dragPrevY = e.clientY;` with `this.dragPrev.set(e.clientX, e.clientY);`.
6. **Replace the drag block in `onPointerMove` (lines 270-282)** with the call into `computePlaneDelta` plus `clipPlane.constant -= worldDelta`. Update `this.dragPrev` to the current cursor position at the end of the block.
7. **Delete `getModelSize` (lines 308-318).** It has no other callers — verify via grep.
8. **Run the full test suite.** All existing tests must still pass; new pure-function tests must pass.
9. **Lint + typecheck.** Must be clean.
10. **Manual smoke** (see section below). The user runs this.
11. **PR** with title `Fix clipping tool: direction-aware drag + perspective-correct speed`. Body documents the bug, the math, and links the roadmap card.

Suggested commit shape: **one commit**. The fix is a small, atomic unit — splitting "extract pure function" from "wire it in" creates an intermediate state where neither code path works. Squash into one commit at the end if you used multiple WIP commits during development.

---

## Tests

### Pure-function tests (`tests/clipping-math.test.ts`)

All tests use a known camera setup:
```ts
const camera = new THREE.PerspectiveCamera(60, 16/9, 0.1, 100);
camera.position.set(0, 0, 10);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const canvasRect = { width: 1600, height: 900 };
```

Cases to cover:

1. **Vertical wall, normal +X**: handle at origin, normal = (1, 0, 0). Cursor moves +100 px in X → plane moves forward along +X. Assert `worldDelta > 0` and matches the perspective math within ε.
2. **Same wall, cursor moves -100 px in X** → `worldDelta < 0` (plane retreats).
3. **Wall, cursor moves +100 px in Y (cross-axis)** → `worldDelta ≈ 0` (cursor delta is orthogonal to the screen projection of the normal).
4. **Horizontal slab, normal +Y**: handle at origin, normal = (0, 1, 0). Cursor moves +100 px in Y (screen down) → because screen-Y is flipped, the normal projects in -Y_screen direction; cursor +Y_screen and normal -Y_screen are anti-parallel → `worldDelta < 0` (plane retreats). Cursor -100 in Y (screen up) → `worldDelta > 0`. **This is the bug the user observed; pre-fix code would have inverted this.**
5. **Horizontal slab, negated normal (0, -1, 0)** — the actual runtime state after `placeNormal.negate()` — cursor moves down on screen → plane moves down in world. Assert sign.
6. **Wall at angle (normal in XY plane, e.g. (0.707, 0.707, 0))**: cursor delta in the matching diagonal moves the plane proportionally; cursor delta in the orthogonal diagonal does not.
7. **Normal parallel to view direction (e.g. (0, 0, 1) with camera looking down -Z at the origin)**: projection length ≈ 0. Function returns 0. No NaN.
8. **Distance invariance**: move camera from `z=10` to `z=20`. The same 100-pixel cursor delta should produce twice the world delta (because each pixel covers twice as much world at twice the distance). Assert the ratio.
9. **FOV invariance**: change `camera.fov` from 60 to 30 (narrower). At the same camera distance, 100 px should cover less world distance (the narrower FOV means each pixel sees less world). Assert the ratio.

Each test: ~10 lines, ~30 total tests added. Cheap, fast, deterministic.

### Existing test impact

There's no existing ClippingTool unit test that I can find — `tests/tool-manager.test.ts` tests the ToolManager registration pattern, not ClippingTool internals. So no existing tests need updating.

Run `grep -r "ClippingTool" tests/` before starting to confirm.

### Integration test (optional, skip if jsdom infra is awkward)

`tests/clipping-tool.test.ts`:
- Mount a fake canvas, camera, scene with a single mesh.
- Activate ClippingTool, simulate `pointerdown` on a face, then `pointermove` events.
- Assert that `clipPlane.constant` changes monotonically as the cursor moves in the direction of the normal's screen projection.

If this is harder than ~50 lines, defer — the pure-function tests already cover the math. The manual smoke test is the integration backstop.

---

## Manual smoke tests

Run after dev server is up. Load any IFC (RIB.ifc is convenient because it has both walls and slabs).

### Bug A — direction (horizontal surface)

1. Click the toolbar clipping tool (✂). Cursor turns to crosshair.
2. Click on the **top of a slab** (horizontal surface, normal points up).
3. The clipping plane appears with the arrow gizmo pointing **down** (camera-facing side gets clipped).
4. Drag the gizmo **down** on screen. **Plane moves down** in world. Slab visibly gets sliced lower.
5. Drag the gizmo **up** on screen. **Plane moves up** in world.
6. Repeat with the **bottom of a slab** (normal points down). After negation, plane normal points up.
7. Drag up → plane moves up. Drag down → plane moves down.

Pre-fix behavior: in steps 4 and 7, the plane would have moved in the *opposite* direction of the cursor.

### Bug A — direction (vertical surface, regression)

8. Press `C` to re-enter placement mode.
9. Click on a **wall** (vertical surface).
10. Drag the gizmo in the direction the arrow points → plane moves that way. Same as before this fix — verify there's no regression on the case that was already working.
11. Drag opposite of the arrow → plane retreats.

### Bug A — direction (angled surface)

12. Press `C`. Click on a **diagonal beam** (face normal is in 3D).
13. The arrow gizmo points in the direction of the face normal (post-negate).
14. Drag in the direction of the arrow → plane moves that way.
15. Drag perpendicular to the arrow → plane should barely move (cursor delta is orthogonal to the normal's screen projection).

### Bug B — speed

16. With a plane placed, zoom the camera **way out** (mouse wheel). Drag the gizmo. The plane should move at the **same screen-pixel rate as the cursor** — drag 200 px on screen, the plane visibly shifts roughly 200 px on screen. Not 10 px, not 1000 px.
17. Zoom the camera **way in** (close to the model). Drag the gizmo. **Same screen-pixel rate.** The plane shouldn't crawl or fly away.
18. Try a model with different units (e.g. one in mm, one in m). Pre-fix, this would dramatically change the feel because `getModelSize()` returned the unit-dependent bbox diagonal. Post-fix, the feel is unit-agnostic — only screen pixels matter.

### Edge case — normal parallel to view

19. Orbit the camera so you're looking dead-on at a wall (the wall's normal points directly at the camera).
20. Press `C`. Click on that wall. Plane is placed.
21. Try to drag the gizmo. The plane should **not move** (projection length ≈ 0, function returns 0). No NaN, no crash.
22. Orbit slightly so the normal has some screen-space direction. Now dragging works normally.

### Regression — placement still works

23. Press `C`. Click on a different surface. The new plane replaces the old one. No leak (old handle gone).
24. Press the toolbar ✂ button (deactivate). Plane and handle persist (existing behavior).
25. Reset View button → plane and handle clear (existing behavior).

### Performance — no `getModelSize` lag

26. On a large model (100k+ meshes), drag the gizmo. Should feel smooth — no per-frame scene traversal stutter. Pre-fix, every pointermove triggered a `scene.traverse` over the whole model.

### Console

27. Throughout: no red errors, no NaN warnings.

---

## Out of scope (future tickets)

These are real follow-ups that the user mentioned or that surfaced during the investigation. None block this fix.

1. **Direction-aware cursor hint.** Currently always `ns-resize`. Should compute from the projected `screenDirPx` angle and pick from `ns-resize` / `ew-resize` / `nesw-resize` / `nwse-resize`. Small UX polish, ~15 lines.
2. **Click-vs-drag threshold.** Today any pointermove during the drag state moves the plane. A 3 px threshold (matching `MeasurementTool` and `MarqueeSelector`) would prevent accidental nudges when the user clicks the gizmo without intending to drag. Same pattern, ~10 lines.
3. **Snap-to-axis modifier.** Hold `Shift` to constrain the plane to discrete steps (1 mm / 10 mm / 100 mm — adaptive to model unit). Useful for engineering. Future.
4. **Multi-plane clipping.** Support for two clip planes at once (e.g. slice both a top and bottom). Renderer already supports `clippingPlanes: Plane[]`. UI needs to grow.
5. **Section box.** Six clip planes forming a box. Significant UI work; consider for the "Red phase" of development per CLAUDE.md.

Tickets 1 and 2 are small enough to do in the same PR if the user wants — flag during smoke and we'll decide.

---

## Definition of done

- Both bugs fixed: horizontal-surface direction correct, drag speed matches cursor.
- Pure-function `computePlaneDelta` exists with ≥ 8 test cases covering the cases listed above.
- All existing tests still pass; new tests pass; lint + typecheck clean.
- Manual smoke checklist executed by the user.
- `getModelSize()` removed; verified no other callers.
- PR opened, CI green, user-approved before merge.
- Roadmap card `clipping-ux-papercuts` moved to **Done** with PR # and a one-line outcome.
