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

**Order:** `bulk-property-fetch-and-cap` ‖ `undo-redo` → `context-menu` +
`element-appearance` → `undo-redo-retrofit` → `select-similar` → (Data Insight)
`parameter-coloring` · `data-aggregation-tabs`.

### `undo-redo` — Global undo/redo (Ctrl+Z · Ctrl+Y)
- **Status:** queued (interaction keystone — build first, with selection undo)
- **Effort:** M
- **Why:** Hide/isolate/fade and bulk selection edits need to be safe to try; users will accidentally clear the basket or over-select. Nothing is reversible today.
- **What:** A `Command` pattern + single `HistoryManager` (before/after mementos), Ctrl+Z / Ctrl+Y wiring with an input-focus guard. One command per user-perceived gesture (a 1000-element marquee = one undo). Ships with **selection undo** + **basket undo** (M+/M−/MC). Camera is never recorded; history clears on model add/remove.
- **Risks:** the `isApplying()` re-entrancy guard (undo must not push a new command) is the correctness crux; selection mementos can be large → depth-capped.
- **Source:** `dev/plans/handoff-undo-redo.md`.

### `undo-redo-retrofit` — Make clipping + measurement undoable
- **Status:** queued (depends on `undo-redo`)
- **Effort:** S–M
- **Why:** The existing tools should join the history once the contract is proven.
- **What:** Clipping drag (pointer-down→up) = one command; create/remove plane = one each. A completed measurement = one command; delete = one. Mid-placement Ctrl+Z cancels the pending placement.
- **Risks:** tool visual handles must re-sync on undo/redo.
- **Source:** `dev/plans/handoff-undo-redo.md` (§ Retrofit).

### `context-menu` — Selection-aware right-click menu
- **Status:** queued (debuts with `element-appearance`)
- **Effort:** M
- **Why:** The unifying surface for hide/isolate/fade/select-similar/add-to-basket; no context menu exists today.
- **What:** New `src/ui/ContextMenu.ts`; `contextmenu` opens a menu scoped to the **current selection** — no raycast, no select-on-right-click. To act on an element, select it first; to act on the basket, MR it into the selection first. No selection (and no active recovery action) → no menu.
- **Risks:** positioning/clamping; suppress during active tools.
- **Source:** `dev/plans/handoff-context-menu.md`.

### `element-appearance` — Hide / isolate / show-all + transparent / opaque
- **Status:** queued (depends on `undo-redo` + `context-menu`; supersedes `element-visibility`)
- **Effort:** M
- **Why:** Act on a `Scope`'s visibility/transparency; prerequisite for filter and useful alone (isolate).
- **What:** One `AppearanceManager` with a single mutually-exclusive state per element (normal / hidden / transparent), normalize-then-apply for robust transitions. Hide via `meshesByExpressId`; transparency reuses the highlight-variant material trick. Tray "Show N hidden" / "Clear transparency" recovery. Undo-aware; session-persisted.
- **Risks:** the transparency + highlight overlay on one mesh; fit/raycast/marquee must respect hidden meshes.
- **Source:** `dev/plans/handoff-element-appearance.md`.

### `select-similar` — Find elements with a matching parameter
- **Status:** queued (presets cut: no dep; value-match cut: needs `bulk-property-fetch-and-cap`)
- **Effort:** M
- **Why:** "Show me all the B12 beams" in one click — the inline form of `filter-by-parameter`; a `Scope` source feeding basket/visibility/coloring/aggregation.
- **What:** Inline "⌕ Select similar" on inspector property rows + a context-menu submenu. Two cuts: same-type/same-class presets first (no dependency), parameter value-match once bulk access lands. Result drives `selectExactly` (one undoable selection).
- **Risks:** huge match sets (reuse the bulk selection path + progress); value typing.
- **Source:** `dev/plans/handoff-select-similar.md`.

## Data Insight phase (epic — see `dev/plans/phase-data-insight.md`)

Quickly understand the data in loaded IFC model(s): select, filter, colorize,
aggregate. Built on one shared `Scope` (a set of elements) with several
sources (model / basket / filter) and consumers (visibility / coloring /
aggregation). Ships feature-by-feature, foundational-first.

_`selection-basket` shipped (PR #36, 2026-05-26) — see Done. It is the first
`Scope` source; the cards below build on it._

### `element-visibility` — Hide / unhide / isolate elements
- **Status:** queued — **superseded by `element-appearance`** (which adds isolate + transparency + undo); kept for the feature-2 reference.
- **Effort:** M
- **Why:** Prerequisite for filter ("show matching, hide the rest"); useful alone (isolate selection). Today visibility is per-model only.
- **What:** Element-level show / hide / isolate over a `Scope`. "Show all" contextual button when anything is hidden.
- **Risks:** selection / raycast interaction with hidden elements.
- **Source:** `dev/plans/phase-data-insight.md` (feature 2); now planned in `dev/plans/handoff-element-appearance.md`.

### `filter-by-parameter` — Show elements matching a parameter
- **Status:** queued (needs `element-visibility` + bulk property access). First, lighter form is `select-similar` (selects rather than isolates).
- **Effort:** M
- **Why:** From a selected element/class, show all elements sharing a parameter value and hide the rest — fast "find everything like this."
- **What:** Pick parameter(s) + match → matching elements become a `Scope`, isolated via `element-visibility`. Predicate evaluated across the model via bulk property access (the worker).
- **Risks:** evaluating a predicate over thousands of elements — needs the worker bulk fetch.
- **Source:** `dev/plans/phase-data-insight.md` (feature 4); inline form in `dev/plans/handoff-select-similar.md`.

### `parameter-coloring` — Color a scope by a parameter (color scale)
- **Status:** queued
- **Effort:** M
- **Why:** See data spread visually — color elements by a parameter's value, like Naviate in Revit.
- **What:** Apply a color scale (gradient for numeric, categorical for discrete) to a chosen parameter across a `Scope` (model / basket / filter), with a legend. Temporary; restored on clear. Reuses the highlight-variant material mechanism.
- **Risks:** legend UX; large-model color application cost (use bulk fetch).
- **Source:** `dev/plans/phase-data-insight.md` (feature 5).

### `data-aggregation-tabs` — Pivot-style aggregation in workspace tabs
- **Status:** queued (capstone — depends on bulk property access + the `Scope` spine)
- **Effort:** L
- **Why:** Quickly understand a model's data — sum / avg / count over a scope, Excel-pivot-style. The headline of the Data Insight phase.
- **What:** A tabbed workspace (MODEL + renamable, session-persisted data-agg tabs). Each tab pivots a `Scope` (model / basket / filter): group + aggregate, show contributing elements + result tables; graphs + report/export later. Sub-phased: tab infra → pivot → graphs/export.
- **Risks:** the pivot authoring UX and the tab / session-persistence model are the design risk — each gets its own hand-off doc.
- **Source:** `dev/plans/phase-data-insight.md` (feature 6).

### `bulk-property-fetch-and-cap` — Unblock the inspector soft cap
- **Status:** queued — **planned in `dev/plans/handoff-bulk-property-access.md`** (worker-based; the main-thread `web-ifc.GetLines` detail below is superseded — web-ifc moved into the worker in PR #33).
- **Effort:** M
- **Why:** Multi-select with the inspector panel open serialises `repository.get(modelId, expressId)` per element through `App.parseQueue`. For 1000+ elements this is the actual bottleneck (not the highlight — that's already O(N) after PR #21). Today the panel just refuses to render via `MULTI_SELECT_SOFT_CAP = 1000`.
- **What:**
  - Add `repository.getMany(ids: ElementIdentity[]): Promise<ElementProperties[]>` that batches via `web-ifc.GetLines(modelID, expressIDs[])` (`node_modules/web-ifc/web-ifc-api.d.ts:312`) in one WASM round trip per group.
  - `InspectorPanel.beginMultiFetch` uses `getMany`.
  - Raise `MULTI_SELECT_SOFT_CAP` to 5 000 with a progress spinner, or remove entirely with a "Computing intersection... N / M" overlay. User has asked for this to be tunable in a future settings panel.
- **Risks:** Bulk property data can be megabytes for large selections — memory peak during the call. Stream the result instead of materialising everything at once if it's a problem.
- **Also feature 3 of the Data Insight phase** (`phase-data-insight.md`): the same `getMany` (plus real `enumerateExpressIds` / `describeSchema`, now running in the worker) is the enabler for `filter-by-parameter` and `data-aggregation-tabs`. Plan them together.
- **Source:** Performance research section 6.

### `settings-panel` — User-tunable caps and preferences
- **Status:** queued
- **Effort:** M
- **Why:** Several internal constants want to be user-tunable (multi-select cap, highlight color, click-vs-drag threshold). User has asked for a settings UI. No panel today.
- **What:**
  - New `src/ui/SettingsPanel.ts` mounted in `src/core/App.ts`.
  - Keys persisted in localStorage under `ifcviewer:settings:*`.
  - Each surfaced setting reads from a central `Settings` module so internals can subscribe.
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
