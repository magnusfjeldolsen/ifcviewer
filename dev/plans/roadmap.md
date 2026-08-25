# Roadmap & open optimization PRs

This file is the **single source of truth** for upcoming work. A fresh agent starting from main with no chat context should be able to read this file, pick a card, and ship it.

Each card has:
- **Status** — `queued` / `in-progress` / `blocked` / `done`
- **Effort** — `S` ≤ 1 day, `M` 1–3 days, `L` > 3 days
- **Why** — the user-visible problem this solves
- **What** — concrete change in files/architecture terms
- **Risks** — known gotchas
- **Source** — where the design discussion lives (commit, PR, plan doc)

When a card lands, move it to the **Done** section at the bottom with the PR number, and add a one-line *Outcome* note (what actually happened, surprises, new follow-ups it spawned).

When a new card is created, default to `queued` and give it a stable slug (kebab-case) so cross-references work.

---

## Queued

### `loading-overlay-and-percentage` — Loading overlay with real progress percentage
- **Status:** queued
- **Effort:** S
- **Why:** Big-model load (191 MB IFC) takes ~60 s on the main thread. Today the UI gives no progress feedback at all — `setStatus` writes a plain-text label. Users stare at a frozen viewport for a minute.
- **What:**
  - Wire `src/ui/LoadingOverlay.ts` (already exists) through `src/core/App.ts:handleFile`.
  - Real progress: `file.arrayBuffer()` byte count for the read stage; `StreamAllMeshes` callback count vs `GetIfcEntityList` total for the parse stage.
  - Convert `sessionStore.saveModel(...)` to fire-and-forget so the 2–5 s IndexedDB write doesn't block the UI returning. Surface errors via the status line.
- **Risks:** if the user closes the tab during the 2–5 s async save, that model isn't persisted — acceptable tradeoff, but maybe show a "saving..." indicator until the write resolves.
- **Source:** Performance research from the `claude conversation 2026-05-12`, summarized in `feature/element-inspector` audit. Section 3.1 + 3.10 of the original design doc.

### `worker-type-property-cache` — Stop re-reading type properties per element
- **Status:** queued
- **Effort:** S–M
- **Why:** Bulk property throughput measures **~100–200 elements/sec** (observed on PR #42 manual smoke, 2026-08-03). Much of the per-element cost is irreducible, but the **type-side work is repeated for every instance**. `fetchElementProperties` calls `getTypeProperties` twice per element — once directly for type psets, and again inside `getMaterialsProperties(..., includeTypeMaterials=true)`, which re-fetches the type objects itself (`node_modules/web-ifc/web-ifc-api.js:71224`) — and then re-resolves that type's psets and materials recursively for each instance. 2 000 walls sharing 5 types do the type-side work 2 000 times instead of 5. Typical Revit-exported IFC is type-pset-heavy, so this is likely a large share of the per-element cost.
- **What:**
  - Per-model cache in the worker: type-object expressId → resolved raw type psets / type materials. Cleared in `disposeModel` alongside `unitTables`.
  - Fetch the element's type objects **once** and serve both psets and materials from them, instead of `includeTypeMaterials=true` re-deriving them.
  - Cache the **raw** resolved lines, not built `PropertyGroup`s: the normalizer mutates what it builds (`markInheritedRecursively`, `group.inheritedFromType`), so sharing built objects would cross-contaminate elements. Rebuilding groups per element from cached raw stays safe.
  - Measure before/after against RIB.ifc and record the numbers — the win is proportional to how type-heavy the model is, so it needs measuring rather than predicting.
- **Risks:** output must be byte-identical; add a test asserting cached and uncached fetches deep-equal. Cache lifetime must follow the model, or a re-loaded model serves stale type data.
- **Source:** PR #42 manual smoke + reading `web-ifc-api.js` `getRelatedProperties` / `getMaterialsProperties`.

### `mt-wasm-coop-coep` — Multi-thread web-ifc via cross-origin isolation
- **Status:** blocked (web-ifc 0.0.77 MT build is incompatible with our Vite/ESM bundling — see Blocker)
- **Effort:** L (header plumbing is trivial; the blocker below makes the real fix a large change)
- **Why:** `node_modules/web-ifc/web-ifc-mt.wasm` already ships in `public/` but never loads because the dev server and GitHub Pages don't send the COOP/COEP headers that enable `crossOriginIsolated`. With it enabled, web-ifc's `Init()` auto-selects the MT artifact — CPU stages *would* get ~2–3× faster on multicore machines.
- **Blocker (found 2026-05-18):** Enabling cross-origin isolation works, but it does NOT fall back gracefully. With `crossOriginIsolated === true`, web-ifc's `Init()` selects the multi-threaded build, which is broken under ESM bundling. In `web-ifc-api.js` the pthread pool does `new Worker(_scriptName)` where `_scriptName = document.currentScript?.src`. `document.currentScript` is `null` for ES modules (how we `import` web-ifc), so the worker URL is `undefined` → the browser fetches `/ifcviewer/undefined` → gets `index.html` → `Uncaught SyntaxError: Unexpected token '<'`, once per CPU core. The parser breaks. The Emscripten escape hatch (`Module.mainScriptUrlOrBlob`) is not exposed by `IfcAPI.Init(customLocateFileHandler?, forceSingleThread?)`. web-ifc 0.0.77 is the latest published version — no upstream fix to upgrade into. Verified live: enabling the headers floods the console with worker errors and breaks `parse`.
- **To unblock:** either (a) load web-ifc via its IIFE classic-script build (`web-ifc-api-iife.js` through a `<script>` tag instead of `import`) so `document.currentScript` resolves — a real `IfcParser` architecture change with its own risk surface; or (b) wait for an upstream web-ifc release that fixes MT worker spawning under bundlers. Header + service-worker plumbing alone is useless without one of these.
- **Original design (kept for when this unblocks):** dev + preview `vite.config.ts` headers `Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy: credentialless`; a service worker for GitHub Pages prod (Pages can't set headers) that re-broadcasts them; `credentialless` (not `require-corp`) keeps cross-origin assets like the Google Analytics script working.
- **Source:** Performance research section 3.2; blocker finding 2026-05-18.

## Scope Ops + Undo phase (epic — see `dev/plans/phase-scope-ops-and-undo.md`)

The reversible editing layer the Data Insight phase sits on: act on a `Scope`
(hide / isolate / fade / select-similar) via a selection-aware right-click
menu, with global Ctrl+Z / Ctrl+Y. Two independent keystones first
(`bulk-property-fetch-and-cap` for data, `undo-redo` for interaction), then the
features build on them. Confirmed decisions live in the epic doc.

**Order:** ~~`bulk-property-fetch-and-cap` ‖ `undo-redo` → `context-menu` +
`element-appearance` → `select-similar`~~ (all shipped) → (Data Insight — see
that epic's revised order) → **`undo-redo-retrofit`**, which is orthogonal to
Data Insight and now bundles with `measurement-modes` (both touch
`MeasurementTool`; do them in one visit).

### `undo-redo-retrofit` — Make clipping + measurement undoable
- **Status:** queued (depends on `undo-redo`)
- **Effort:** S–M
- **Why:** The existing tools should join the history once the contract is proven.
- **What:** Clipping drag (pointer-down→up) = one command; create/remove plane = one each. A completed measurement = one command; delete = one. Mid-placement Ctrl+Z cancels the pending placement.
- **Risks:** tool visual handles must re-sync on undo/redo.
- **Source:** `dev/plans/handoff-undo-redo.md` (§ Retrofit).

## Data Insight phase (epic — see `dev/plans/phase-data-insight.md`)

Quickly understand the data in loaded IFC model(s): select, filter, colorize,
aggregate. Built on one shared `Scope` (a set of elements) with several
sources (model / basket / filter) and consumers (visibility / coloring /
aggregation). Ships feature-by-feature, foundational-first.

_`selection-basket` shipped (PR #36, 2026-05-26) — see Done. It is the first
`Scope` source; the cards below build on it._

**Revised order (2026-08-24), after auditing what aggregation actually needs:**

```
worker-type-property-cache  → schema-discovery → parameter-coloring → data-aggregation-tabs
   (throughput)                (the pickers)      (cheap proof)        (capstone)
```

The first two are **prerequisites**, not nice-to-haves:

- **Throughput.** Bulk reads measure 100–200 elements/sec (PR #42 smoke).
  Aggregation is the one feature that reads *every* element in a scope, so a
  2 000-element pivot takes 10–20 s and a whole-model one takes minutes.
  `worker-type-property-cache` is filed under Queued as a perf card; for this
  epic it is a blocker. Do it first, and measure.
- **Schema discovery.** `describeSchema` is still
  `throw new Error('not implemented yet')`. Both the pivot ("group by ___,
  aggregate ___") and the coloring picker need to know which parameters exist
  across a `Scope` before they can render a dropdown — today the app only knows
  the properties of elements the user already clicked. New card below.

`parameter-coloring` goes **before** the tabs deliberately: it needs the same
schema picker and numeric extraction but no tab infrastructure, so it is the
cheapest end-to-end proof that the data pipeline works — and it makes any
remaining throughput problem impossible to ignore.

`filter-by-parameter` is *not* a prerequisite — its lighter half shipped as
`select-similar` (PR #44), and the isolate-the-rest half is useful on its own
schedule.

### `schema-discovery` — What parameters exist across a Scope
- **Status:** queued (prerequisite for `parameter-coloring` + `data-aggregation-tabs`)
- **Effort:** M
- **Why:** Every authoring UX in this epic starts with "pick a parameter", and
  nothing can populate that list. `WorkerPropertyRepository.describeSchema`
  throws; `ModelSchema` only models `classCounts`. Without this, aggregation
  and coloring can only offer parameters from elements already clicked.
- **What:** Given a `Scope` (or a model), fold in the worker over the same
  `readProps` spine `findMatching` uses, and return per parameter path: the
  element count carrying it, the value kind (numeric / text / boolean /
  enumerated), the unit, and — for discrete values — the distinct set with
  counts. Numeric paths additionally carry min/max, which the coloring scale
  needs for its domain and the pivot needs to sanity-check a sum.
  Extend `ModelSchema` accordingly. Cancellable and progress-reporting like
  the other bulk jobs.
- **Units — decide here:** `PropertyFlatRow` already separates `rawValue` from
  `unit` ("so aggregation can operate on raw numerics") and there is a
  per-model `unitTable`, but nothing normalizes *between* models. Summing
  volumes across a millimetre model and a metre model silently produces a
  wrong number, and multi-model is first-class in this app. Either normalize to
  SI at the fold and format on the way out, or refuse to aggregate a path whose
  unit disagrees across the scope. Pick one before the first sum ships.
- **Risks:** it is a full-scope read, so it inherits the throughput problem —
  hence the ordering. Cache per (model, scope-signature) or the picker re-folds
  on every open. Paths are not uniform across elements: a parameter present on
  10 of 900 elements must be offerable but visibly rare, or users will sum a
  column that is 99 % empty and not notice.
- **Source:** this epic, feature 3 (the unbuilt half); PR #42 left
  `describeSchema` stubbed deliberately.

### `filter-by-parameter` — Show elements matching a parameter
- **Status:** queued (bulk property access shipped in PR #42; `element-appearance` shipped in PR #39). The lighter form — `select-similar`, which selects rather than isolates — shipped in PR #44, so what is left here is the isolate-the-rest half plus multi-criteria matching.
- **Effort:** M
- **Why:** From a selected element/class, show all elements sharing a parameter value and hide the rest — fast "find everything like this."
- **What:** Pick parameter(s) + match → matching elements become a `Scope`, isolated via `element-visibility`. Predicate evaluated across the model via bulk property access (the worker).
- **Risks:** evaluating a predicate over thousands of elements — needs the worker bulk fetch.
- **Source:** `dev/plans/phase-data-insight.md` (feature 4); inline form in `dev/plans/handoff-select-similar.md`.

### `parameter-coloring` — Color a scope by a parameter (color scale)
- **Status:** queued (depends on `schema-discovery`; do after `worker-type-property-cache`)
- **Effort:** M
- **Why:** See data spread visually — color elements by a parameter's value, like Naviate in Revit.
- **What:** Apply a color scale (gradient for numeric, categorical for discrete) to a chosen parameter across a `Scope` (model / basket / filter), with a legend. Temporary; restored on clear. Reuses the highlight-variant material mechanism.
- **Risks:** legend UX; large-model color application cost (use bulk fetch).
- **Source:** `dev/plans/phase-data-insight.md` (feature 5).

### `data-aggregation-tabs` — Pivot-style aggregation in workspace tabs
- **Status:** queued (capstone — depends on bulk property access + the `Scope` spine + `schema-discovery`, and on `worker-type-property-cache` for it to be usable at model scale)
- **Effort:** L
- **Why:** Quickly understand a model's data — sum / avg / count over a scope, Excel-pivot-style. The headline of the Data Insight phase.
- **What:** A tabbed workspace (MODEL + renamable, session-persisted data-agg tabs). Each tab pivots a `Scope` (model / basket / filter): group + aggregate, show contributing elements + result tables; graphs + report/export later. Sub-phased: tab infra → pivot → graphs/export.
- **Risks:** the pivot authoring UX and the tab / session-persistence model are the design risk — each gets its own hand-off doc.
- **Source:** `dev/plans/phase-data-insight.md` (feature 6).

### `measurement-modes` — Solibri-style measuring (point, orthogonal, face-to-face)
- **Status:** queued (independent of the Data Insight epic — schedule freely; bundle with `undo-redo-retrofit`)
- **Effort:** M
- **Why:** Today's tool measures point-to-point only, so the common question —
  *"how far is that column from the wall?"* — makes the user hunt for the
  shortest path by eye and get an answer that is wrong by however far off-normal
  they clicked. Solibri answers it directly: pick the wall face, pick the
  column, and the distance is measured along that face's normal.
- **What:** Measurement *modes*, chosen before or during placement:
  - **Point → point** — today's behaviour, unchanged and still the default.
  - **Surface → point (orthogonal)** — first pick establishes a face; the
    second point is projected onto that face's plane and the distance reported
    along the normal. Draw the projection foot and the normal segment, not just
    a line between the raw picks, so the measurement is self-explaining.
  - **Surface → surface** — perpendicular distance between two parallel-ish
    faces (clear span between walls). Needs a tolerance for "parallel enough"
    and an honest refusal when they are not.
  The geometry is already available: `raycastVisible` returns `hit.face`, so
  the world-space normal is `face.normal` transformed by the mesh's
  `normalMatrix`. Extract the maths into a pure module (`measureMath.ts`) the
  way `orbitMath.ts` was split out of `Viewer` — `MeasurementTool` needs WebGL
  and cannot be constructed under test.
- **Risks:** face normals on IFC geometry are only as good as the tessellation —
  a curved or triangulated "flat" wall gives slightly different normals per
  triangle, so surface mode needs to either snap to a dominant plane or show
  the user which face it locked onto. Mode switching mid-placement must not
  strand a half-placed measurement. The existing tool is 481 lines with its own
  pointer handling, preview, and label sprites; adding modes without splitting
  placement state from rendering will make it unmaintainable.
- **Bundle with `undo-redo-retrofit`:** that card also rewrites this tool's
  placement lifecycle (a completed measurement = one command, mid-placement
  Ctrl+Z cancels). Doing both in one visit avoids reworking the same state
  machine twice.
- **Source:** user request 2026-08-24 (Solibri comparison).

### `settings-panel` — User-tunable caps and preferences
- **Status:** queued
- **Effort:** M
- **Why:** Several internal constants want to be user-tunable (multi-select cap, highlight color, click-vs-drag threshold). User has asked for a settings UI. No panel today.
- **What:**
  - New `src/ui/SettingsPanel.ts` mounted in `src/core/App.ts`.
  - Keys persisted in localStorage under `ifcviewer:settings:*`.
  - Each surfaced setting reads from a central `Settings` module so internals can subscribe.
  - First candidate already centralized for this: `BULK_INTERSECT_GUARD` in `src/inspector/limits.ts` (PR #42).
- **Risks:** scope creep — limit v1 to caps the user has explicitly asked for.
- **Source:** PR #21 discussion (multi-select cap request).

### `render-perf-orbit-lag` — Investigate slow orbit on big models
- **Status:** queued
- **Effort:** unknown (research first)
- **Why:** User reports orbit / pan / zoom is slow on large models (post-PR #21). Likely cause: 100k+ draw calls per frame because each `THREE.Mesh` is a draw call and materials don't deduplicate yet.
- **What:** Profile with the Chrome DevTools performance tab on a 100k-mesh load. Most likely root cause is draw-call count + material switching → fixed by `share-materials-by-color` and (longer term) `instanced-meshes`. But there could be other causes: shadow map size, expensive orbit-controls math, etc. **Investigate first, then pick a fix.**
- **Risks:** if the answer is "we need InstancedMesh", that's a big refactor (per-instance expressID tracking, raycast adjustments, marquee classifier walking instances). Budget L if so.
- **Source:** PR #21 user observation.

### `instanced-meshes` — Switch repeated geometry to InstancedMesh
- **Status:** blocked (depends on `render-perf-orbit-lag` investigation)
- **Effort:** L
- **Why:** Large models routinely have thousands of identical rebars / bolts / columns / panels. One `InstancedMesh` per shared geometry collapses 10 000 draw calls into 1. Massive memory savings too.
- **What:**
  - Detect repeated geometry post-parse (hash positions+indices, group by hash).
  - Construct `THREE.InstancedMesh` per group, set per-instance matrix and `expressID` attribute.
  - Adapt `SelectionManager` (per-instance highlight via instance color or per-instance material — Three.js supports this).
  - Adapt `MarqueeSelector.classifyMesh` to walk instance matrices.
- **Risks:** raycasting changes — Three.js's InstancedMesh raycast returns `instanceId` not Mesh; current `raycast.ts` walks `userData.expressID`. Refactor needed.
- **Source:** Performance research section 3.7.

### `frustum-cull-audit` — Verify Three.js culling actually runs
- **Status:** queued (bundle with `render-perf-orbit-lag`)
- **Effort:** S
- **Why:** Three.js culls per-mesh by default but we have no test asserting this. A future PR could regress it silently.
- **What:** Add a unit test asserting `mesh.frustumCulled === true` on every mesh from `ModelManager.addModel`. Add a comment near `addModel` explaining the dependency.
- **Risks:** zero.
- **Source:** `dev/plans/phase-perf-low-hanging-fruit.md`.

---

## Done

### `phase-element-inspector` — Click-pick element-properties inspector (PR #19, merged 2026-05-11)
- **Outcome:** Phase 1–4 of inspector shipped (model lifetime change, SelectionManager, panel with Tree/Flat toggle, multi-select intersection with `varies` sentinel, single-model-lock checkbox). Surfaced two real bugs that the regression test now catches: web-ifc's `getPropertySets(..., includeTypeProperties=true)` shortcut silently drops instance-level psets; and web-ifc returns measure-wrapped numerics in a different shape (`{type:4, _representationValue, name}`) than enums/labels (`{type:N, value}`) — normalized via `normalizeTypedValue` in `WebIfcPropertyRepository`. RIB.ifc regression test in `tests/inspector-repository-rib.test.ts` guards both.

### `phase-inspector-refactor` — Split InspectorPanel + WebIfcPropertyRepository (PR #20, merged 2026-05-12)
- **Outcome:** Pure refactor before more features land. InspectorPanel (1221 → 703) and WebIfcPropertyRepository (902 → 347) split along natural seams. Tests held — 279 / 279 passing throughout.

### `phase-marquee-selection` — Alt-drag marquee (PR #21, merged 2026-05-13)
- **Outcome:** AutoCAD-convention window/crossing selection + the O(N×M) → O(N) highlight scale fix combined. Three issues caught during smoke that became commits in the same PR: stock `SelectionBox`'s far-plane normal flip (works for sphere-center tests, fails for AABB tests); `applyMany` lock asymmetry (preserved insertion-order, not existing-selection model); and the per-frame render lag on big models (orbit/pan/zoom) deferred to `render-perf-orbit-lag` / `share-materials-by-color`. 350 → 356 tests.

### `clipping-ux-papercuts` — Direction-aware drag + perspective-correct speed (PR #22, merged 2026-05-13)
- **Outcome:** Replaced the screen-Y-delta heuristic in `ClippingTool.onPointerMove` with screen-space projection of the plane normal plus perspective-aware world-per-pixel at the handle's depth. Single pure function `computePlaneDelta` co-located in `src/tools/ClippingTool.ts`; 9 unit tests in `tests/clipping-math.test.ts` cover all axis cases, the diagonal case, the parallel-to-view edge case, and distance/FOV invariance. Deleted per-frame `getModelSize` scene-traversal (small perf win on big models). Horizontal-surface drag now follows the cursor; drag speed is cursor-pixel-equivalent at any camera distance / FOV / model unit. 356 → 365 tests.

### `contextual-action-tray-and-remove-clipping` — Bottom-right floating action tray + Remove clipping button (PR #23, merged 2026-05-13)
- **Outcome:** New `src/ui/ContextualActions.ts` tray container with a `register(action)` API that re-evaluates visibility predicates only on subscribed state changes (no polling). `ClippingTool` gained `hasClipPlane()` + `onStateChange(cb)` (additive, mirrors the `SelectionManager.onChange` shape). One button registered for v1 — `✂ Remove clipping` — appears bottom-right when a clip plane is active and dismisses only the plane (measurements, selections, camera, inspector all preserved). CSS matches the existing panel idiom (semi-transparent white, 8px radius, soft shadow, brand-blue icon). Forward-compatible: future "Remove measurements" / "Show hidden" / "Reset transparency" buttons plug in via `register`. 365 → 382 tests.

### `parse-memory-hygiene` — Free Vector<PlacedGeometry> during StreamAllMeshes (PR #24, merged 2026-05-13)
- **Outcome:** Original premise was half-wrong. The `node_modules/web-ifc/web-ifc-api.d.ts:71-75` declares `FlatMesh.delete()` but at runtime `FlatMesh` is a plain JS object — calling `.delete()` throws `not a function`. **However**, the inner `flatMesh.geometries` IS a real emscripten-bound `Vector<PlacedGeometry>` (own property `$$` confirms the C++-class marker) and DOES leak its heap allocation if not freed. The corrected fix: `(flatMesh.geometries as unknown as { delete(): void }).delete()` at the end of the `StreamAllMeshes` callback. Caught via an empirical runtime-shape diagnostic against RIB.ifc; documented inline in `src/parser/IfcParser.ts` so the next person reading the d.ts file doesn't fall into the same trap. Cast through `unknown` is needed because the d.ts for `Vector<T>` also omits `.delete` despite it existing at runtime. 382 → 382 tests (no new tests; existing parser + property tests act as smoke).

### `dev-profiling-doc` — Document the Chrome DevTools perf workflow (PR #25, merged 2026-05-13)
- **Outcome:** New `dev/profiling.md` covering the three measurement tools we actually use (`performance.memory` console snippet, Memory tab heap-snapshot diffing, Performance tab Long-Task identification). Includes optional `renderer.info` access via a temporary `window.__viewer` hook, a reproducible test method, two real measurement gotchas (session-restore pollution + duplicate-name detection blocking re-load), and dated baseline numbers measured live in Chrome 147 against `main` at `8061b53`: RIB.ifc cold-load 0.51 s / 773 meshes / +88 MB heap; Snowdon Towers + RIB combined 18,027 meshes / ~340 MB total heap. Snowdon clean-load number deferred to a future re-measure (session-restore interference + duplicate-name blocked the third measurement attempt). Common-diagnoses section maps each typical complaint ("orbit laggy", "memory keeps growing", "load freezes the tab", etc.) to the queued roadmap card that addresses it.

### `share-materials-by-color` — Material cache in ModelManager (PR #26, merged 2026-05-13)
- **Outcome:** `ModelManager.addModel` now builds a per-call `Map<string, MeshPhongMaterial>` keyed by `${r},${g},${b},${a}` (each component `toFixed(6)`) and reuses the cached instance when the color matches. The cache is intentionally local to one `addModel` call — different models keep their own material instances, which keeps `removeModel`'s dispose loop safe (no cross-model material references). `removeModel` now dedupes via a `Set<Material>` before disposing so a 17k-mesh model with ~30 distinct colors calls `dispose()` 30 times, not 17k (idempotent in three, but the honest accounting matters for tests and future debugging). **SelectionManager synergy held automatically:** its `highlightVariants` is a `WeakMap<Material, Material>` keyed by the original reference, so shared originals → shared variants with zero changes to selection code. 5 new tests in `tests/model-manager.test.ts` (`material sharing by color` describe block) cover: same-color sharing, alpha-distinguishes-material, no cross-`addModel`-call sharing, dedup'd dispose count, and the `meshesByExpressId` index surviving shared materials. 382 → 387 tests.

### `cached-parsed-geometry-idb` — Cache parsed geometry in IndexedDB (PR #27, merged 2026-05-15)
- **Outcome:** New `src/services/GeometryCache.ts` — pure `serializeMeshes` / `deserializeMeshes` (ParsedMesh ↔ ArrayBuffer), SHA-256 hashing, approximate-LRU eviction at a 500 MB cap. `SessionStore` bumped to IDB v3 with a `geometry-cache` object store. `App.handleFile` hashes the buffer in parallel with the parse and fire-and-forget writes the parsed geometry; `restoreSession` checks the cache first — on a hit it hydrates the scene instantly from cached typed-array buffers and schedules a background re-parse (`IfcParser.openForProperties`, geometry-free) to refill web-ifc's STEP graph for the inspector. Surfaced a latent bug: `WebIfcPropertyRepository.get` ran `fetch`'s synchronous prefix eagerly — fixed by deferring it into the enqueue thunk so a property query during the restore gap waits for the background re-parse. New `tests/geometry-cache.test.ts`; 387 → 397 tests.

### `render-on-demand` — Skip frames when nothing changed (PR #28, merged 2026-05-18)
- **Outcome:** `Viewer` gained a `needsRender` flag + `requestRender()`; `animate` still polls OrbitControls every frame (so its `'change'` event fires) but only calls `renderer.render` + the update callbacks on frames where something changed. `requestRender` is wired into every non-camera mutation site: `ModelManager` (add / remove / setVisible), `SelectionManager` (highlight changes), `ClippingTool` and `MeasurementTool` (new optional `requestRender` dep), and `CameraAnimator` (new `onTick` so fly-to renders each frame). Idle CPU/GPU drops to ~0. New `tests/render-on-demand.test.ts`; 397 → 403 tests.

### `progressive-scene-fill` — Meshes appear during StreamAllMeshes (PR #30, reverted 2026-05-19)
- **Outcome:** Implemented as main-thread streaming — `IfcParser.parseStreaming`, a `ModelManager.beginStream / appendMeshes / endStream` API, and a `FrameYielder` time-slicer. It worked for huge models, but main-thread streaming needs a two-pass parse (one `StreamAllMeshes` pass for product IDs, one `StreamMeshes` pass for geometry — streamed geometry is only valid inside a callback, and the loop must yield to stay responsive), which made medium models (~48 MB) load slower than the old blocking parse. Reverted; PR #30 closed. The proper fix — single-pass, off the main thread — is `web-worker-parse`.

### `web-worker-parse` — Move IFC parsing into a Web Worker (PR #33, merged 2026-05-21)
- **Outcome:** All web-ifc work — geometry parsing and property queries — runs in a plain module Web Worker (no cross-origin isolation needed). `IfcParser` + `WebIfcPropertyRepository` deleted; replaced by `ifcWorker.ts`, `WorkerIfcParser`, `WorkerPropertyRepository`, the extracted `fetchElementProperties` core, and `ifcMessages`/`types`. The worker owns all web-ifc state behind a serial queue, so `App.parseQueue` and `App.modelIdMap` are gone. `ModelManager` regained `beginStream/appendMeshes/endStream`; main thread renders progressively from worker batches. Single-pass parse — fixes the medium-model slowdown; UI stays at 60 fps during loads. 403 → 432 tests. Two follow-up fixes after merge-review: (1) the buffer was being *transferred* to the worker, which detached the main-thread copy and silently broke `sessionStore.saveModel` → reloads showed "File missing"; switched to structured-clone. (2) a pre-existing flaky leaked spinner-timer in `inspector-panel.test.ts` (fired post-teardown → `document is not defined`) was surfaced by the bigger suite; fixed by disposing mounted panels in `afterEach`. Also gitignored `.claude/agent-memory/` (the feature-implementer agent had committed its scratch).

### `selection-basket` — Curated element set (M+/M−/MR/MC) (PR #36, merged 2026-05-26)
- **Outcome:** The first `Scope` source (Data Insight feature 1). `SelectionBasket` (pure model: add/remove/clear/onModelRemoved/serialize, deduped by modelId:expressId), `SelectionBasketPanel` (M+/M−/MR/MC cluster), `SelectionManager.selectExactly` (lock-bypassing recall so MR spans models without mutating the single-model-lock), session persistence via `App.buildSessionState`, and a tray "Clear basket" button. Manual testing reshaped the entry-point UX: the original subtle inspector ▲ button was dropped (it also clipped the inspector's collapse/expand button at 36px — a regression) in favour of surfacing the whole toolbar on any live selection. 432 → 481 tests. Next: the `Scope` it produces is consumed by the Scope Ops + Undo phase (visibility / appearance / select-similar) and later Data Insight coloring / aggregation.

### `undo-redo` — Global undo/redo (Ctrl+Z · Ctrl+Y) (PR #38, merged 2026-05-27)
- **Outcome:** The interaction keystone of the Scope Ops phase. `Command` pattern + a single `HistoryManager` over before/after mementos, Ctrl+Z / Ctrl+Y with an input-focus guard, one command per user-perceived gesture (a 1000-element marquee is one undo). Shipped with selection undo + basket undo. The `isApplying()` re-entrancy guard — undo must not push a new command — was the correctness crux as predicted. Camera is never recorded; history clears on model add/remove.

### `context-menu` + `element-appearance` — Right-click menu, hide / isolate / transparent (PR #39, merged 2026-05-27)
- **Outcome:** Shipped together as planned. `src/ui/ContextMenu.ts` opens scoped to the **current selection** (CM2: no raycast, no select-on-right-click — correcting the original draft, see commit 81cbeda). `AppearanceManager` holds one mutually-exclusive state per element (normal / hidden / transparent) with normalize-then-apply transitions; transparency reuses the highlight-variant material mechanism; tray recovery actions for hidden / transparent elements. Undo-aware and session-persisted. Supersedes the old `element-visibility` card, which is now deleted rather than kept as a stale reference.

### `element-key-codec` — Centralize makeKey (PR #40, merged 2026-05-29)
- **Outcome:** Pure refactor ahead of the bulk work. `src/inspector/elementKey.ts` owns `makeKey(modelId, expressId)`; all five former copies (four `makeKey` locals + the inline codec in `InspectorPanel.multiKey`) are gone.

### `bulk-property-access` Phase 1 — Worker-side intersection fold (PR #41, merged 2026-08-03)
- **Outcome:** The risk slice of `handoff-bulk-property-access.md`, validating both architectural bets in production before building on them. `intersection.ts` became an incremental fold (`intersectSeed` / `intersectStep` / `intersectFinalize`) with the batch function kept as a thin wrapper and a regression-lock test asserting fold ≡ batch across same-class / mixed-class / all-equal / all-distinct / materials / direct-rows / cross-model. The worker reads each element through `getOne` and folds it, holding only the running result (O(1) memory in N), and posts one synthetic result plus throttled progress. Both go/no-go criteria held on manual test: drill-down after a bulk intersect stayed in **ms** (the no-memo-populate trade-off is fine), and the intersected display matched the old main-thread result. 481 → 592 tests.

### `bulk-property-access` Phase 2 — Cancel, guard, enumerate, findMatching (PR #42, merged 2026-08-03)
- **Outcome:** Completes the data keystone. **Cancellation:** `cancel` is handled synchronously in the worker's `onmessage` and never enqueued (queuing it would be useless — the job it cancels is at the head of the queue); bulk reqIds register at *dispatch*, so a job queued behind a long-running one is cancellable too; the running job bails at its next chunk boundary and posts nothing, so a partial fold is never committed. `BulkRequestCancelled` lets the panel tell "you asked me to stop" from a real failure. **The 1 000 refusal is gone** — below `BULK_INTERSECT_GUARD` (10 000, in the new `src/inspector/limits.ts`) it just computes; above it, "Compute anyway" rather than a wall. The chunk loop became a shared `readProps` so chunking / yield / progress / cancel have one implementation. `enumerateExpressIds` now returns `Promise<number[]>` (the stubbed AsyncIterable is gone) and resolves "all products" through the `IFCPRODUCT` supertype rather than a hand-listed class set. `findMatching` runs the predicate in the worker and returns ids only; the predicate lives in the pure `matchValue.ts` (single + enumerated matchable, quantity excluded as fragile, present-and-equal, exact-path). 592 → 626 tests. **Surprise:** `getMany` was never built — the reduce-in-worker design removed every near-term consumer, so it stays deferred to whichever feature first genuinely needs full props on main. **Follow-up spawned:** `worker-type-property-cache` (bulk throughput measured ~100–200 elements/sec; type-side work repeats per instance).

### `select-similar` — Match every element like this one (PR #44, merged 2026-08-18)
- **Outcome:** Three grains, one query type. Right-click offers **category** (the IFC class, narrowed by `PredefinedType` — a Revit floor and a structural foundation are both `IfcSlab` and only that separates them) and **type** (the linked `IfcTypeObject`, i.e. the authoring-tool family type); any matchable inspector property row offers select-by-value. All three build a `SimilarQuery` resolved by `enumerateExpressIds` / `findMatching` in the worker and applied through `selectExactly` — one undo step for the whole set. Menu labels name the value, so a row says what it will do before you click it.
- **Manual testing overturned three assumptions, none of which a mocked test could have caught:**
  - `GetTypeCodeFromName` **hashes** rather than looks up: `GetTypeCodeFromName('IfcSlab')` → 200263316 vs the real `IFCSLAB` 1529196076. It returns a plausible non-zero code for any string, so the `if (!typeCode) throw` guard never fired and every class query enumerated an empty set. Numeric `ifcTypeCode` is now carried end-to-end, and a test asserts the call never returns.
  - **`ObjectType` is not the type discriminator.** RIB.ifc carries it on all 121 beams, which is why it was picked; Snowdon Towers carries it on **0 of 54 columns and 0 of 917 beams** while having a type object on all of them. The type object is now preferred with `ObjectType` as fallback.
  - Revit writes `Name = "Family:Type:<ElementId>"` with the id repeated in `Tag`, so matching by name found only the source element. `stripAuthoringIdSuffix` removes it.
- **Also from manual test:** the menu was built from `SelectionManager`'s placeholder identities (`ifcClass: ''`, `ifcTypeCode: 0`) and so offered "all elements" and never a type row — `App.enrichSelection` now resolves the real identity from the repository first. And the single-selection-only rule was wrong: two floors share a category as much as one does, so `sharedSource` resolves what a multi-selection agrees on, per field, dropping what it doesn't (capped at 50 elements — each is a worker round-trip and the menu must open instantly).
- **Fixture lesson:** `assets/ifcs/RIB.ifc` is not version-controlled and was swapped mid-review for a different export (29 slabs where there were 37, no `IfcBeam` at all), breaking every pinned expressId and count. The e2e tests now derive their targets from whatever file is present and assert invariants; absolute counts live in the tracked Snowdon fixture only. 626 → 684 tests.
- **Not built:** the by-parameter *submenu* (`ContextMenu` has no flyout rendering) — the by-value affordance lives on the inspector rows instead, where the value is already on screen.

### `orbit-about-cursor` — Rotate and zoom about what's under the cursor (PR #47, merged 2026-08-24)
- **Outcome:** Two features turned out to be one bug. `OrbitControls.target` is overloaded — it is both the orbit centre *and* the point `update()` makes the camera look at every frame — and `placePivot` stored the pivot there, so placing a pivot moved the camera on the *first orbit afterwards*. The pre-existing `'pivot-transition'` mode only deferred that snap to the user's next gesture, where it still reads as the view lurching; `dev/plans/fix-pivot-no-recenter.md` had explicitly accepted that trade ("masked by the user's own drag gesture" — it isn't). Splitting the roles fixed the re-centre and gave orbit-about-any-point with the same mechanism: `controls.target` is now a **view anchor** always on the camera's forward axis (so `lookAt` is a permanent no-op) and the pivot lives in the new `PivotState`. Rotation applies the same rigid rotation to camera *and* anchor, so the anchor lands back on the new forward axis at the same distance and there is nothing left to correct. 684 → 734 tests.
- **Prior art changed the design.** Navisworks validated the two-point model outright (unlocked, "the pivot point is set at the position of the cursor"; `Ctrl+L` locks it; it auto-unlocks when the pivot goes **off-screen**, and can centre on the selection). ArcGIS Pro named the empty-space problem — *"You cannot click the sky to navigate because the tool cannot determine how far away you want to go"* — so everyone falls back rather than solving it. Blender cost us a rewrite of the zoom: a dolly step proportional to the *remaining* distance is its documented "viewport wall", where increments shrink until movement stops entirely and the user is stranded short of the surface. Zoom is geometric instead, with the distance re-derived from each event's raycast (the job Blender's Auto Depth does), and there is a regression test that a repeated dolly never converges short of its target.
- **Pivot ladder**, resolved per gesture: cursor hit → selection centre → placed pivot → fit centre. Cursor pivots are transient and never overwrite a placed one; pan never touches it. **Manual testing reordered this** — the selection now outranks the placed pivot, because selecting elements is the fresher statement of what the user is working on and a pivot dropped earlier in the session shouldn't override it. Both fallbacks are skipped while off-screen (Navisworks' auto-unlock: turning about a point behind the camera reads as turning about nothing) but neither is forgotten.
- **Manual testing also found a pre-existing collision:** right-drag panned *and* opened the context menu. Pan moved to the middle button (the CAD convention), which was free anyway since `enableZoom = false` had just killed its dolly; `mouseButtons.RIGHT = null`. Our pointerdown `preventDefault`s button 1 or the browser starts autoscrolling — three never preventDefaults pointerdown itself.
- **Rotate/zoom come away from OrbitControls via `enableRotate` / `enableZoom`, not `mouseButtons`.** Three reaches its rotate handler from several directions — left-drag, ctrl/shift + right-drag, and one-finger touch — and any live path would have been a second orbit that turns about the anchor and quietly ignores the pivot. One-finger touch rotate and pinch-to-zoom (aimed at the finger midpoint) are implemented here instead, about the same pivot as the mouse. `enableZoom` governs the wheel *and* the pinch, which is why the pinch had to be reimplemented rather than left alone.
- **New risk the split introduced:** OrbitControls pans at the *target's* depth, which used to sit on geometry. As a free-floating anchor it can be anywhere, so the anchor's depth is re-derived from a cursor raycast when a pan starts — the same reason Blender's Auto Depth covers pan and not just orbit.
- **CLAUDE.md:** the "Deferred State Application" section documented the workaround this removes, and `'pivot-transition'` was its only instance. Replaced with "Camera Ownership", keeping the lesson — deferring a jarring visual consequence only moves it to the user's next gesture; fix the state model that produces it.
- **Also shipped:** "Remove pivot" in the contextual-action tray (the red marker had no discoverable way back off), and a transient blue marker at the cursor pivot for the length of an orbit. Design + research notes in `dev/plans/handoff-orbit-about-cursor.md`.
