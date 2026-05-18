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

### `progressive-scene-fill` — Meshes appear during StreamAllMeshes
- **Status:** queued
- **Effort:** M
- **Why:** Today `IfcParser.parse` accumulates `ParsedMesh[]` and only after the full stream completes does `ModelManager.addModel` create THREE.Meshes and call `scene.add(group)`. User sees a frozen UI for ~60 s, then the model appears all at once.
- **What:**
  - Refactor `IfcParser.parse` to invoke a `onMesh(parsedMesh)` callback synchronously during the stream.
  - New `ModelManager.beginStream(id) / appendMesh(id, parsed) / endStream(id)` API.
  - `App.handleFile` adds the group to scene at `beginStream`; meshes pop in during `appendMesh`.
  - Defer `viewer.fitToBox` until `endStream` (otherwise the camera zooms to the first dozen meshes then jerks back).
  - Yield to the event loop between batches via `await new Promise(r => setTimeout(r, 0))` so frame ticks (and the progress overlay from `loading-overlay-and-percentage`) update.
- **Risks:** Phase-4 marquee bounding-box use was made lazy in PR #21, so no problem there. Pivot/raycast operations during partial load should still work — meshes that aren't yet in the scene simply won't be hit.
- **Source:** Performance research section 3.3.

### `bulk-property-fetch-and-cap` — Unblock the inspector soft cap
- **Status:** queued
- **Effort:** M
- **Why:** Multi-select with the inspector panel open serialises `repository.get(modelId, expressId)` per element through `App.parseQueue`. For 1000+ elements this is the actual bottleneck (not the highlight — that's already O(N) after PR #21). Today the panel just refuses to render via `MULTI_SELECT_SOFT_CAP = 1000`.
- **What:**
  - Add `repository.getMany(ids: ElementIdentity[]): Promise<ElementProperties[]>` that batches via `web-ifc.GetLines(modelID, expressIDs[])` (`node_modules/web-ifc/web-ifc-api.d.ts:312`) in one WASM round trip per group.
  - `InspectorPanel.beginMultiFetch` uses `getMany`.
  - Raise `MULTI_SELECT_SOFT_CAP` to 5 000 with a progress spinner, or remove entirely with a "Computing intersection... N / M" overlay. User has asked for this to be tunable in a future settings panel.
- **Risks:** Bulk property data can be megabytes for large selections — memory peak during the call. Stream the result instead of materialising everything at once if it's a problem.
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

### `cached-parsed-geometry-idb` — Cache parsed geometry in IndexedDB
- **Status:** queued
- **Effort:** M
- **Why:** Today session restore re-parses the full .ifc (~60s for 191 MB). Caching the parsed buffers keyed by file hash skips parsing entirely on reload.
- **What:** New `geometry-cache` IDB object store. Hydrate scene from cache on restore; background re-parse fills web-ifc modelID for property queries (user-confirmed: properties have a 2–5s availability gap after restore until reparse completes). 500 MB cap with simple eviction.
- **Risks:** storage size (cap mitigates), schema versioning (constant in code), property availability gap.
- **Source:** `dev/plans/phase-perf-low-hanging-fruit.md`.

### `render-on-demand` — Skip frames when nothing changed
- **Status:** queued
- **Effort:** M
- **Why:** `Viewer.animate` runs at 60 fps unconditionally even when idle. Battery / heat / fan noise on laptops, sustained GPU load.
- **What:** `Viewer.requestRender()` flag-based approach. Audit every state-mutation site to add the call.
- **Risks:** stale-frame regressions if any mutation site is missed. Bug surface is broad — extensive manual smoke required.
- **Source:** `dev/plans/phase-perf-low-hanging-fruit.md`.

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
