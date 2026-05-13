# Phase — Performance low-hanging fruit (5 cards, 4 PRs)

## TL;DR

Five small-to-medium optimization cards surfaced by cross-referencing the AlterSquare "Handling Large IFC Files" post (Feb 2026) against our codebase. None displace the existing queued roadmap — they're additive wins.

Split into **four PRs** so each lands fast and reviewable:

| PR | Cards | Effort | Why this order |
|----|-------|--------|----------------|
| **A** | `parse-memory-hygiene` | S | Tiny, zero-risk, closes a real WASM-heap leak. Ships first as a confidence-builder before anything bigger touches the parser. |
| **B** | `dev-profiling-doc` | S | Docs only, no code. Gives us a measurement baseline that subsequent PRs cite. |
| **C** | `cached-parsed-geometry-idb` | M | Biggest user-visible win. Skips web-ifc on session restore for ~10–50× faster reload of large models. Background re-parse fills in property availability. |
| **D** | `render-on-demand` | M | Battery + heat + smoother UI when idle. Modest bug surface (stale-frame regressions if a render trigger is missed). Ships after C lands so we benchmark on a more representative pipeline. |

A fifth card — **`frustum-cull-audit`** (S) — is small enough to bundle with the upcoming `render-perf-orbit-lag` investigation (already in the roadmap). Documented here but no dedicated PR.

User-confirmed decisions (locked):
- `cached-parsed-geometry-idb`: **re-parse in background** while cached geometry renders. Geometry appears immediately from cache; properties become available a few seconds later as parse completes on the main thread (worker version waits for `web-worker-parse`).
- `web-worker-parse`: **kept deferred**. Will revisit after `share-materials-by-color` and `progressive-scene-fill` ship.

---

## Background & motivation

LinkedIn post by AlterSquare (Feb 2026) on optimizing large IFC files in web apps. Recommendations distilled to what's actionable for our **browser-only, static-hosted** codebase. Server-side strategies dropped, IFC.js wrapper rejected (we use web-ifc directly), GLTF format unnecessary (we cache parsed buffers instead).

Cross-reference confirmed most of the post's general guidance is already covered by existing roadmap cards (`loading-overlay-and-percentage`, `mt-wasm-coop-coep`, `share-materials-by-color`, `progressive-scene-fill`, `bulk-property-fetch-and-cap`). This phase covers what's NOT yet in the roadmap.

---

## PR A — `parse-memory-hygiene` (S, ship first)

### What

`src/parser/IfcParser.ts:43-83` iterates `flatMesh.geometries` and calls `geom.delete()` on the inner `IfcGeometry` (line 81), which correctly frees the WASM-heap vertex/index buffers. But it never calls `flatMesh.delete()` on the outer wrapper, nor releases the `Vector<PlacedGeometry>` collection.

Per `node_modules/web-ifc/web-ifc-api.d.ts:71-75`, `FlatMesh` is an emscripten-bound wrapper. On a 100k-mesh load that's **100,000 retained wrappers + 100,000 retained vectors in WASM memory**, for the lifetime of the model.

### Files to touch

| File | Change |
|------|--------|
| `src/parser/IfcParser.ts` | Add `flatMesh.delete()` at the end of the `StreamAllMeshes` callback (after the for-loop, before the callback returns). |

### Step by step

1. Confirm baseline: `npm test`, `npm run lint`, `npm run typecheck` green on main.
2. Branch: `feature/parse-memory-hygiene` off main.
3. Edit `src/parser/IfcParser.ts:43-83`. After the inner for-loop that processes `flatMesh.geometries`, add `flatMesh.delete()` immediately before the callback returns.
4. Run the full test suite. Existing parser tests must still pass (no behavior change visible from JS-side).
5. Commit, push, PR.

### Tests

No new tests. The WASM heap isn't observable from JS. The existing parser tests (e.g. `tests/inspector-repository-rib.test.ts`) act as a smoke that the change didn't break anything — they load real IFC content and verify properties.

A future profiling exercise (after PR B lands) can measure `performance.memory.usedJSHeapSize` before/after a load to verify the leak is gone.

### Smoke tests

1. Load a small IFC, click an element, verify properties render normally.
2. Load a large IFC (e.g. RIB.ifc), orbit/zoom, click elements — no regression.
3. Load → remove → load again sequence works.
4. Console: no new warnings.

### Risk

Zero. The inner `geom.delete()` at line 81 already runs *before* the callback returns. Adding `flatMesh.delete()` after the loop is strictly additive. The geometry data is fully copied into JS-owned Float32Arrays before either delete runs.

---

## PR B — `dev-profiling-doc` (S, docs only)

### What

We have no documented workflow for measuring performance regressions. When the next perf PR (cached geometry, render-on-demand, materials sharing) lands, whoever debugs it will reinvent the measurement approach.

Add `dev/profiling.md` covering the Chrome DevTools workflow + interpretation guide + baseline numbers for our reference models.

### Files to touch

| File | Change |
|------|--------|
| `dev/profiling.md` | NEW. Covers heap snapshots, performance.memory, renderer.info, Chrome Performance tab. Includes baseline numbers measured against RIB.ifc and the Snowdon Towers sample. |
| `dev/plans/roadmap.md` | Move card from queued to done. |

### Structure of `dev/profiling.md`

```
# Profiling the IFC viewer

## When to use this doc
- Investigating a perceived slowdown
- Verifying a performance PR delivers what it claimed
- Establishing a baseline before architectural changes

## Tools
### Chrome DevTools Memory tab
  - Taking a heap snapshot before / after model load
  - Reading the snapshot
  - Common false-positive findings to ignore (Three.js intentional retentions)
  - Comparing two snapshots

### performance.memory (Chrome only)
  - One-liner: `performance.memory.usedJSHeapSize / 1e6` for MB
  - When to call (before parse, after parse, after removeModel)

### renderer.info
  - `viewer.getRenderer().info.render.calls` — draw call count per frame
  - `.render.triangles` — geometry rendered per frame
  - `.memory.geometries` / `.memory.textures` — GPU resource count

### Chrome Performance tab
  - Recording an orbit / load / multi-select
  - Identifying the hot function

## Baselines (measured 2026-05-13 against main at COMMIT_HASH)

### RIB.ifc (20 MB, IFC2x3)
  - Parse: ~3 s
  - Draw calls per frame at default view: ~XXX
  - Triangles per frame: ~XXX
  - usedJSHeapSize after load: ~XX MB
  - After removeModel: ~XX MB (target: returns to baseline ± 5 MB)

### Snowdon Towers (8 MB, IFC4)
  - Parse: ~1 s
  - Draw calls: ~XXX
  - usedJSHeapSize: ~XX MB

### (Future: large model from user's library, ~200 MB)
  - Placeholder; fill when available

## Common diagnoses
- Slow orbit on big model → check draw call count
- Memory not released on removeModel → walk Three.js disposal chain
- Long Tasks during interaction → Performance tab → identify the function
```

### Step by step

1. Branch: `feature/dev-profiling-doc` off main.
2. Write the doc above. Use real measurements taken locally on RIB.ifc and Snowdon Towers.
3. Wire into `dev/plans/roadmap.md` — move card to done.
4. Commit, push, PR.

### Tests

None. Docs-only PR.

### Smoke tests

1. Follow the doc on a fresh load of RIB.ifc — verify the steps work and numbers are realistic.
2. Run the `performance.memory` snippet in DevTools — works as described.
3. Check rendered counts via `renderer.info` (need to expose this — see step 2.5 if not already accessible).

### Risk

Zero. Docs decay if not maintained, but a stale baseline still gives a good starting reference.

---

## PR C — `cached-parsed-geometry-idb` (M, biggest UX win)

### What

Today `SessionStore.saveModel` (`src/services/SessionStore.ts:190-202`) stores the raw .ifc buffer (megabytes of text). On session restore, `restoreSession` (`src/core/App.ts:379-479`) re-runs `parser.parse(buffer)` — the full ~60 s parse cost for a 191 MB model.

Cache the parsed `ParsedMesh[]` (binary buffers) keyed by file content hash. On restore: skip parsing, hydrate scene directly from cache, then trigger a background re-parse to fill in web-ifc state for property queries.

### Design

#### Storage layout

New IndexedDB object store `geometry-cache`. Schema:

```ts
interface CachedGeometry {
  hash: string;             // SHA-256 of the raw .ifc buffer, hex
  cachedAt: number;         // for LRU eviction
  schemaVersion: number;    // bump invalidates the cache
  meshes: CachedMesh[];     // serialized ParsedMesh[]
}

interface CachedMesh {
  expressID: number;
  vertices: ArrayBuffer;    // Float32Array.buffer
  normals: ArrayBuffer;
  indices: ArrayBuffer;     // Uint32Array.buffer
  color: { r: number; g: number; b: number; a: number };
  transform: number[];      // length 16 (Matrix4 elements)
}
```

Schema version constant lives in `src/services/SessionStore.ts`. Bumping invalidates all entries.

#### Restore flow

```
restoreSession():
  for record in session.models:
    1. Look up `cached-geometry-cache` by record.hash.
    2. If hit:
         a. Hydrate Three.Group from cache, add to scene immediately.
         b. modelIdMap.set(appId, NULL_MODEL_ID_PLACEHOLDER)
         c. Start background re-parse:
            queueMicrotask(() => parseInBackground(record))
    3. If miss:
         a. Existing flow: parse synchronously, add to scene.
         b. After successful parse, write to cache.

parseInBackground(record):
  - Fetch the .ifc buffer from sessionStore.
  - Call parser.parse(buffer, record.id).
  - On success: replace the NULL_MODEL_ID placeholder with the real modelID
    so the property repository can resolve queries.
  - On failure: mark the model as "properties unavailable" (status line).
```

#### Property repository fallback

`WebIfcPropertyRepository.get(modelId, expressId)` today resolves the web-ifc modelID via `modelIdResolver`. If the resolver returns a `NULL_MODEL_ID_PLACEHOLDER`:
- Return a placeholder `ElementProperties` (identity only, no psets/qtos/materials) with a flag indicating "parsing in progress".
- After background parse completes, evict the placeholder from memo and re-fetch on next demand.

The inspector panel today shows a spinner when properties are loading; reuse that path.

#### Write path

After a successful `parser.parse(...)` in `App.handleFile`:
```ts
const hash = await sha256(buffer);
await geometryCache.save({ hash, cachedAt: Date.now(), schemaVersion, meshes });
```

Write happens *after* the model is in the scene so it doesn't add to the user-perceived parse time. Fire-and-forget (matches the `loading-overlay-and-percentage` card's IDB-write approach).

#### Eviction policy

Cap total `geometry-cache` size at **500 MB**. On write:
1. Sum current entry sizes.
2. If adding the new entry exceeds the cap, sort by `cachedAt` ascending and delete entries until under cap.

Eviction can be approximate — we don't need real LRU; just "remove the oldest until we fit". Cheap.

### Files to touch

| File | Change |
|------|--------|
| `src/services/SessionStore.ts` | Add `geometry-cache` object store. New methods: `saveCachedGeometry`, `loadCachedGeometry`, `evictOldestUntilUnderCap`. Bump `DB_VERSION` to trigger an `onupgradeneeded`. |
| `src/services/GeometryCache.ts` (NEW) | Thin wrapper around the IDB store + the serialization. Pure functions for `serializeMeshes(parsed: ParsedMesh[]): CachedMesh[]` and `deserializeMeshes(cached: CachedMesh[]): ParsedMesh[]`. |
| `src/core/App.ts` | Modify `handleFile` to compute hash + write cache after parse. Modify `restoreSession` to check cache first, hydrate scene, kick off background re-parse if needed. Add `NULL_MODEL_ID_PLACEHOLDER` and the background-reparse helper. |
| `src/inspector/repository/WebIfcPropertyRepository.ts` | Handle the placeholder modelID case: return an "identity-only, parsing in progress" placeholder. Eviction hook so next `get()` re-fetches once real modelID is in place. |
| `src/parser/IfcParser.ts` | No change — the worker promotion is in a future card. |
| `tests/geometry-cache.test.ts` (NEW) | Test serialize / deserialize round-trip; eviction logic; schema version invalidation. |
| `tests/session-store.test.ts` | Extend with the new methods. |
| `dev/plans/roadmap.md` | Move card from queued to done with outcome. |

### Step by step

1. Confirm baseline green.
2. Branch: `feature/cached-parsed-geometry-idb` off main.
3. **Phase 1: cache layer** — `src/services/GeometryCache.ts` + `src/services/SessionStore.ts` changes. Tests in `tests/geometry-cache.test.ts`.
4. **Phase 2: write path** — modify `App.handleFile` to write to cache after parse. Verify cache fills via DevTools IndexedDB inspector.
5. **Phase 3: read path** — modify `App.restoreSession` to check cache first and hydrate. Add the background re-parse helper.
6. **Phase 4: property fallback** — update `WebIfcPropertyRepository` to handle the placeholder modelID case.
7. **Phase 5: integration** — wire everything together. Manual smoke (see below).
8. Run full test suite + lint + typecheck.
9. Commit (probably 2–3 commits matching the phases; squash later if review prefers).
10. PR.

### Tests

`tests/geometry-cache.test.ts`:
1. `serializeMeshes` round-trips through `deserializeMeshes` — vertices, normals, indices, color, transform all identical.
2. `saveCachedGeometry` writes to IDB and `loadCachedGeometry` reads it back.
3. Schema-version mismatch returns no result (cache miss).
4. Hash mismatch returns no result.
5. Eviction: after writing N entries totaling over cap, oldest are removed.
6. Empty cache returns no result without throwing.

`tests/session-store.test.ts` extensions:
1. New `geometry-cache` object store is created on DB upgrade.
2. Existing model save/load still works alongside cache.

Integration test (manual via smoke; full automated integration is awkward because it needs a real WASM init).

### Smoke tests

**Initial flow**
1. Load RIB.ifc fresh. Inspector works as normal.
2. Memory toggle ON, refresh page. Model **appears instantly** (geometry from cache).
3. After 2–3 seconds (the background re-parse), click an element → properties show normally.
4. Click an element during the first 2–3 seconds → spinner / "parsing in progress" indicator; properties appear once parse completes.

**Cache invalidation**
5. Bump `CACHE_SCHEMA_VERSION` in code, reload — model re-parses from scratch, cache repopulates with the new schema.
6. Re-upload the same file under a different name → different cache entry (hash includes content; new entry is created, same parse cost).

**Eviction**
7. Load 5 different large models → IDB cache grows.
8. Verify oldest is evicted when total exceeds 500 MB.

**Edge cases**
9. Memory toggle OFF, cache writes do NOT happen (we'd consume disk for no restore-time win).
10. Cache hit but the underlying .ifc buffer is missing in sessionStore (orphan cache) → graceful fallback to "model unavailable".
11. Background re-parse fails (corrupt buffer) → status line shows warning; geometry still renders (visual is correct, just no properties).

**Performance verification**
12. Measure restore time for 191 MB model: pre-PR ~60 s, post-PR < 2 s for geometry visible.
13. usedJSHeapSize after restore comparable to fresh load (no double-spending memory).

### Risks

1. **Storage size**. Parsed geometry can be larger than IFC text (no string-overhead but lots of float duplication). On a 100k-mesh model, ~50–100 MB cache size per model. Cap at 500 MB total, LRU. **Real risk:** users with many models could hit the cap and lose cache benefits silently. Mitigation: log when eviction happens.
2. **Schema versioning**. If `ParsedMesh` shape changes (e.g. we add `boundingBox` cache later), the schema version must bump. Add a code comment near `CACHE_SCHEMA_VERSION` listing every reason to bump.
3. **Hash collision**. SHA-256 is fine — collisions are not a real concern.
4. **Background re-parse interferes with user interaction**. The re-parse runs `parser.parse(...)` which blocks the main thread during `OpenModel`. **Mitigation in v1**: accept the 2–5 s freeze during background parse — the user already had a frozen UI on pre-PR loads. **Future:** when `web-worker-parse` lands, the re-parse moves to a worker and the freeze goes away. Document this limitation.
5. **Property availability gap**. Card C explicitly accepts a 2–5 s "properties not available yet" window after restore. Inspector panel must show this state clearly (e.g. spinner + "Parsing model..." text). Don't crash on click during the gap.

---

## PR D — `render-on-demand` (M, battery/heat win)

### What

`Viewer.animate` (`src/viewer/Viewer.ts:107-115`) runs `renderer.render(...)` at 60 fps continuously, even when the user is reading the inspector panel and nothing is moving. On a 100k-mesh model, this burns laptop battery and heats the GPU for no visible benefit.

Track a `needsRender` flag. Render only when flag is true; clear after.

### Design

```ts
class Viewer {
  private needsRender = true;
  private renderTriggers: Array<() => void> = [];

  requestRender(): void {
    this.needsRender = true;
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.runUpdateCallbacks();
    if (this.needsRender) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  };
}
```

Render triggers needed:
- `OrbitControls 'change'` event → `requestRender()`.
- `OrbitControls 'start'` / `'end'` → `requestRender()` (covers inertia at end of drag).
- Tool state changes (clipping plane placed/moved/removed, measurement added, pivot moved) → `requestRender()`.
- `addModel` / `removeModel` / `resetView` → `requestRender()`.
- Highlight / unhighlight in `SelectionManager` → `requestRender()`.
- Marquee overlay updates (the DOM div is HTML; doesn't need scene render, but ending the marquee triggers selection which triggers render).
- `flyToBox` animation ticks → `requestRender()` for every frame of the animation.
- `pivotTransitioning` deferred-state pattern → hold render true until cleared (matches existing CLAUDE.md guidance).

### Files to touch

| File | Change |
|------|--------|
| `src/viewer/Viewer.ts` | Add `needsRender` flag, `requestRender()` method, modify `animate` to gate render call. Subscribe to OrbitControls events. |
| `src/inspector/SelectionManager.ts` | Call `viewer.requestRender()` after `highlightExpress` / `unhighlightExpress`. |
| `src/inspector/MarqueeSelector.ts` | Call `viewer.requestRender()` after selection commit. |
| `src/tools/ClippingTool.ts` | Call `viewer.requestRender()` after `createClipPlane`, `removeClipPlane`, and drag updates. |
| `src/tools/MeasurementTool.ts` | Same after each measurement point/line placed. |
| `src/viewer/Viewer.ts` (pivot logic) | Same after pivot moves. |
| `src/core/App.ts` (animation loop hook) | Ensure `flyToBox` animation calls `requestRender()` per frame. |
| `tests/viewer-render-on-demand.test.ts` (NEW) | Verify `needsRender` flag transitions on key events. |
| `dev/plans/roadmap.md` | Move card to done. |

### Step by step

1. Branch: `feature/render-on-demand` off main (after PR C lands, so we have the geometry-cache pipeline to benchmark against).
2. Add the `needsRender` plumbing to `Viewer`.
3. Audit every site that mutates view state. Add `viewer.requestRender()` calls. **This is the bulk of the work** — easy to miss a site.
4. Add tests.
5. Manual smoke (extensive — see below).
6. Commit, push, PR.

### Tests

`tests/viewer-render-on-demand.test.ts`:
1. After `Viewer` construction, first frame renders (initial state).
2. `requestRender()` followed by `animate` tick → render called.
3. `animate` tick without `requestRender()` → render NOT called.
4. OrbitControls 'change' event → render is queued.
5. `addModel` → render is queued.

Integration tests are awkward because they need a real renderer. Skip; smoke covers it.

### Smoke tests

This is the risky PR. Test extensively.

**Basic interaction**
1. Load a model. Initial frame renders.
2. Orbit / pan / zoom → fluid, no stutter, no missed frames.
3. Release the mouse → final frame settles, then no more renders (CPU goes to ~0).
4. Verify in DevTools Performance tab: while idle, `requestAnimationFrame` runs but `renderer.render` does NOT.

**Tool interactions**
5. Activate clipping tool, place a plane → renders.
6. Drag the clip plane gizmo → every drag frame renders, smooth.
7. Release gizmo → final frame renders, then idle.
8. Remove clip plane via contextual button → renders.
9. Activate measurement, place 2 points → each click triggers a render.
10. Activate pivot picking, click a surface → render.

**Selection**
11. Click an element → highlight renders.
12. Ctrl-click to add → renders.
13. Esc → clears, renders.
14. Marquee → drag the overlay → no scene re-render (it's HTML overlay); on release, selection commit triggers a render.

**Camera animation**
15. Press F (fly-to-view) → every frame of the animation renders smoothly.
16. After animation completes → idle.

**Model lifecycle**
17. Load another model → renders.
18. Remove a model → renders.
19. Reset View → renders.

**Stale-frame regressions (the danger zone)**
20. Anything visible that the user expects to update but doesn't:
    - Clipping plane disappearing without removing the gizmo (would be a stale-frame bug — verify it doesn't happen).
    - Highlight color lingering after deselect.
    - Measurement label not updating after camera move.
21. Idle for 30 seconds with nothing happening → CPU/GPU usage drops to ~0 in DevTools.

**Console**
22. No errors. No warnings about un-rendered state.

### Risks

1. **Stale-frame regressions.** The biggest risk. Any state change not paired with `requestRender()` will produce a stale frame. The audit step is critical.
2. **Animation pacing.** `flyToBox` runs frame-by-frame and depends on `requestAnimationFrame`; needs to call `requestRender()` per tick. Easy to forget.
3. **Tool-update callbacks** in `viewer.onUpdate(cb)` — these run every frame today regardless of render. After this PR they still run (they update visual scale of pivot/clip/measure markers). If they DON'T trigger renders themselves, you get markers that look stale because their scale changed but no render captured it. Document the rule: `onUpdate` callbacks may NOT mutate visual state without also calling `requestRender()`.

---

## Side card — `frustum-cull-audit` (S, bundle elsewhere)

Not a dedicated PR — small enough to fold into `render-perf-orbit-lag` whenever that investigation runs.

### What

Three.js culls per-mesh via `mesh.frustumCulled = true` (default) using `geometry.boundingSphere`. Our meshes don't override this. So culling *should* work. But we have no test that asserts this, and a future PR could accidentally regress it.

Add a test that loads a model and asserts every mesh in every `ModelEntry.group.children` has `frustumCulled === true` and `geometry.boundingSphere !== null`.

Document in a comment near `ModelManager.addModel` that frustum culling depends on the default `frustumCulled = true`.

### Effort

15 minutes. Bundle with `render-perf-orbit-lag` when that runs.

---

## Roadmap updates

Add the following entries under Queued in `dev/plans/roadmap.md`. When each PR lands, move to Done with PR number and outcome line.

```markdown
### `parse-memory-hygiene` — Free FlatMesh wrappers during StreamAllMeshes
- **Status:** queued
- **Effort:** S
- **Why:** `IfcParser.parse` calls `geom.delete()` on inner `IfcGeometry` but never `flatMesh.delete()` on the outer wrapper. On a 100k-mesh load, that's ~100k retained wrappers in WASM heap for the lifetime of the model.
- **What:** Add `flatMesh.delete()` at the end of the `StreamAllMeshes` callback in `src/parser/IfcParser.ts:43-83`.
- **Risks:** zero. The inner-loop work (vertex copy) has already produced JS-owned Float32Arrays by the time we'd delete.
- **Source:** `dev/plans/phase-perf-low-hanging-fruit.md` (AlterSquare post cross-reference).

### `dev-profiling-doc` — Document the Chrome DevTools perf workflow
- **Status:** queued
- **Effort:** S
- **Why:** No documented workflow today. Future perf PRs reinvent the measurement approach. Establishes baseline numbers we can compare against.
- **What:** New `dev/profiling.md` covering Memory tab snapshots, `performance.memory`, `renderer.info`, Performance tab recording. Baseline numbers for RIB.ifc and Snowdon Towers.
- **Risks:** zero. Docs decay if not maintained.
- **Source:** `dev/plans/phase-perf-low-hanging-fruit.md`.

### `cached-parsed-geometry-idb` — Cache parsed geometry in IndexedDB
- **Status:** queued
- **Effort:** M
- **Why:** Today session restore re-parses the full .ifc (~60s for 191 MB). Caching the parsed buffers keyed by file hash skips parsing entirely on reload.
- **What:** New `geometry-cache` IDB object store. Hydrate scene from cache on restore; background re-parse to fill web-ifc modelID for property queries. Property repository handles "parsing in progress" placeholder. 500 MB cap with simple eviction.
- **Risks:** storage size (cap mitigates), schema versioning (constant in code), property availability gap (2–5 s after restore until background re-parse completes; user-confirmed acceptable).
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
```

---

## Execution ordering

Recommend shipping in this order, one PR at a time:

1. **PR A — `parse-memory-hygiene`** (this week, S effort) — clear the latent bug before anything bigger touches the parser.
2. **PR B — `dev-profiling-doc`** (in parallel or just after A) — gives us a measurement baseline to cite in C and D.
3. **PR C — `cached-parsed-geometry-idb`** (M, ~3 days) — biggest UX win; pairs naturally with the upcoming `loading-overlay-and-percentage` work.
4. **PR D — `render-on-demand`** (M, ~3 days) — ship last because it has the broadest bug surface; we want C's baseline first.
5. **Frustum cull audit** — bundle into whoever investigates `render-perf-orbit-lag` next.

Each PR uses the standard feature-implementer workflow (branch off main → tests → smoke test → user approval → push → PR → CI green → merge).

---

## Definition of done (this phase as a whole)

- All four PRs (A, B, C, D) shipped and merged.
- Roadmap updated with each card moved to Done.
- Five smoke tests verified end-to-end on RIB.ifc:
  - Initial load same speed or faster than baseline.
  - Memory usage after `removeModel` returns to baseline ± 5 MB.
  - Session restore < 2 s for geometry visibility.
  - Idle CPU/GPU at ~0 when not interacting.
  - No stale-frame regressions across the standard tool interactions.
