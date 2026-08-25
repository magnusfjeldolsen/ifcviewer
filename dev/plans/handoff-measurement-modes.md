# Measurement modes — Solibri-style measuring

> ## ⚠ Re-review each step before implementing it
>
> **This plan was written 2026-08-24, before any of it was built.** Every step
> below assumes the codebase as it stood then. Each step that runs *after*
> another one lands is working against a codebase that step already changed —
> so before starting any step, re-verify its claims (line references, file
> names, what earlier steps actually did versus what they planned to do). If a
> check fails, fix this document first and say what changed. Do not implement
> around a stale claim.
>
> Step 0 (`handoff-normalize-model-units.md`) is separate and lands first.

> **Read this first.** The TL;DR below is every decision that needs your
> answer before code starts. Everything after it is the reasoning, the
> research it came from, and the build plan.

---

## TL;DR — decisions needed

### Open — these need your answer

| # | Decision | Options | Recommended |
|---|---|---|---|
| ~~**D1**~~ | ~~Unit scaling~~ | **WITHDRAWN 2026-08-25 — there was no bug.** web-ifc already bakes the length factor into each mesh's placement matrix (measured: exactly `0.001` for RIB, exactly `0.304800` for Snowdon). The scene was always metres. See `handoff-normalize-model-units.md`. | — |
| **D2** | Which modes ship | **(a)** point→point + orthogonal · **(b)** + surface→surface · **(c)** + element→element shortest distance | **(a) + (c)** |
| **D3** | How the user picks a mode | **(a)** buttons in the tool row · **(b)** hotkey during placement · **(c)** infer automatically | **(a) + (b)** |
| **D6** | Do measurements survive a reload | **(a)** no (today) · **(b)** yes, in the session | **(b)** if cheap, else defer |
| **D7** | Bundle `undo-redo-retrofit`'s measurement half | **(a)** yes · **(b)** separate PR | **(a)** — both rewrite the same state machine |
| **D8** | Label content | **(a)** distance only (today) · **(b)** distance + unit + mode marker, switching to mm below 1 m so a 3 mm gap does not render as "0.00 m" | **(b)**, compactly |
| **D11** | Does **circle-centre** snapping ship (round columns, pipe centrelines)? | **(a)** no — endpoint/midpoint/edge/face only · **(b)** yes | **(a)** — the one kind needing real geometry recovery |
| **D12** | `Tab` has two jobs: cycling **pick** candidates and cycling **snap** candidates | **(a)** context-dependent — snaps while placing, picks otherwise · **(b)** different keys | **(a)** — never live at once |
| **D13** | How to suppress snapping for a raw point | **(a)** held modifier · **(b)** toggle in the mode row · **(c)** both | **(c)** — but the modifier needs picking: `Alt`, `Ctrl`, `Shift` are taken |
| **D14** | **Snapping vs orthogonal mode** — the first orthogonal pick must lock a *face*, but snapping pulls picks to endpoints and edges | **(a)** in orthogonal mode the first pick ignores point/edge snaps · **(b)** snap normally, take the face from the underlying raycast anyway · **(c)** snapping off during the first pick | **(b)** — see *Snapping meets orthogonal* |
| **D15** | **What happens to a measurement when its model is hidden or removed** | **(a)** nothing — it floats (today) · **(b)** hide with the model, delete with it · **(c)** delete on removal, leave on hide | **(b)** |

### Settled

- **D4 — snapping (2026-08-24):** full. Endpoint, midpoint, edge and face ship
  with the tool; half-snapping would feel worse than none. Circle centre is
  the only kind deferred (D11).
- **D5 — removal (2026-08-24):** "Clear measurements" **plus** click-to-select
  and `Delete`. A Solibri-style list panel stays open for later.
- **D9 — pick arbitration (2026-08-24):** thin targets only (line and markers,
  never the label), drawn thick enough to aim at via `Line2`, picked within a
  screen-space threshold, elements winning ties, `Tab` to cycle.
- **D10 — hover pre-highlight (2026-08-24):** user-toggleable, default **on**,
  key under `ifcviewer:settings:*` via the central `Settings` module.

**D1 is withdrawn.** It was reported here as a live bug on the strength of a
probe that read raw vertex buffers and ignored the placement matrix. web-ifc
already normalizes to metres. Nothing in this feature is blocked by units, and
the `normalize-model-units` card is gone. The only fragment worth keeping is
cosmetic and now lives in D8: sub-metre distances must not render as
"0.00 m".

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

### This is not a detection problem — and we already read the answer

You asked whether to set the unit per model by hand or auto-detect it. Neither,
mostly: **the IFC file states its length unit explicitly**, and it is not a
heuristic or an inference. It is a declaration:

```
IFCUNITASSIGNMENT → IFCSIUNIT(*, .LENGTHUNIT., .MILLI., .METRE.)
```

**And we already parse it.** `computeUnitTable`
(`src/inspector/repository/unitTable.ts`) walks
`IfcProject.UnitsInContext.Units` today and reads exactly this — it is what
drives the unit pills in the inspector. `format.ts` even maps the SI prefix
(`SI_PREFIX_SYMBOL: MILLI → 'm'`) so a length reads "mm".

So the gap is narrow and specific, and it is plumbing, not discovery:

1. **`UnitTable` is `ReadonlyMap<MeasureKind, string>` — symbols only.** It
   resolves `MILLI` to the *letter* `m`, never to the *number* `0.001`. Add a
   numeric length-scale alongside the symbol.
2. **Nothing applies it to geometry.** The scale factor never reaches
   `ModelManager`, so the scene graph stays in file units.
3. **Timing.** `ensureUnitTable` runs *lazily, on the first property query*
   (`ifcWorker.ts`). Geometry scaling needs the factor at model-open, before
   meshes stream. The read has to move earlier — small, but it is a real
   sequencing change, not a no-op.

**Auto-detection from model size would be strictly worse.** Guessing "this
model is 30 000 units across, so probably millimetres" fails on a genuinely
large site model in metres, and fails silently — the worst kind. We would be
inferring something the file already told us.

### Recommended: (b) — trust the declaration, allow an override

**Primary: read `LENGTHUNIT` and normalize to metres.** One world unit = one
metre, everywhere, for every model. Every downstream consumer — measurement,
multi-model fit, future volume/area aggregation — can then assume metres
without asking.

**Secondary: a per-model override, in the model tree.** Not because detection
is unreliable, but because **declarations are sometimes wrong**. Exporters do
ship files that declare metres while writing millimetres, and when that
happens the user is the only one who can see it (the model loads 1000× too
big next to a correct one). A small unit dropdown per model row — defaulting
to "declared: mm" and rarely touched — turns an unrecoverable situation into a
two-click fix.

Make the override *visibly* an override: show the declared unit, and mark the
row when the user has overridden it. Silent overrides that persist across
sessions are their own bug source.

### Cost and risk either way

- *Geometry cache:* the IndexedDB cache (`cached-parsed-geometry-idb`, PR #27)
  stores parsed geometry. Entries written before this change are in raw units,
  so the cache needs a version bump — or the first load after deploy is
  silently 1000× wrong for anyone with a warm cache.
- *Scale constants:* camera near/far and marker sizes were tuned against
  today's mixed scales. Expect to re-tune `computeFitPosition`'s
  `near = distance * 0.01`, the pivot marker's `dist * 0.008`, and the
  measurement marker sizes.
- *Where to scale:* **superseded — see `handoff-normalize-model-units.md`.**
  This section originally argued for scaling the vertices, on the grounds that
  a group scale "leaves raw numbers in `geometry.boundingBox` and in every
  raycast hit". That was wrong: `hit.point` is world-space,
  `Box3.expandByObject` applies `matrixWorld`, and `MarqueeSelector` already
  multiplies by `matrixWorld` itself. **Scale the group** — it needs no
  geometry-cache invalidation and makes the per-model override a live
  one-liner instead of a re-parse.

This is no longer part of this feature. It is its own card and its own PR
(`normalize-model-units`), merged **before** measurement work starts — see
*Review findings*.

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

## D4 — Snapping *(decided: full, in this feature)*

Agreed, and for the right reason: a measuring tool that *almost* hits the
corner is not a measuring tool. This raises the effort from **M-L to L** and
makes snapping its own phase — but it is more tractable than the roadmap card
assumed, for one specific reason below.

### The trap that decides the design

**IFC geometry is triangulated, and naive snapping snaps to the triangles.**
A rectangular wall face is at least two triangles. Snap to raw mesh vertices
and you offer the user points *in the middle of a flat surface*; snap to raw
mesh edges and you offer the **diagonal seam** across that face. Aiming at a
corner and landing on a triangulation artefact is worse than no snapping,
because the user cannot see why the number is wrong.

So candidates must come from **feature edges**, not mesh edges — only the
edges where the two adjacent faces actually diverge.

**Three.js already does exactly this.** `THREE.EdgesGeometry(geometry,
thresholdAngle)` keeps an edge only when the angle between its adjacent faces
exceeds the threshold
(`node_modules/three/src/geometries/EdgesGeometry.js:35`). It turns a
triangulated box back into its 12 real edges. The threshold wants tuning
against real IFC — start around 15-20 degrees, keep it a named constant, and
check it against a curved wall, which is the case that punishes a threshold
set too low.

### The insight that makes this affordable

**No global spatial index is needed.** The earlier estimate — and the roadmap
card — assumed snapping means indexing the whole model. It does not: the
cursor is already over a mesh, and we already raycast it for the hover
highlight. Candidates come from **that mesh**, computed lazily and cached:

```
hover a mesh
  -> EdgesGeometry(mesh.geometry, threshold)   <- once per mesh, cached
       endpoints = feature-edge vertices
       midpoints = midpoint of each feature edge
       edge      = nearest point on the nearest feature edge
       face      = the raw hit point (today's behaviour)
  -> keep candidates within ~12 px of the cursor in screen space
  -> rank: endpoint > midpoint > edge > face
```

The cost is paid only for meshes the user actually hovers, and once each. That
is a very different proposition from indexing 100k meshes up front.

Two caveats, honestly:

- **Geometry is not shared today** — `ModelManager` builds a fresh
  `BufferGeometry` per mesh (`ModelManager.ts:238`), so the cache cannot
  dedupe across a thousand identical bolts. It stays *correct*, just less
  efficient than it will be if `instanced-meshes` ever lands. Key the cache by
  geometry object and it improves for free when that happens.
- **Spanning elements.** Taking candidates from the hovered mesh alone means
  you cannot snap to a neighbouring element's corner while hovering this one.
  That is usually right — you are pointing at *this* thing — but it fails for
  "from this column's corner to that wall's corner" if the cursor drifts.
  Mitigation: also consider meshes whose screen-space bounds contain the
  cursor, capped at a handful.

### Snap kinds

**Shipping** — the set you named, plus the one we already have:

| kind | source | priority |
|---|---|---|
| **Endpoint** | feature-edge vertices | 1 (highest) |
| **Midpoint** | midpoint of a feature edge | 2 |
| **Edge** | nearest point along a feature edge | 3 |
| **Face** | raw raycast hit | 4 (fallback = today) |

Priority follows the CAD convention — *points beat lines beat surfaces* —
because a point is a more specific intent than a surface, and a user aiming
near a corner means the corner.

**Deferred: circle centre (D11).** Genuinely useful for round columns and pipe
centrelines, and the one kind that cannot be read off the tessellation. IFC
curved geometry arrives as flat triangles, so there is no arc to snap to — the
centre has to be *recovered* by fitting a circle to a coplanar feature-edge
loop, with a tolerance and an honest failure when the loop is not circular.
Self-contained work with its own risk, and everything else is useful without
it. Recommend shipping without, and adding it if round columns turn out to be
a daily annoyance.

**Also deferred: intersection.** Needs two edges resolved at once; rare in a
viewer compared with a modeller.

### Feedback

Follow the AutoCAD / APS pattern: a **distinct glyph per snap kind**, drawn in
an overlay at the candidate point (square = endpoint, triangle = midpoint, and
so on), so the kind is readable without a legend. APS renders exactly this as
a mesh in an overlay.

The glyph is what makes snapping trustworthy. Without it the user cannot tell
whether the tool grabbed the corner or a point 2 mm along the edge — and an
invisible snap is indistinguishable from a bug.

The same overlay serves the hover pre-highlight (D10), and the D10 toggle
should govern both: they are one "tell me what you are about to do" system.

### Suppressing it (D13)

Every CAD tool lets you take a raw point without snapping. The convention is a
held modifier, but **ours are all taken**: `Alt` is the marquee, `Ctrl` and
`Shift` are the selection modifiers *and* three's pan path. Options: a plain
letter held down (`S`), or `Space` as hold-to-suppress, plus a sticky toggle
in the mode row for anyone who wants it off permanently. Decide before
implementing — a modifier that fights the marquee is exactly the kind of bug
manual testing catches late and inconsistently.

---

## D5 — Removing measurements *(decided)*

**Click-to-select + `Delete`, plus a global clear.** This is Trimble Connect's
model exactly, and it needs no panel.

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

---

## D9 — Picking a measurement without stealing clicks

Your condition on D5 was the right one: per-item delete is only worth having
if selecting a measurement is trivial **and** doesn't make elements near it
unselectable. That is not automatic — it is the design risk of this half.

**Why it's a real risk.** Measurement geometry is drawn with
`depthTest: false` and `renderOrder: 1000` (`MeasurementTool.createMeasurement`,
`createPointMarker`). It renders *on top of everything, including geometry in
front of it*. So a measurement taken inside a wall still paints over that
wall. If measurement objects simply joined the pick list, they would win
clicks they have no depth-based right to — and "nearest hit wins" is
meaningless when one of the candidates deliberately ignores depth.

Note what protects us today: `raycastVisible` **explicitly filters
measurements out** (`!obj.userData.isMeasurement`). That filter is why
selection near a measurement works at all right now. Making measurements
pickable means removing that protection, so the arbitration has to replace it
with something better.

### Recommended: thin-target priority + `Tab` to cycle

**1. Only the thin parts are pickable.** The line and the two point markers —
**not the label sprite.** The label is the only part of a measurement with
real screen area (a filled rounded-rect quad scaled by measurement length, up
to `2.0` world units), and it is precisely what would blanket elements behind
it. Excluding it costs nothing: nobody's instinct is to click a number to
select the thing it annotates, and the line is right there.

**2. The line has to be *drawn* thick enough to aim at — and that needs a
different three.js class.** `THREE.LineBasicMaterial` has a `linewidth`
property, but **WebGL ignores it**: the core profile only guarantees a line
width of 1 device pixel, so on Windows/ANGLE (i.e. most of your users) setting
it does nothing. Today's measurement line is a `THREE.Line` with
`LineBasicMaterial` — a hairline, and no amount of tweaking that material
changes it.

The fix is three's fat-line classes, already vendored in the version we
depend on (`three@0.183.2`,
`node_modules/three/examples/jsm/lines/`): `Line2` + `LineGeometry` +
`LineMaterial`, where `linewidth` *is* honoured and is expressed in screen
pixels. No new dependency.

- Draw at ~3 px so it reads as a deliberate annotation rather than an artefact.
- **Gotcha:** `LineMaterial` needs `resolution` kept in sync with the canvas
  size — it must be updated in the existing `onResize` path, or the apparent
  thickness drifts after any window resize.

**3. Screen-space threshold for the pick, slightly wider than the draw.** Even
a 3 px line is a poor exact-raycast target. Project the segment to screen
space and pick when the cursor is within ~8 px of it — the standard CAD trick
for wire geometry. Deliberately wider than the 3 px drawn, so it is
*forgiving* along the line while occupying essentially no area anywhere else,
which is exactly the constraint you set.

**4. Elements win ties; `Tab` cycles.** When both an element and a measurement
are candidates, prefer the **element** by default — the model is the content
and the measurement is annotation. `Tab` then cycles through every candidate
under the cursor, as in Revit. This is the escape hatch that makes the default
safe: getting the priority wrong is recoverable in one keystroke, so the
default can be tuned for the common case rather than the awkward one.

**5. Show what will be picked before the click — and let the user turn it
off (D10).** Revit's Tab is only usable because a pre-highlight tells you what
is currently under the cursor; without it, Tab is a guessing game. So the
candidate glows on hover: the measurement line brightens (`Line2` makes this
easy — swap the material colour, keep the width), and an element gets its
usual highlight treatment.

Per-frame hover raycasting on a 100k-mesh model is not free, and some people
find hover highlights busy — hence the toggle. **Default it on**: it is what
makes `Tab` legible, and a feature nobody discovers is worse than one somebody
disables.

Where the setting lives is D10. The `settings-panel` card (queued) already
specifies the convention: keys under `ifcviewer:settings:*`, read through a
central `Settings` module that internals subscribe to. Recommended: add the
key and that module *now* — it is small — and let `settings-panel` surface it
later along with the other caps. That way this ships with a working toggle
(keyboard shortcut and/or a checkbox on the measurement mode row) without
waiting on a panel, and the panel gets one more row for free when it lands.

### The alternatives, and why not

- **(a) Elements always win; measurements pickable only while the measurement
  tool is active.** Simplest and completely safe — element selection cannot
  regress, because nothing changes while the tool is off. But it means "delete
  that measurement" requires first activating the tool, which is a mode the
  user did not ask to enter, and it is a strange asymmetry: you can *see* a
  measurement in the normal view but not touch it. Reasonable fallback if (c)
  proves fiddly.
- **(b) Nearest wins.** Would be right if measurements respected depth. They
  deliberately don't, and changing that would make measurements disappear
  inside walls — which defeats the point of drawing them on top.

### Consequences to keep honest

- `Tab` is unbound today — check it does not collide with focus traversal in
  the surrounding UI (the inspector and panels are real DOM). Likely needs
  `preventDefault` while the pointer is over the canvas, and must not trap
  keyboard users who are tabbing through the panels.
- Cycling needs a stable candidate order or `Tab` will jitter between frames;
  order by depth then by id, and hold the list for as long as the cursor
  stays within a few pixels.
- This is a second pick path alongside `SelectionManager`'s. It must honour
  the same gates (`toolManager.getActiveTool()`, `isPivotPicking()`,
  marquee's `setControlsEnabled(false)`) or gestures start fighting — the
  same lesson the orbit work already paid for.

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

## Review findings (2026-08-24, pre-implementation pass)

Re-read end to end before starting. Five things, two of them real gaps.

**1. Units should be its own PR, ahead of this one.** The doc previously said
"land it as its own commit inside this PR". That is wrong. It touches the
parse path, the IndexedDB geometry cache, every scene-scale constant, and
multi-model correctness — and it has nothing to do with measuring except that
measuring is what exposed it. If it rides inside the measurement PR and turns
out to be wrong, reverting takes the measurement work with it. It is also
independently valuable: it unblocks cross-model aggregation, which is the next
epic. **Make it `normalize-model-units`, its own card and its own PR, merged
before measurement work starts.**

**2. There is ONE candidate system here, not two.** Phase 2 builds
hover-highlight + `Tab` cycling to pick *measurements*. Phase 3 builds a hover
glyph + `Tab` cycling to pick *snap candidates*. That is the same machinery
twice: *given a cursor, produce ranked candidates, show the top one, let `Tab`
cycle, let a setting mute the display.* Build it once in Phase 2 as a general
candidate/overlay/cycle service and have Phase 3 register a new candidate
kind. Building it twice is precisely the mistake the orbit work paid for
(two rotate paths, one ignoring the pivot).

**3. Gap — snapping meets orthogonal mode (D14).** Unspecified until now. See
below.

**4. Gap — measurements outlive their geometry (D15).** Unspecified until now.
See below.

**5. Size, honestly.** Five phases spanning the parse path, a new snapping
subsystem, a pick-arbitration system, a mode system, and a geometry proximity
search. With units split out (finding 1) this is still **3-4 PRs** and the
largest single feature in the project so far. Worth knowing before kickoff
rather than discovering at PR three.

### Snapping meets orthogonal mode (D14)

Orthogonal mode's first pick has to establish a **face** — a plane and a
normal. But snapping's entire job is to pull the pick *off* the face, onto an
endpoint or an edge. The two goals collide on exactly the click where both are
most useful.

**Recommended (b): snap the point, take the face from the raycast.** The two
pieces of information are independent — the raycast tells us which triangle is
under the cursor (hence the plane and normal) regardless of where the snapped
point landed. So the user can snap the measurement's origin to a wall corner
*and* still measure perpendicular to that wall's face. That is strictly more
capable than either alternative, and it matches the mental model: "start at
this corner, measure perpendicular to this surface."

Edge case to handle: snapping to an endpoint shared by several faces means the
raycast face is whichever triangle the cursor happened to be over. The face
tint (already specified) shows which one was taken, and `Tab` can cycle the
face candidates at that corner — the same cycling machinery again.

### Measurements outlive their geometry (D15)

A measurement is two world-space points and nothing else. Hide the wall and
the measurement stays, annotating empty space. Remove the model and it dangles
with no referent. Load a different model and old measurements sit in the new
one's coordinate space.

There is a precedent: `SelectionManager.onModelRemoved(modelId)` prunes the
selection when a model goes. Measurements need the same, which means each
measurement must record **which models its endpoints were taken from** —
something D6 (session persistence) needs anyway, so the two decisions share
their implementation.

**Recommended (b): follow the model.** Hidden model → its measurements hide;
removed model → its measurements go. A measurement spanning two models follows
the stricter rule (hidden if either is hidden). This is the behaviour that
never leaves a number on screen that refers to something the user cannot see —
and a measurement you cannot verify is worse than no measurement.

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
- **`src/inspector/CandidateResolver.ts` (new)** — the one candidate system
  (review finding 2). Given a cursor position, produce ranked candidates from
  registered providers (elements, measurements, snap points), expose the top
  one for pre-highlight, and cycle with `Tab`. Phase 2 builds it with the
  element and measurement providers; Phase 3 registers the snap provider. The
  ranking and the screen-space distance maths are pure and testable; only the
  overlay rendering needs WebGL.
- **`src/core/App.ts`** — the "Clear measurements" tray action, and the
  element→element context-menu item.
- **Parse path** — unit normalization. **Now a separate PR** (`normalize-model-units`,
  review finding 1), not part of this work.

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
- **Fat lines.** `Line2` is a different draw path from `THREE.Line`: it needs
  `LineMaterial.resolution` maintained on resize, and it does not respond to
  `depthTest: false` identically. Verify the on-top behaviour survives the
  swap before building the pick logic on it.
- **Hover cost.** Pre-highlight means raycasting on pointer-move. Throttle to
  one raycast per frame, and reuse the same cursor position the navigation
  code already tracks (`Viewer.lastPointer`) rather than adding a second
  listener.
- ~~**Pick arbitration (D9).**~~ **Retired 2026-08-25.** The premise was that
  measurements have to join the raycast list. They do not: the measurement
  provider is a screen-space pass, so `raycastVisible` keeps its filter and the
  element pick path never changed. See *Step 1 — what the plan got wrong*.
  What replaced it: `Line2` extends `THREE.Mesh`, so every fat line (and any
  future snap glyph) must carry `userData.isMeasurement` or it rejoins the
  raycast sweep through the back door.
- **Tool ownership.** The measurement tool, pivot picking, marquee, and the
  new measurement *selection* all want the same clicks. `canNavigate()` and
  the `toolManager.getActiveTool()` gate are the existing precedent — every
  new pointer path must honour them or gestures start fighting.
- **Triangulation threshold.** The biggest snapping risk: the angle decides
  whether a curved wall becomes a useful handful of edges or a thousand
  useless ones. Tune against real IFC, not a test cube.
- **Scope.** With full snapping this is comfortably an **L** and 3-4 PRs, even
  after units are split out (review finding 1). Order: units *(separate card,
  merged first)* → removal UX + the candidate system → snapping → orthogonal
  mode → element-to-element. Each is independently shippable, and the first
  three are each worth having even if what follows slips.

---

## Checklist

- [ ] Decisions D1–D8 answered
- [ ] Branch `feature/measurement-modes`
- [ ] Run existing tests (baseline)
- [ ] **Phase 0 — units: SEPARATE PR (`normalize-model-units`), merged first.**
      Numeric length scale on `UnitTable`, unit read moved to model-open,
      vertices scaled at parse, geometry-cache version bump, scale constants
      re-tuned, per-model override in the model tree. Tests: `MILLI` → `0.001`;
      a mm model and an m model load at the same real-world scale; an override
      survives a reload and is visibly marked.
- [x] **Phase 1 — the candidate system:** cursor → ranked candidates from
      registered providers, top-candidate pre-highlight, `Tab` cycling, the
      D10 setting. Built once here; snapping registers into it in Phase 3.
      *(`CandidateResolver` + `candidateMath` + `CandidateInput`, 2026-08-25.)*
- [x] **Phase 2 — removal:** "Clear measurements" tray action; click-to-select
      + `Delete`; stable measurement ids; thin-target pick (line + markers, not
      the label) with a screen-space threshold; `Tab` cycling with hover
      pre-highlight. Tests: tray predicate, id lifecycle, and the pure
      point-to-screen-segment distance + candidate ordering.
      *(2026-08-25. Phases 1 and 2 shipped together as Step 1 — see
      "Step 1 — what the plan got wrong".)*
- [ ] **Phase 3 — snapping:** feature-edge extraction via `EdgesGeometry` with
      a tuned threshold, cached per geometry; endpoint / midpoint / edge / face
      candidates; screen-space radius + kind priority; per-kind glyph overlay;
      `Tab` cycling (D12); suppression modifier (D13). Tests: candidate
      derivation and ranking are pure and live in `measureMath.ts`; assert that
      a triangulated box yields exactly its 12 real edges and no diagonals.
- [ ] **Phase 4 — orthogonal:** `measureMath.ts` + unit tests (projection,
      normal transform, degenerate faces); face-lock hover/lock/preview
      feedback; mode buttons + `P`.
- [ ] **Phase 5 — element→element:** context-menu item on a 2-element
      selection; AABB bound then bounded triangle search; cap + approximate
      labelling.
- [ ] Undo: measurement create / delete are single commands; mid-placement
      `Ctrl+Z` cancels
- [ ] Session persistence (D6) or an explicit note that it was deferred
- [ ] Manual test: mm model and m model, singly and together; orthogonal
      against a wall face; a deliberately stray triangle; delete one of
      several; clear all
- [ ] Roadmap: fold the `measurement-snapping` card back into this one
      (decision D4), leaving only circle-centre + intersection deferred
- [ ] PR

---

## Implementation steps

Each is a PR. Each carries the ⚠ banner's warning: re-verify before starting,
because the step before it changed the ground.

### ~~Step 0 — `normalize-model-units`~~ — CANCELLED 2026-08-25

The premise was wrong: web-ifc already normalizes geometry to metres via the
placement matrix. See `handoff-normalize-model-units.md` for the measurement
that disproved it. **Step 1 is now the first step.**

---

### Step 1 — The candidate system + measurement removal

> **✅ BUILT 2026-08-25.** Corrections found while implementing are recorded in
> *Step 1 — what the plan got wrong* below. Read that before Step 2: two of
> them change what Step 2 can assume.

**Why first:** it is the substrate the rest sits on (review finding 2), and it
independently fixes the fact that there is no way to remove a measurement at
all today.

**Build**

1. **`CandidateResolver`** — the one system (review finding 2). Given a cursor
   position, ask each registered provider for candidates, rank them, expose the
   top for pre-highlight, cycle with `Tab`.
   - Providers register a kind, a priority, and a `candidatesAt(cursor)`.
   - Ranking: by kind priority, then screen-space distance. Stable order, or
     `Tab` jitters between frames.
   - Pure parts (screen-space point-to-segment distance, ranking, cycle-index
     arithmetic) go in a testable module. Only the overlay needs WebGL.
2. **Element provider** — wraps today's `raycastVisible`. Behaviour must not
   change: this is a refactor with a test-suite-shaped safety net.
3. **Measurement provider** — line + markers only, **never the label sprite**
   (D9). Screen-space threshold ~8 px.
4. **`Line2` swap** — measurements draw with `Line2`/`LineGeometry`/`LineMaterial`
   at ~3 px. Wire `LineMaterial.resolution` into the existing resize path.
   **Verify `depthTest: false` still behaves** before building picking on it.
5. **Hover pre-highlight** + the D10 setting (`ifcviewer:settings:*` via a new
   central `Settings` module), default on. Throttle the hover raycast to one
   per frame and reuse `Viewer.lastPointer`.
6. **Removal** — "Clear measurements" tray action (📏, visible only when
   measurements exist, same idiom as Remove pivot); click-to-select a
   measurement; `Delete`/`Backspace` removes it. Stable ids on measurement
   records so a list panel stays possible later.
7. **D15** — measurements record which models their endpoints came from; they
   hide with the model and are removed with it.

**Risks specific to this step:** `Tab` must not trap keyboard users tabbing
through the real DOM panels. The element provider refactor is where a silent
selection regression would hide — lean on the existing selection tests.

**Manual test:** select elements near a measurement; delete one of several;
clear all; `Tab` through overlapping candidates; toggle hover off; hide a model
and watch its measurements go.

---

### Step 1 — what the plan got wrong

Each claim below was checked in the running app before code was written, per
the ⚠ banner and the lesson from `handoff-normalize-model-units.md`.

**Verified as stated (no change needed):**

- *The measurement line is a hairline that is hard to click.* True, and the
  reason is now measured rather than asserted: on this machine
  (ANGLE / D3D11 / RTX 2000 Ada) `gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE)`
  returns **`[1, 1]`**, so `LineBasicMaterial.linewidth` cannot widen the line
  by any amount. The `Line2` swap is the only route to a thicker line.
- *There is no way to remove a measurement short of Reset View.* True. With a
  measurement placed, the tray held exactly five actions — remove-clipping,
  clear-basket, show-hidden, remove-pivot, clear-transparency — and stayed
  hidden. `clearMeasurements()` had exactly one caller, `App.resetView`.
- *`raycastVisible` excludes measurements today.* True. Clicking dead on a
  measurement's start marker selected the **slab behind it**, and there was no
  way to touch the measurement at all.
- *`Line2` keeps `depthTest: false` behaviour.* Verified after the swap: a
  measurement taken through the building still draws over the slabs and beams
  in front of it, at ~3 px.

**Wrong, and fixed here:**

1. **`raycastVisible`'s measurement filter does NOT have to be removed.**
   D9, the risk list and Step 1 all say making measurements pickable means
   dropping the `!obj.userData.isMeasurement` guard and replacing it with
   arbitration. It does not. The measurement provider **projects the two
   endpoints to screen space** and measures pixel distance to the drawn line
   and markers — it never raycasts. So the filter stays exactly as it was, the
   element pick path is untouched byte-for-byte, and the regression the whole
   of D9 was written to prevent cannot happen through this route. This is
   strictly safer than the plan assumed, and it is why the "element provider
   refactor is where a silent selection regression would hide" risk did not
   materialise: there was no refactor.

2. **`Line2` extends `THREE.Mesh`.** `Line2 → LineSegments2 → Mesh`, so a
   `Line2` in the scene **is** collected by `raycastVisible`'s
   `obj instanceof THREE.Mesh` sweep. It is excluded only because the code
   sets `userData.isMeasurement = true` on it. The plan treats the fat-line
   swap as a pure draw-path change; it is also a pick-path change, and
   forgetting that flag would produce exactly the click-stealing regression D9
   warns about. **Step 2 must set the same flag on any snap-glyph geometry it
   adds to the scene.**

3. **`LineMaterial.resolution` belongs in the render loop, not the resize
   path.** The plan says to wire it into `Viewer.onResize`. `Viewer` has no
   reference to the measurement tool, and `MeasurementTool.update()` already
   runs from the render loop *before* `renderer.render`, on every frame that
   draws — including the frame a resize triggers. Setting it there is both
   simpler and correct for canvas changes a window `resize` event never fires
   for.

4. **The label does not fill the viewport at normal framing.** D9 cites a
   screenshot of the label "filling the whole viewport". At default fit on the
   Snowdon fixture it is a small plate at the midpoint: the sprite is
   world-scaled and clamped to ≤ 2.0 world units, so it only dominates when the
   camera is close to it. Excluding it from picking is still right — a
   world-scaled quad's screen area is unbounded as the camera closes in, and it
   is the only part of a measurement with area at all — but the justification
   is "unbounded", not "always huge".

**Deliberately deferred out of Step 1:**

- **Element hover pre-highlight.** D9 point 5 asks for the element candidate to
  get "its usual highlight treatment" on hover. Only measurements pre-highlight
  today. Lighting an element per-frame means going through
  `SelectionManager`'s variant cache and the
  hidden > transparent > highlighted > base precedence chain, which is a real
  tangle for a small gain: `Tab` stays legible because the measurement glowing
  means "Tab will take the measurement" and nothing glowing means "the
  element". The provider already accepts a `highlight` callback, so adding it
  later is a wiring change, not a redesign.
- The whole hover system stays **dormant until at least one measurement
  exists** (`isActive()` in `CandidateInput`), so the per-frame raycast costs
  nothing for anyone who is not measuring.

**Stricter than the plan sketched:** `Tab` is taken only when the pointer is
over the canvas, focus is on `document.body` or the canvas (never inside a
panel control), no Ctrl/Alt/Meta is held, and at least two candidates are under
the cursor. Any one of those failing leaves `Tab` to the browser.

---

### Step 2 — Snapping

**Depends on:** Step 1's `CandidateResolver` (snapping registers a provider).

**Build**

1. **Feature-edge extraction** — `EdgesGeometry(geometry, threshold)` per mesh,
   computed lazily on hover, cached keyed by the geometry object.
   Threshold a named constant, start 15–20°, **tune against a curved wall**.
2. **Candidates** — endpoint (feature-edge vertices), midpoint, nearest point
   on edge, face (today's raw hit). Priority endpoint > midpoint > edge > face.
   All local-space: apply `matrixWorld` (and the Step-0 group scale comes with
   it — see the note in `ModelManager`).
3. **Glyph overlay** — a distinct glyph per kind. This is what makes snapping
   trustworthy; an invisible snap is indistinguishable from a bug.
4. **D12** — `Tab` cycles snaps while placing, pick candidates otherwise.
5. **D13** — suppression key. **Still unanswered.** `Alt`, `Ctrl`, `Shift` are
   all taken; needs a decision before this step starts.

**Test:** a triangulated box yields exactly its 12 real edges and no diagonals.
That single test is the difference between snapping and snapping-to-artefacts.

**Manual test:** corner-to-corner on a wall; a curved wall (threshold check);
a dense model (hover cost); suppression key.

---

### Step 3 — Orthogonal mode

**Depends on:** Step 2 (D14 — the point comes from the snap, the face from the
raycast).

**Build**

1. **`measureMath.ts`** — plane projection, orthogonal distance, world normal
   from a hit (`face.normal` × the mesh's normal matrix), degenerate-face
   guards. Pure, tested.
2. **Face lock + feedback** — tint the face on hover, keep it tinted after the
   lock, draw the normal at the lock point, dashed-to-plane + solid-along-normal
   during the second pick. Right-click releases the lock.
3. **Mode selection (D3)** — buttons in a mode row + `P`.
4. **Label (D8)** — distance, unit, and a `⊥` marker in orthogonal mode.

**Risk:** tessellation normals. If the face tint shows stray triangles being
caught often, follow up with coplanar-face merging — but only if the manual
smoke says so.

---

### Step 4 — Element → element shortest distance

**Depends on:** nothing above, structurally. Last because it is the most
droppable.

**Build**

1. Context-menu item on a two-element selection (the `select-similar` pattern:
   selection-scoped, built from `SelectionState`).
2. AABB-vs-AABB first for a lower bound and an instant answer when the
   elements are far apart; then a bounded triangle-pair search with early exit.
3. A cap, and an honest "approximate" label above it. Navisworks itself
   approximates here (centre lines on parametric cylinders), so a stated
   approximation is in good company — a silent one is not.

**Risk:** O(n·m). If it misbehaves on real models, drop the step; nothing else
depends on it.

---

### Step 5 — Undo retrofit *(D7, folded in)*

Fold into whichever step touches the placement state machine last, rather than
running as a sixth pass: a completed measurement is one command, a delete is
one, mid-placement `Ctrl+Z` cancels the pending placement.
