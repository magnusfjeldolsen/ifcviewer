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
- **Status:** queued
- **Effort:** S–M
- **Why:** `node_modules/web-ifc/web-ifc-mt.wasm` already ships in `public/` but never loads because the dev server and GitHub Pages don't send the COOP/COEP headers that enable `crossOriginIsolated`. With it enabled, web-ifc's `Init()` auto-selects the MT artifact and CPU stages get ~2–3× faster on multicore machines.
- **What:**
  - `vite.config.ts` dev server headers:
    ```
    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: credentialless   # safer than require-corp
    ```
  - For GitHub Pages prod, ship a Service Worker (use `coi-serviceworker` npm package or hand-roll ~30 lines) that re-broadcasts the headers.
  - Add a smoke test that logs `self.crossOriginIsolated` and which WASM variant loaded.
- **Risks:** COEP `require-corp` mode breaks any cross-origin asset without `Cross-Origin-Resource-Policy: cross-origin`. Use `credentialless` instead — it relaxes the requirement at the cost of not sending credentials. Audit:
  - Google Analytics (`src/services/Analytics.ts`) — usually fine in credentialless mode.
  - Cookie banner if it loads any external icon/font.
  - Any third-party domain in `index.html`.
- **Falls back gracefully:** if COI fails, web-ifc silently uses the single-threaded WASM. No crash, no regression.
- **Source:** Performance research section 3.2.

### `share-materials-by-color` — Material cache in ModelManager
- **Status:** queued
- **Effort:** M
- **Why:** `src/viewer/ModelManager.ts:addModel` currently allocates a fresh `MeshPhongMaterial` per mesh. For 100 k meshes that's 100 k materials, churning GC. The model-orbit lag the user reported (after PR #21) is partly because every material change is a GPU state switch — fewer distinct materials = much smoother render.
- **What:**
  - In `addModel`, build a `Map<string, MeshPhongMaterial>` keyed by `${r},${g},${b},${a}` and reuse.
  - **SelectionManager already plays well with this** because its `highlightVariants` cache is keyed by the original material reference (`WeakMap<Material, Material>`); shared originals → shared variants → smaller variant pool. Strong synergy.
- **Risks:**
  - Future feature: per-mesh color override (e.g. user paint or filter-result coloring) requires not sharing — needs per-mesh material at that point. Acceptable: add a "fork before mutate" path then.
  - Material count metric: log the count after load on a big model. Should drop from ~100k to dozens.
- **Source:** Performance research section 3.4.

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
