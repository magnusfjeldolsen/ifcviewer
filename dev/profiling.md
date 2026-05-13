# Profiling the IFC viewer

A pragmatic guide for investigating performance regressions, verifying that a perf PR delivers what it claimed, or establishing a baseline before architectural changes. Browser-only, Chrome-first, no extra tooling needed.

> If you change something that touches geometry construction, materials, the render loop, parse pipeline, or the property repository, **measure before and after** and update the Baselines section at the bottom.

---

## When to use this doc

- A user reports a slowdown ("the viewer feels sluggish", "it freezes for 30 seconds").
- A perf PR has been smoke-tested; verify the claimed improvement is real.
- You're about to change the parser, the render loop, the material pipeline, or the IndexedDB cache — capture a baseline first.
- You want a sanity check before scaling work like `instanced-meshes` or `web-worker-parse` lands.

The doc focuses on **what to measure** and **how to interpret the numbers**, not on exhaustive Chrome internals.

---

## Three tools you'll actually use

### 1. `performance.memory` (Chrome only)

Cheapest measurement. Drop into DevTools console:

```js
({
  usedMB: (performance.memory.usedJSHeapSize / 1048576).toFixed(2),
  totalMB: (performance.memory.totalJSHeapSize / 1048576).toFixed(2),
  limitMB: (performance.memory.jsHeapSizeLimit / 1048576).toFixed(0),
})
```

When to call:
- **Before parse**: capture the fresh-page baseline.
- **After parse completes**: difference = heap cost of that model.
- **After `removeModel`** (× on the tree row): heap should return close to baseline (± 5 MB). If it grew permanently, there's a dispose leak.
- **After multiple load → remove cycles**: if `usedMB` ratchets up, there's an unreleased reference somewhere.

`jsHeapSizeLimit` is V8's per-tab cap (typically ~4 GB on a 64-bit desktop, much lower on mobile). When `usedMB / limitMB > 0.75` you'll see frequent GC pauses; > 0.9 risks `Out of memory`.

### 2. Chrome DevTools — Memory tab (heap snapshots)

Use when `performance.memory` shows a leak but you don't know *what* is retained.

Flow:
1. DevTools → **Memory** → "Heap snapshot" → Take snapshot.
2. Trigger the suspect operation (e.g. load → remove a model).
3. Take another snapshot.
4. Compare: switch to the second snapshot, change the view to **Comparison**, pick the first as the base. Sort by **# Delta** column descending — what new objects survived?

What to ignore:
- **Detached HTMLElement** entries with low instance counts. Three.js intentionally retains some DOM helpers (orbit controls' event listeners, etc.).
- Anything in `(system)` or `(GC roots)` rows.

What to flag:
- Large `Float32Array` / `Uint32Array` / `BufferGeometry` / `Material` / `Mesh` deltas after a `removeModel` — those should have been disposed.
- Strings holding IFC text content if you did a `removeModel` (the buffer should be released).

### 3. Chrome DevTools — Performance tab (frame profiling)

Use when *something is slow* and you don't know what. Best for orbit / pan / zoom lag, marquee selection slowness, inspector panel sluggishness.

Flow:
1. DevTools → **Performance** → click **Record**.
2. Perform the slow interaction (e.g. orbit for 3 seconds).
3. Stop recording.
4. Look at the flame chart for "Long Tasks" (red triangles on tasks > 50 ms).
5. Click a long task; the bottom-up view shows which function hogs CPU.

What to look for:
- `WebGLRenderer.render` dominating frame time → too many draw calls (likely → `share-materials-by-color` or `instanced-meshes` cards).
- `updateMatrixWorld` dominating → too many objects with dirty transforms; not normally an issue but visible at 200k+ meshes.
- `requestAnimationFrame` callbacks doing work even when idle → render-on-demand opportunity (queued as `render-on-demand` card).
- `OpenModel` or `StreamAllMeshes` blocking 1+ seconds → expected behavior today; mitigated by `progressive-scene-fill` and `mt-wasm-coop-coep` cards.

---

## Optional: `renderer.info`

Three.js's `WebGLRenderer` exposes `info.render.calls`, `info.render.triangles`, `info.memory.geometries`, `info.memory.textures`. These are per-frame counters reset on each render. Reading them requires a reference to the renderer, which is not exposed on `window` today.

To inspect: add a temporary line in `src/core/App.ts` after viewer construction:

```ts
// TEMPORARY — for profiling. Remove before commit.
(window as any).__viewer = this.viewer;
```

Then in DevTools console:

```js
window.__viewer.getRenderer().info
```

Useful for verifying that `share-materials-by-color` reduces draw calls (each `Material` switch = 1 draw call) or that `instanced-meshes` collapses many draws into few.

Remove the temporary line before committing.

---

## Reproducible test method

To get apples-to-apples numbers between two snapshots (e.g. pre-PR vs post-PR):

1. **Clear state.** Open DevTools → Application → Storage → "Clear site data". Then hard-refresh (Ctrl+Shift+R / Cmd+Shift+R).
2. **Capture initial heap** in console (use the snippet from §1).
3. **Load the reference model** via drag-drop or the + button.
4. **Wait** for `status` element to read "Loaded …".
5. **Capture parse-complete heap.**
6. **Remove the model** via the × on the tree row.
7. **Force a GC** in DevTools (Memory tab → trash icon).
8. **Capture post-remove heap.**

Compare the three numbers across runs. The deltas matter, not the absolute values.

### Heap measurement gotchas

- **Session restore pollutes baselines.** If the memory toggle is ON and `localStorage` has a prior session, the new tab auto-restores models on load — your "before" snapshot already includes their geometry. Either: (a) toggle memory off before measuring; (b) clear localStorage + IndexedDB first via `Application → Storage → Clear site data`.
- **Duplicate-name detection.** `App.handleFile` rejects files with the same name as an already-loaded model. If session restore added placeholder rows (warning text "File missing — re-upload to restore"), uploading the file again is silently rejected. Clear state fully before measuring.
- **`performance.memory` is approximate.** It rounds to the nearest 1 MB and lags by GC cycles. Run measurements 2–3 times and average if the numbers wobble.
- **Heap reading vs RSS.** `performance.memory.usedJSHeapSize` is V8 JS heap only — it does NOT include WebGL GPU memory or the WASM heap. Use Chrome's Task Manager (`Shift+Esc`) to see the actual process RSS.

---

## Baselines (2026-05-13, main at `8061b53`)

Measured on a desktop with the following environment:

| Field | Value |
|-------|-------|
| Chrome version | 147.0.0.0 |
| Device memory | 32 GB |
| Hardware concurrency | 20 cores |
| `crossOriginIsolated` | **false** (MT WASM not active — see `mt-wasm-coop-coep` card) |
| Initial heap (fresh page, no model) | 22–24 MB used, 27 MB total, 4 GB limit |

### Reference models

| Model | File size | IFC schema | Mesh count | Notes |
|-------|-----------|-----------|------------|-------|
| RIB.ifc | 19.09 MB | IFC2X3 | 773 objects | Revit / ODA-exported. Carries `Structural Analysis` properties with `Max_Tension` / `Max_Compression` — useful for inspector tests. |
| Snowdon Towers Sample Structural.ifc | 7.84 MB | IFC4 | 17,254 objects | Buildingsmart sample. Mesh-dense but small file — exercises the rendering path more than parsing. |

### Measured numbers

**RIB.ifc**, cold load on a fresh page:

| Metric | Value |
|--------|-------|
| Parse time (drop event → "Loaded" status) | 0.51 s |
| Heap before load | 22.09 MB |
| Heap after load | 110.15 MB |
| Heap delta (model cost) | **+88.06 MB** |
| Mesh count | 773 |

**Snowdon Towers Sample Structural.ifc**, cold load on a fresh page:

| Metric | Value |
|--------|-------|
| Parse time | not measured cleanly this session (see Gotchas — session restore pollution). Manual observation: 30–60 s on this machine |
| Mesh count | 17,254 |
| Heap delta (approximate) | ~190 MB (extrapolated from a combined RIB + Snowdon load showing 340 MB total) |

**Combined (RIB + Snowdon loaded together):**

| Metric | Value |
|--------|-------|
| Total mesh count | 18,027 |
| Heap after both loaded | ~340 MB |

> Snowdon's clean parse-time number is missing because session-restore + duplicate-name detection blocked the second measurement attempt. Re-measure after `loading-overlay-and-percentage` lands — its progress callback will give an authoritative parse-time number anyway.

---

## Common diagnoses

### "Orbit / pan / zoom feels laggy on a big model"

Most likely: **draw call count is too high.** Each `THREE.Mesh` is one draw call, and `MeshPhongMaterial` allocation is per-mesh today. 17 k meshes × per-frame material switching → ~17 k draw calls per frame on Snowdon. WebGL state changes between draws are expensive.

Verify: temporarily expose `viewer` on `window` (see §3 above), check `info.render.calls` during orbit. If above ~5,000, the next optimization is `share-materials-by-color` (queued in roadmap). Beyond that, `instanced-meshes` (also queued, depends on `render-perf-orbit-lag` investigation).

### "Memory keeps growing after each load → remove cycle"

Most likely: a Three.js resource isn't disposed. Verify via heap snapshot diff:
1. Snapshot 1: fresh page.
2. Load → remove a model.
3. Snapshot 2.
4. Compare. Look for `BufferGeometry`, `Material`, or `Mesh` deltas > 0.

`ModelManager.removeModel` (`src/viewer/ModelManager.ts:84-102`) walks the model group and calls `geometry.dispose()` + `material.dispose()`. If something is retained, it's likely an external reference (selection material clones, measurement labels, clip helpers).

### "Tab becomes unresponsive during load"

Expected today on large files. The web-ifc `OpenModel` + `StreamAllMeshes` calls block the main thread. Mitigations queued:
- `loading-overlay-and-percentage` — gives the user progress feedback.
- `progressive-scene-fill` — meshes appear during the stream so the user sees progress.
- `mt-wasm-coop-coep` — multicore WASM cuts parse time ~2–3×.
- `web-worker-parse` (deferred) — moves parse off main thread entirely.

Verify the parse time vs the model size with a Performance tab recording. If parse time scales > linearly with file size, that's a regression.

### "Selection of many elements is slow"

Should be fast since PR #21 — selection of 18k elements completes in < 100 ms thanks to the per-model `Map<expressID, Mesh[]>` index + shared highlight variants (`WeakMap<Material, Material>`). If you see this regress:
- Verify `ModelEntry.meshesByExpressId` is populated after `addModel`.
- Verify `SelectionManager.highlightVariants` is reusing instead of cloning per mesh.

### "Inspector panel takes seconds to show properties on a single element"

`WebIfcPropertyRepository.get` serialises through `App.parseQueue`. The first fetch per `(modelId, expressId)` hits the web-ifc API (`getItemProperties + getPropertySets + getMaterialsProperties`); subsequent fetches for the same element are memoised. If first-hit takes > 500 ms, that's the parse queue saturated by a competing parse. After `bulk-property-fetch-and-cap` lands, batching will mitigate.

### "Multi-select of many elements is slow"

The highlight is fast (PR #21), but `intersectProperties` runs on every selection change. For 18k elements with ~50 flat rows each, that's ~900k row comparisons. Should complete in ~100–500 ms. If it lags worse:
- Check the `MULTI_SELECT_SOFT_CAP` (currently 1000) is doing its job.
- Profile the intersection function in the Performance tab.

---

## Adding new baseline data

If you measure something useful, append a dated row to the Baselines section. Keep the format:

```
### YYYY-MM-DD — short description
- Model: ...
- Branch / commit: ...
- Browser: ...
- Numbers: ...
```

If you find a measurement gotcha (like the session-restore one above), add it to the "Gotchas" section instead of overwriting prior numbers — past gotchas are educational, not noise.
