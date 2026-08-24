# Measurement modes — Solibri-style measuring

> **Read this first.** The TL;DR below is every decision that needs your
> answer before code starts. Everything after it is the reasoning, the
> research it came from, and the build plan.

---

## TL;DR — decisions needed

| # | Decision | Options | Recommended |
|---|---|---|---|
| **D1** | **Unit scaling** — the tool reports metres on millimetre models today. Fix where? | **(a)** normalize geometry to metres at parse · **(b)** keep raw units, scale only the label | **(a)** — see *D1* below, this is a bug beyond measuring |
| **D2** | Which modes ship in v1 | **(a)** point→point + orthogonal · **(b)** + surface→surface · **(c)** + element→element shortest distance | **(a) + (c)** |
| **D3** | How the user picks a mode | **(a)** buttons in the tool tray · **(b)** hotkey during placement · **(c)** infer automatically | **(a) + (b)** |
| **D4** | How much snapping | **(a)** none (today) · **(b)** face only · **(c)** + vertex / edge / midpoint | **(b)** now, **(c)** as its own card |
| **D5** | How measurements are removed | **(a)** one "Clear measurements" only · **(b)** + click-to-select + `Delete` · **(c)** + a measurements list panel | **(b)** — (a) alone is punishing, (c) is a panel we don't need yet |
| **D6** | Do measurements survive a reload | **(a)** no (today) · **(b)** yes, in the session | **(b)** if cheap, else defer |
| **D7** | Does this bundle `undo-redo-retrofit` | **(a)** yes · **(b)** separate PR | **(a)** — both rewrite the same state machine |
| **D8** | Label content | **(a)** distance only (today) · **(b)** distance + mode + Δ components | **(b)**, compactly |

**The one that isn't optional: D1.** It is a live bug, and it is not confined
to measuring — see below. Everything else is a genuine preference.

**Sequencing note:** you asked for this before the Data Insight prerequisites.
That works — it shares nothing with them, so neither blocks the other.

---

## D1 — Units. Read this one properly.

**Measured, not assumed** (probed with web-ifc directly, 2026-08-24):

```
assets/ifcs/RIB.ifc          IFCSIUNIT(.LENGTHUNIT., .MILLI., .METRE.)   local x-range  -30700 .. 30700
assets/ifcs/SBM_RIE.ifc      IFCSIUNIT(.LENGTHUNIT., .MILLI., .METRE.)
assets/ifcs/SMB_ARK.ifc      IFCSIUNIT(.LENGTHUNIT., .MILLI., .METRE.)
Snowdon Towers …ural.ifc     IFCSIUNIT(.LENGTHUNIT., $,       .METRE.)   local x-range     -37 .. 37
```

web-ifc hands back geometry **in the file's own length unit**. Nothing in the
parse path scales it — there is no `LENGTHUNIT` handling in `ifcWorker.ts` or
`WorkerIfcParser.ts`. And `MeasurementTool.createLabel` is:

```ts
const text = `${distance.toFixed(2)} m`;   // hardcoded
```

So on RIB.ifc — three of your four sample models — a 30.7 m beam measures
**"30700.00 m"**. The tool is wrong on most of what you actually load.

**It is worse than a label bug.** Because the scale factor never enters the
scene graph, loading a millimetre model and a metre model together puts them
in one scene at **1000× different sizes**. Multi-model is a first-class
feature here (model tree, single-model lock, combined fit). So this is a real
defect today, independent of measuring — measuring is just the first feature
that makes it undeniable.

**Option (a) — normalize to metres at parse (recommended).** Read the model's
`LENGTHUNIT`, scale vertices (or the model group) so one world unit is one
metre, everywhere. Fixes multi-model scale, measurement, and any future
volume/area work in one place, and means every downstream consumer can assume
metres.
- *Cost:* touches the parse path and the geometry cache. The IndexedDB
  geometry cache (`cached-parsed-geometry-idb`, PR #27) stores parsed
  geometry — cached entries from before this change would be in raw units, so
  the cache needs a version bump or the scale factor stored alongside.
- *Risk:* camera near/far and marker screen-size constants were tuned against
  today's mixed scales. Expect to re-tune `computeFitPosition`'s
  `near = distance * 0.01`, the pivot marker's `dist * 0.008`, and the
  measurement marker sizes.

**Option (b) — leave geometry raw, scale only the label.** Cheaper and
narrower; measuring becomes correct. But multi-model stays broken, and every
future feature that compares lengths across models inherits the problem.

I'd take (a) and treat it as its own commit *inside* this PR, landing before
the mode work, so the two are separable if (a) turns up trouble. If you prefer
(b), say so — but then a `normalize-model-units` card goes on the roadmap and
the aggregation epic inherits it (the same defect corrupts summed volumes).

---

## What exists today

`src/tools/MeasurementTool.ts`, 481 lines, one mode:

- Click a surface, click another surface, get a straight line and a label.
- Raw raycast hit points — **no snapping of any kind**. You get exactly the
  point on the triangle under the cursor.
- Right-click during placement cancels the pending start point.
- Constant-screen-size markers via `update()` from the render loop.
- Yellow line, green start marker, red end marker, sprite label at midpoint.

**There is no user-facing way to remove measurements.** `clearMeasurements()`
exists but is only called from `App.resetView()` and `dispose()` — and
`resetView` also drops your clipping plane, selection, and appearance
overrides. `App.ts:82` even carries the comment *"future contextual buttons
(Remove measurements, Show hidden …)"* — it was never built. So today: place
one measurement by accident and your only escape nukes the whole view. That
alone justifies D5.

Measurements are **not** session-persisted (no `SessionStore` involvement).

---

## Prior art

Researched 2026-08-24. Inspiration, not imitation — but several of these
directly shaped the proposal.

### Navisworks — the closest match to what you asked for

- Modes: *Point to Point, Point to Multiple Points, Point Line, Accumulate,
  Angle, Area, **Shortest Distance**, Clear*.
- **Perpendicular Lock**: press `P` (or pick it from the Lock dropdown), then
  "hover your mouse on the model and use the surface snap to select a
  surface — your measurement will be perpendicular to this surface." Also
  locks to X/Y/Z axes.
- **The feedback pattern you asked for already has a precedent**: "the measure
  line is displayed as a **solid yellow line** when it is perpendicular to the
  surface of your start point." The lock state is shown *on the measurement
  line itself*, continuously, not in a status bar.
- **Shortest Distance** works on **two selected objects**: Ctrl-select two
  objects, then run the command; the view zooms to the measured area and
  labels the distance. Known limitation: on parametric cylinders it measures
  **centre lines**, not surfaces, and only RVM/DGN loaders produce those — so
  the mode's meaning quietly changes with the source format.

### Solibri

- Measurement view opens with the tool, defaults to **Length**; the type is
  changed in that view rather than by modifier.
- Surface-to-surface: "Click the second surface. A line is drawn between the
  two surfaces, and the distance value is added."
- **Shift snaps to axis** (restrict to X/Y/Z).
- The separate *Dimension* tool offers distance, **vertical distance**, and
  **horizontal distance** as explicit variants.
- **Measurements are a list**: individually deletable, each with a visibility
  toggle, multi-select plus a header visibility toggle, and **double-click a
  row to focus that measurement in 3D**. This is the mature form of D5(c).

### Trimble Connect

- Select a measurement → **Delete button on an editing toolbar, or the `DEL`
  key**.
- **"Delete all measurements"** in the tool's dropdown, plus a Delete All on
  the creation toolbar.
- This is exactly D5(b): per-item delete with no panel, and a global clear.

### BIMcollab

- Delete-all for the view, plus **Ctrl multi-select** of measurements.

### Autodesk Platform Services viewer (the web-viewer precedent)

- Snapping is its own subsystem (`Autodesk.Snapping`, class `Snapper`),
  snapping to **vertex, midpoint, intersection, circle centre**, three edge
  kinds (line / arc / curve), and faces (flat / curved).
- Snap feedback is a **mesh rendered into an overlay** at the snap point —
  a visual indicator, not a cursor change.
- Worth noting for D4: Autodesk considered this large enough to be a separate
  extension. Treat snapping as a subsystem, not a feature flag.

**Sources:** [Navisworks perpendicular lock](https://help.autodesk.com/cloudhelp/2017/ENU/Navisworks-Manage/files/GUID-9A45B5A2-1863-484A-BC9A-221368235A4E.htm) ·
[Navisworks measuring](https://help.autodesk.com/cloudhelp/2024/ENU/Navisworks-Freedom/files/GUID-BF19C0B9-2CBC-44A2-8871-EA73B3D947F1.htm) ·
[Navisworks shortest distance](https://help.autodesk.com/cloudhelp/2022/ENU/Navisworks-Freedom/files/GUID-A088FC06-5EC0-41AD-9F2F-97E1B7017446.htm) ·
[Solibri measurement tool](https://help.solibri.com/hc/en-us/articles/30962601006871-The-Measurement-Tool) ·
[Solibri dimension tool](https://help.solibri.com/hc/en-us/articles/1500003958182-The-Dimension-Tool) ·
[Trimble Connect deleting measurements](https://docs.3d.connect.trimble.com/measuring/deleting-measurements) ·
[BIMcollab WebViewer measurements](https://helpcenter.bimcollab.com/en/articles/326610-measurements-in-bimcollab-model-webviewer) ·
[APS snappy viewer tools](https://aps.autodesk.com/blog/snappy-viewer-tools) ·
[APS SnapResult](https://aps.autodesk.com/en/docs/viewer/v7/reference/MeasureCommon/SnapResult/)

---

## D2 — Which modes

**Recommended: point→point (unchanged default) + orthogonal + element→element.**

### Point → point
Today's behaviour, still the default. Nothing changes for anyone who liked it.

### Orthogonal (surface → point) — the mode you asked for
First click **locks a face**. The second pick is projected onto that face's
plane, and the reported distance is along the face normal. Draw the projection
foot and the normal segment — not a raw line between the two clicks — so the
number explains itself.

Geometry is already available: `raycastVisible` returns `hit.face`, so the
world normal is `face.normal` transformed by the mesh's normal matrix.

### Element → element shortest distance — *the one worth adding*
Navisworks' most useful measure command, and it answers your literal example
better than orthogonal does. **Select two elements, right-click, "Measure
shortest distance."** No precision clicking at all — no hunting for the right
spot on the wall, no worrying whether you clicked exactly normal.

It is close to free architecturally: `SelectionManager` already tracks a
multi-selection, the context menu is already selection-scoped and builds its
items from `SelectionState`, and `select-similar` established the pattern of a
context-menu action operating on the current selection.

The cost is the geometry: the true minimum distance between two triangle
meshes is O(n·m) brute force. Mitigations, in order: AABB-vs-AABB first (gives
a lower bound and an instant answer when they're far apart), then a bounded
triangle-pair search with early exit, with a cap and an honest "approximate"
label above it. **Navisworks itself cheats here** — it measures centre lines
for parametric cylinders — so an approximation with a stated method is in good
company. Worth its own sub-phase inside the PR, and droppable without
affecting the rest if it turns out expensive.

### Surface → surface — recommend *deferring*
Clear span between two parallel faces. Fiddliest of the three: needs a
"parallel enough" tolerance and an honest refusal when the faces aren't, and
element→element covers most of the same questions with a better interaction.

---

## D3 — Choosing a mode

**Recommended: visible buttons, plus a hotkey accelerator.**

Solibri puts the type in a view; Navisworks uses both a dropdown and `P`.
Buttons are the discoverable half — a first-time user must be able to *see*
that orthogonal exists. The hotkey is for the second hour.

Concretely: when the measurement tool is active, a small mode row appears
(same visual language as the contextual-action tray), with Point / Orthogonal.
`P` cycles or toggles orthogonal, mirroring Navisworks' muscle memory.

Not automatic inference — "it decided what I meant" is exactly the kind of
magic that makes a measurement untrustworthy, and a measurement people don't
trust is worse than no measurement.

---

## D4 — Snapping

**Recommended: face-only in v1, full snapping as its own card.**

Orthogonal mode needs the face anyway, so face "snapping" comes free with it.
Vertex / edge / midpoint / centre snapping is what makes measuring feel
*precise*, and it is the single biggest thing separating this from Solibri —
but APS shipped it as a whole extension with its own indicator overlay, and
that is a fair estimate of the size. Bundling it here would double the PR and
delay the mode work.

Note the honest consequence of deferring: without vertex snapping, measuring
"corner to corner" stays approximate, because you get the point on the
triangle under the cursor and nothing pulls it to the corner. That is already
true today, so this is not a regression — but it is the first thing a Solibri
user will notice. A `measurement-snapping` card should go on the roadmap at
the same time as this one, so the gap is recorded rather than forgotten.

---

## D5 — Removing measurements

**Recommended: click-to-select + `Delete`, plus a global clear.** This is
Trimble Connect's model exactly, and it needs no panel.

You said a centralized clear feels right for a tool this simple, and that
per-item CRUD is too much. I agree about CRUD — but note the starting point is
worse than you think: **there is no clear button at all today**, only
`resetView`, which also drops clipping, selection and appearance. So the
minimum is:

1. **"Clear measurements" in the contextual-action tray** — 📏, visible only
   when at least one measurement exists. Identical idiom to Remove clipping /
   Clear basket / Remove pivot. This is the piece you thought already existed.
2. **Click a measurement to select it, `Delete` / `Backspace` to remove it.**
   ~30 lines: the measurement groups are already in the scene with
   `userData.isMeasurement`, and `raycastVisible` currently *filters them out*
   — so picking one is a matter of a second raycast pass that only looks at
   them. Highlight the selected measurement so it is obvious what `Delete`
   will take.

Why (2) matters despite your instinct: the failure mode of clear-only is
"I placed six measurements, the fourth was a misclick, now I redo all six."
That is the moment a user decides the tool isn't serious. It is the cheapest
possible fix and it stops short of a panel.

**Deliberately left open for later** (the Solibri form, if it's ever wanted):
a measurements list with per-row visibility toggles, multi-select, and
double-click-to-focus. Nothing here forecloses it — keeping `measurements[]`
as an ordered array of records with stable ids is the only thing needed now to
make that easy later, and it costs nothing.

---

## D6 — Persistence

Measurements vanish on reload today. Clipping and appearance persist; a
measurement you took two minutes ago disappearing on refresh is inconsistent.
Two points and a mode is a tiny record, so the storage cost is nil.

The catch: a measurement references world coordinates, which only mean
anything with the same models loaded — and under D1(a) they'd also be in
metres, so pre-change stored measurements would be wrong. Store the model ids
alongside and drop measurements whose models aren't restored.

**Recommend (b)** if it lands in an hour; defer without guilt if it fights.

---

## D7 — Undo

**Recommend bundling `undo-redo-retrofit`'s measurement half here.** That card
already specifies: a completed measurement = one command, delete = one,
mid-placement `Ctrl+Z` cancels the pending placement. Both it and this work
rewrite the same placement state machine. Doing them separately means building
that machine twice, and the second build is the one that breaks the first.

The clipping half of `undo-redo-retrofit` stays where it is — it's unrelated
code.

---

## D8 — What the label says

Today: `4500.00 m` (wrong units, no other information).

**Recommended:** distance, unit, and — in orthogonal mode — a hint of the
method, because a number whose derivation isn't visible invites mistrust.
Something like `2.45 m ⊥` with the normal segment drawn. Keep it one line;
resist a data panel. Precision follows the model unit: two decimals in metres,
zero in millimetres.

---

## The face-lock feedback (settled — you chose this)

Navisworks shows the lock **on the measurement line**: solid yellow when
perpendicular to the start surface. That is the right instinct — the feedback
belongs where the user is already looking, not in a corner.

Proposal, layered:

1. **On hover, before the first click** — tint the face under the cursor
   faintly, so "this is the face I would lock" is answered before committing.
   Uses the existing highlight-variant material mechanism.
2. **After the lock** — keep the locked face tinted for the rest of the
   gesture and draw its normal as a short axis line at the lock point. The
   user can see both *which* face and *which direction*.
3. **During the second pick** — draw the projection: from the moving cursor
   point, a dashed line to the plane, then the solid measured segment along
   the normal. The dashed/solid split says "this part is your click, this part
   is the measurement."
4. **Escape hatch** — right-click already cancels a pending start; keep that,
   and make it release the face lock too.

The tessellation caveat this solves: a "flat" wall is many triangles, and
adjacent ones can have slightly different normals. Showing the locked face
means the user sees immediately if they caught a stray triangle, rather than
finding out from a number that is 2 mm off for no visible reason. If the
tint reveals this is common in practice, the follow-up is coplanar-face
merging (grow the locked region across adjacent triangles within an angular
tolerance) — worth doing only if the manual smoke says it's needed.

---

## Architecture

- **`src/tools/measureMath.ts` (new, pure)** — projection onto a plane,
  orthogonal distance, world-space normal from a hit, the AABB lower bound and
  triangle-pair search for element→element. `MeasurementTool` needs WebGL and
  has no unit tests; this is where the tests go. Same split as `orbitMath.ts`
  and `cameraUtils.ts`.
- **`src/tools/MeasurementTool.ts`** — split placement state from rendering
  before adding modes. It is 481 lines with pointer handling, preview,
  markers, and label sprites all interleaved; adding three modes and a
  selection model on top of that as-is will not survive the next feature.
- **`src/core/App.ts`** — the "Clear measurements" tray action, and the
  element→element context-menu item.
- **Parse path** (D1(a) only) — unit normalization, plus the geometry-cache
  version bump.

---

## Risks

- **D1 re-tuning.** Normalizing to metres changes every scene-scale constant
  that was tuned by eye. Budget a pass over camera near/far and marker sizes.
- **Geometry cache staleness.** Cached entries predate the unit fix; bump the
  cache version or the first load after deploy is silently 1000× wrong.
- **Tessellation normals.** The reason for the face-lock display; may need
  coplanar merging.
- **Element→element cost.** Brute force is O(n·m). Bounded search + cap +
  honest labelling, and droppable if it misbehaves.
- **Tool ownership.** The measurement tool, pivot picking, marquee, and the
  new measurement *selection* all want the same clicks. `canNavigate()` and
  the `toolManager.getActiveTool()` gate are the existing precedent — every
  new pointer path must honour them or gestures start fighting.
- **Scope.** This document proposes more than one PR's worth. Sub-phase it:
  (1) units, (2) removal UX, (3) orthogonal mode, (4) element→element. Each is
  independently shippable and (1) and (2) are worth having even if (3) slips.

---

## Checklist

- [ ] Decisions D1–D8 answered
- [ ] Branch `feature/measurement-modes`
- [ ] Run existing tests (baseline)
- [ ] **Phase 1 — units:** normalize at parse, bump the geometry-cache version,
      re-tune scale constants, label reads the model unit. Tests: a mm model
      and an m model load at the same real-world scale.
- [ ] **Phase 2 — removal:** "Clear measurements" tray action; click-to-select
      + `Delete`; stable measurement ids. Tests: tray predicate + id lifecycle.
- [ ] **Phase 3 — orthogonal:** `measureMath.ts` + unit tests (projection,
      normal transform, degenerate faces); face-lock hover/lock/preview
      feedback; mode buttons + `P`.
- [ ] **Phase 4 — element→element:** context-menu item on a 2-element
      selection; AABB bound then bounded triangle search; cap + approximate
      labelling.
- [ ] Undo: measurement create / delete are single commands; mid-placement
      `Ctrl+Z` cancels
- [ ] Session persistence (D6) or an explicit note that it was deferred
- [ ] Manual test: mm model and m model, singly and together; orthogonal
      against a wall face; a deliberately stray triangle; delete one of
      several; clear all
- [ ] Roadmap: add the `measurement-snapping` follow-up card
- [ ] PR
