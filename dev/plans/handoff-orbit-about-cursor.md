# Orbit + zoom about the cursor

## Goal

Rotate and zoom about **what is under the cursor**, the way CAD tools do.
Cursor over geometry → that surface point is the centre. Cursor over empty
space → fall back to something sane, never a point far off in the distance.

And, from manual testing: **placing a pivot must never re-centre the view** —
not when it is placed, and not on the first orbit afterwards.

## Decisions (confirmed with the user, 2026-08-19)

1. **Raycast on orbit *and* on zoom.** Once per gesture — at rotate-drag start,
   and per wheel event — not per mouse-move.
2. **The placed pivot is remembered until a new one is placed.** A
   cursor-orbit is transient (that drag only). Pan does not change it.
3. **Zoom to cursor: yes**, same rule as orbit.
4. **The explicit pivot tool stays.** It is the empty-space fallback and the
   "lock onto this detail" gesture, which cursor-orbit cannot express.

Settled 2026-08-24:

5. **CLAUDE.md**: retire the "Deferred State Application" section, keep the
   lesson (see *Consequence for CLAUDE.md*).
6. **Touch**: hand rotate back to OrbitControls via `mouseButtons.LEFT = null`;
   own the pinch (see *What we take over from OrbitControls*).

## Root cause of the re-centre (investigated)

`OrbitControls.target` is overloaded: it is both *the orbit centre* and *the
point the camera looks at*. `update()` ends with `camera.lookAt(target)` every
frame.

`placePivot()` (`src/viewer/Viewer.ts`) stores the pivot **in
`controls.target`**. That is the whole bug. The existing mitigation only moves
the symptom in time:

```
placePivot → controls.target = point
           → _controlsMode = 'pivot-transition'
           → animate() skips controls.update()   ← no snap yet
first drag → 'start' event → mode = 'user'
           → controls.update() resumes
           → camera.lookAt(pivot)                ← the snap, now
```

`dev/plans/fix-pivot-no-recenter.md` called this out and accepted it: *"The
brief reorientation on first interaction is masked by the user's own drag
gesture."* It is not masked — it is exactly the "camera moves and centers
around pivot point at first orbit" behaviour being reported.

**So the fix is not a better deferral. The pivot has to stop living in
`controls.target` at all.**

## Prior art (researched 2026-08-24)

Checked how mature tools solve this. Inspiration, not imitation — but three of
these findings changed the design below.

- **Navisworks** — the closest precedent, and it validates the two-point model.
  The pivot is first-class, *visible* and lockable: unlocked, "the pivot point
  is set at the position of the cursor, and changes dynamically as you move";
  `Ctrl+L` locks it; `Ctrl+drag` re-places a locked one. It also **auto-unlocks
  the pivot when it moves off-screen**, and can set the pivot from the current
  selection (`Center Pivot on Selection`). Both are adopted below.
- **Revit / Inventor** — pivot defaults to the view's target point; selection
  extents define it when asked; orbit is upright-constrained ("Keep Scene
  Upright") unless Shift rolls it. Our azimuth-about-world-up with a clamped
  polar matches this default.
- **ArcGIS Pro** — the clearest statement of the empty-space problem:
  navigation "relies on a 3D location—either on the surface or on a feature—to
  provide a control point", and *"You cannot click the sky to navigate because
  the tool cannot determine how far away you want to go."* Nobody solves empty
  space; everybody falls back. Our fallback ladder is the right shape.
- **SketchUp** — orbits about the view centre only; "orbit around cursor" has
  been a standing feature request for years. Evidence this is the
  differentiator, not a nicety.
- **Blender** — splits the behaviour into three prefs (Orbit Around Selection,
  Auto Depth, Zoom to Mouse Position). **Auto Depth uses the depth under the
  pointer for pan, rotate *and* zoom** — hence the pan change below. Its
  documented "viewport wall" (zoom decelerating toward an invisible pivot until
  "movement appears to stop entirely") is exactly the bug an earlier draft of
  the zoom design here had; see *Zoom*.

## Design

### Two separate points

| | what it is | who moves it |
|---|---|---|
| `controls.target` | a **view anchor** — always a point on the camera's forward axis, kept there so `lookAt(target)` is permanently a no-op | us, on every gesture |
| `pivot` (new field) | the **rotation centre** — anywhere in space, marked by the pivot sphere | `placePivot`, `resetPivot` |

Once `controls.target` is only ever on the view axis, OrbitControls can never
re-orient the camera, and the `pivot-transition` mode has nothing left to defer.

### Rotation without a snap

Rotate the camera position **and** the view anchor about the pivot by the same
rotation `R`:

```
camera.position = R·(camera.position − pivot) + pivot
controls.target = R·(controls.target − pivot) + pivot
```

Because the anchor was on the forward axis at distance `d` and both points get
the same rigid rotation, the rotated anchor is still on the new forward axis at
distance `d`. `lookAt(target)` is therefore already satisfied — no snap, exactly
the framing the user had, orbiting about the point they pointed at.

`R` is built from the drag delta the same way OrbitControls does it: azimuth
about world-up, polar about the camera's right vector, with the polar angle
clamped so the view cannot flip over the pole. Upright-constrained, matching the
Autodesk default.

### Which pivot, per gesture — the fallback ladder

```
rotate-drag start / wheel:
  raycast under the cursor
    hit                          → pivot = hit.point   (transient, this gesture)
    miss → placed pivot, if set and on-screen
         → selection centre, if there is a selection
         → defaultTarget (fit centre)
```

Two rungs come from the prior art:

- **On-screen check** (Navisworks' auto-unlock). A placed pivot that has drifted
  out of the frustum makes orbit feel like it is rotating about nothing. Test it
  against the frustum and fall through if it is outside — but keep it *stored*,
  so it applies again as soon as it is back in view.
- **Selection centre** (Revit/Navisworks `Center Pivot on Selection`). We already
  track the selection, so this is nearly free and is almost always what the user
  means when they orbit over empty space with something selected.

The placed pivot is never *overwritten* by a cursor-orbit, and pan never touches
it — decision 2 holds.

### Zoom

Dolly the camera toward the raycast hit along the cursor ray. The step is
**geometric** — multiply the distance-to-hit by a constant factor per notch —
with the distance re-derived from *this event's* raycast every time.

Not linear-in-remaining-distance. That is Blender's "viewport wall": the
increments shrink until movement stops entirely, and the user is stranded short
of the surface. Geometric stepping decelerates in absolute terms (it reads as
braking at the surface) but never asymptotes to zero, and the per-event raycast
is what lets it recover when the cursor moves onto something nearer or further
— that is precisely the job Auto Depth does in Blender.

Guard the near plane so a fast scroll cannot land the camera inside geometry.
No hit → dolly along the cursor ray toward the fallback pivot. The view anchor
moves with the camera so it stays on the forward axis.

Three's built-in `zoomToCursor` is deliberately **not** used: it dollies along
the screen ray with no knowledge of the surface, so it neither brakes at the
surface nor agrees with the pivot rule the orbit uses.

### Pan — a risk the two-point split introduces

OrbitControls pans at the *target's* depth. Today that target sits on geometry
after a fit or a pivot placement, so pan speed is about right. Once the target
becomes a free-floating view anchor, its distance is whatever the last rotate
left it at, and pan speed can decouple from what the user is looking at.

So: re-derive the anchor's distance from a cursor raycast on pan as well
(Blender's Auto Depth applies to pan for the same reason). Pan still does not
touch the pivot.

### Feedback

Navisworks and Revit both show the pivot. We already have the sphere: flash it
at the transient cursor pivot for the duration of the drag, then fade. It makes
"what am I rotating about" answerable without documentation, and it is the
cheapest UX win in the feature.

### What we take over from OrbitControls

- **Mouse rotate → ours.** `controls.mouseButtons.LEFT = null` takes the mouse
  away and leaves `controls.touches.ONE` untouched, so one-finger touch rotate
  keeps working with zero extra code. Do **not** use `enableRotate = false` —
  that kills touch too.
- **Zoom → ours.** `enableZoom` is shared by the wheel *and* the pinch, so
  turning it off to take the wheel silently degrades two-finger touch to
  pan-only. Set `enableZoom = false` and implement pinch in our own handler,
  reusing the dolly math: it aims at the **midpoint of the two fingers**, which
  is the correct behaviour and consistent with the rest of the feature.
  (Rejected alternative: keep `enableZoom` true and steal only the wheel with a
  capture-phase listener that `stopPropagation()`s before OrbitControls sees it.
  It works, but it depends on how three attaches its listeners — fragile in a
  way that fails silently on a library bump, for a saving of ~15 lines.)
- **Pan stays theirs.** It already translates camera and target together, which
  keeps the anchor on the axis; we only correct the anchor's depth.

## Where the code goes

- **`src/viewer/orbitMath.ts` (new, pure)** — `rotateAboutPivot(...)` and
  `dollyTowardPoint(...)`, both taking and returning plain position/target
  vectors. `Viewer` needs WebGL and has no unit tests; this is the same split as
  `computeFitPosition` in `cameraUtils.ts` and `computePlaneDelta` in
  `ClippingTool.ts`, and it is where the tests go.
- **`src/viewer/Viewer.ts`** — pointer/wheel/pinch handlers, the `pivot` field,
  the fallback ladder, marker feedback.

## Consequence for CLAUDE.md

The "Deferred State Application" section names `pivotTransitioning` in
`Viewer.ts` as the reference implementation of a project-wide pattern. This
change **deletes** that machinery (`'pivot-transition'` mode and the
skip-`update()` branch), because there is no longer a deferred snap to hide —
and grepping shows `'pivot-transition'` is the branch's only consumer. The
surviving mode `'animating'` also skips `controls.update()`, but for a different
reason (the fit tween owns the camera that frame), so it is not a replacement
reference implementation.

Decision: **retire the section, keep the lesson.** Replace it with a shorter
"Camera ownership" section documenting the surviving `'user' | 'animating'`
modes, plus the postmortem:

> The pivot case that motivated this pattern was retired: deferring a snap only
> moves it to the user's next gesture. When a visual consequence is jarring, fix
> the state model that produces it — the pivot now lives outside
> `controls.target` precisely so there is nothing to defer.

A documented pattern with zero live instances gets cargo-culted into the next
feature; this keeps the knowledge, including the trap, without advertising the
workaround.

## Risks

- **Rotation feel.** Speed and clamping must match what OrbitControls did, or
  the change reads as "orbit got weird" rather than "orbit got better".
- **Zoom stalling.** The viewport-wall failure mode above. Covered by geometric
  stepping + per-event raycast; needs a unit test that a repeated dolly toward a
  fixed point keeps closing the distance and never converges short of it.
- **Pan depth.** New risk from the two-point split — see *Pan*.
- **Marquee interaction.** `setControlsEnabled(false)` suspends OrbitControls
  during an Alt-drag marquee; our own handlers must honour the same gate, or
  Alt-drag will orbit as well as marquee.
- **Pivot picking mode.** The `v`-key crosshair click must not be swallowed by
  the new rotate-drag handler.
- **Raycast cost.** Once per gesture start and once per wheel event, against a
  large model. Wheel events fire fast; if this shows up, throttle to one raycast
  per frame rather than per event.

## Checklist

- [ ] Branch `feature/orbit-about-cursor`
- [ ] Run existing tests (baseline)
- [ ] `orbitMath.ts` + unit tests: rotation preserves distance-to-pivot; the
      anchor stays on the forward axis; polar clamp; dolly brakes but never
      stalls short of the target point; near-plane guard
- [ ] `Viewer` takes over mouse rotate + zoom; pivot leaves `controls.target`
- [ ] Fallback ladder incl. on-screen test and selection centre
- [ ] Pan re-derives the anchor depth
- [ ] Pinch handler (finger midpoint)
- [ ] Transient pivot marker during a cursor-orbit
- [ ] Delete `'pivot-transition'`; rewrite the CLAUDE.md section
- [ ] Marquee / pivot-picking / tool gating still hold
- [ ] Manual test: place pivot → no snap on place, no snap on first orbit;
      orbit over geometry, over empty space, with and without a selection;
      zoom right up to a surface and back out; pan does not move the pivot;
      touch rotate and pinch on a tablet
- [ ] PR
