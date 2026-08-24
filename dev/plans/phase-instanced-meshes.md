> **Status: NOT STARTED — analysis still valid, implementation plan STALE.**
> Last verified 2026-08-24.
>
> **What is stale.** Every implementation step in this document is written
> against **`src/parser/IfcParser.ts`, which no longer exists.** PR #33 moved
> parsing into a Web Worker (`src/parser/WorkerIfcParser.ts` +
> `src/parser/ifcWorker.ts`). There are 8 references to the deleted file,
> including the whole Phase-1 step list and the file-by-file table. Ignore the
> line numbers and the file names in §"Implementation phases".
>
> The relocation is not cosmetic: `ParsedMesh` now crosses a `postMessage`
> boundary as transferable buffers, so adding a field means touching
> `src/parser/types.ts`, the worker's emit path, and the transfer list — and
> any grouping work has to decide whether it runs worker-side (before
> transfer) or main-thread-side (after). That trade-off is not analysed here.
>
> **What is still valid, and still worth reading.** The core insight is
> unimplemented and unchanged: group by web-ifc's own **`geometryExpressID`**
> rather than hashing vertex buffers, because two `placedGeom` entries sharing
> that id share the underlying `IfcGeometry` in the WASM heap — deterministic
> and free. That id is still read today (`src/parser/ifcWorker.ts:118`) and
> still dropped before `ParsedMesh` is emitted (`src/parser/types.ts`). The
> risk analysis (per-instance picking needs a sidecar `instanceId → expressID`
> map; `SelectionManager`, `raycastVisible` and `MarqueeSelector` all need
> adapting) also still holds.
>
> **Note a contradiction to resolve if this is ever picked up.** The roadmap's
> `instanced-meshes` card says to "hash positions+indices, group by hash".
> This document argues that is unnecessary. This document is right; the card
> should be corrected rather than followed.

---

# Phase — Instanced Meshes (collapse repeated geometry into `THREE.InstancedMesh`)

## TL;DR

Detect repeated geometry inside a loaded IFC model and render each repeat-group as a single `THREE.InstancedMesh` instead of N separate `THREE.Mesh` instances. The grouping key is **(web-ifc `geometryExpressID`, RGBA color)** — geometry identity comes from web-ifc itself (`placedGeom.geometryExpressID` in `src/parser/IfcParser.ts:46`), so we get **deterministic and free** geometry deduplication without hashing vertex buffers.

Expected wins on a 17 254-mesh model (Snowdon Towers Sample Structural.ifc — `dev/profiling.md:140-144`):
- **Draw calls: −60 % to −90 %** depending on geometry repetition rate. Rebar / bolt / panel / column-heavy structural models hit the upper bound.
- **GPU memory: −50 % to −80 %** on `BufferGeometry` (one set of GPU buffers per repeat-group instead of one per element).
- **JS heap: −10 % to −30 %** on the per-mesh `THREE.Mesh` JS-object overhead (which dominates over geometry bytes once material sharing — PR #26 — has already collapsed material allocations).

Risk surface: **high**. The change touches the parser shape (`ParsedMesh`), `ModelManager`'s build path, `SelectionManager.highlightExpress/unhighlightExpress`, `raycastVisible`, `MarqueeSelector.classifyMesh` + bucket emission, and `ModelEntry.meshesByExpressId`. Single biggest item: per-instance picking requires a sidecar `instanceId → expressID` map because `InstancedMesh` doesn't natively carry per-instance user data.

Effort: **L (5+ days)**. Phased into **five PRs** so each one ships in a state where the test suite + manual smoke remain green; the experimental flag gates the user-visible cut-over until Phase 5.

**End goal:** the 191 MB IFC user-reported orbit lag (queued as `render-perf-orbit-lag`) drops below the noise floor on machines that aren't fill-rate-bound. Material sharing (PR #26) addressed the state-change cost per draw; instancing addresses the draw-count itself.

---

## Goal

After this phase ships, loading a model with repeated geometry produces a scene where:

1. **Visible rendering is unchanged.** Same colors, same lighting, same z-fighting (or lack thereof) as before instancing.
2. **`renderer.info.render.calls` drops dramatically.** Concrete acceptance: on Snowdon Towers Sample Structural.ifc, the per-frame draw-call count after a fit-to-view drops from ~17 000 to **under 1 500** (≈90 % reduction). Re-measure live during smoke and document the actual number in the PR body.
3. **Selection, highlight, picking, marquee, and the inspector panel all work identically** to today — single-click pick on a bolt highlights *that bolt* (not all bolts sharing its geometry), marquee classification respects each instance's world position, click-then-properties shows the right element.
4. **Removing a model still fully reclaims GPU + JS memory.** Heap returns to ± 5 MB of baseline after a load → remove cycle (same convention as `dev/profiling.md:36-40`).

Out of scope for v1: per-instance LOD, GPU-side culling, deformable instances, animation. These belong to later cards.

---

## Background & motivation

### Why now

Three recent landings put us in a position where instancing is the natural next move:

- **PR #21** (marquee selection) added the per-model `ModelEntry.meshesByExpressId` index (`src/viewer/ModelManager.ts:17`) and the shared highlight-variant cache (`SelectionManager.highlightVariants`, `src/inspector/SelectionManager.ts:118`). Both data structures are already designed to handle multi-mesh-per-element; instancing makes them many-mesh-per-element-from-many-elements which is the same shape with different population.
- **PR #26** (material sharing by color) collapsed material allocations from ~mesh-count to a few dozen per model (`src/viewer/ModelManager.ts:50-77`). The remaining draw-call cost is now dominated by the **mesh count itself**, not state changes — exactly the cost instancing kills.
- **`dev/profiling.md:178-183`** explicitly names instancing as the second optimization after material sharing for the user's orbit-lag complaint.

### The user's 191 MB model

The user reports orbit / pan / zoom feels sluggish on a 191 MB IFC. From the roadmap (`dev/plans/roadmap.md:86-92`, `render-perf-orbit-lag`), profiling pointed at draw-call count. PR #26 addressed the state-change cost per draw; the next mile is fewer draws.

Real-world IFC models are *very* instance-rich. Concrete examples seen in the wild:
- Rebar: thousands of identical 12 mm/16 mm/20 mm rebar segments per slab.
- Bolts, anchors, washers: tens of thousands of identical fasteners.
- Curtain-wall panels, ceiling tiles, raised-floor squares: hundreds-to-thousands of identical surface elements.
- Structural columns / beams: dozens-to-hundreds of identical sections.

Each of those becomes 1 draw call instead of N.

### Why web-ifc makes this cheap

Critically: web-ifc already deduplicates geometry server-side. When IfcOpenShell-style geometry processing produces two visually identical placements, both `placedGeom` entries carry the **same `geometryExpressID`** (`src/parser/IfcParser.ts:46` reads `placedGeom.geometryExpressID`). That's a hard guarantee from web-ifc, not heuristic — two `placedGeom` entries sharing the id share the same vertex / index buffer in the WASM heap.

We don't need to hash anything. We just need to **expose that id through `ParsedMesh`** (today we drop it on the floor at `src/parser/IfcParser.ts:72-79`) and group on it in `ModelManager.addModel`.

This is the unlock. Without it, every "instanced meshes" plan ends up writing a positions+indices hash that's slower and less reliable than the data web-ifc already hands us.

---

## Key technical findings

### F1 — `placedGeom.geometryExpressID` is the grouping key

`src/parser/IfcParser.ts:43-91`. Inside the `StreamAllMeshes` callback, every `placedGeom` exposes `geometryExpressID: number`. Two placedGeoms sharing this id share the underlying `IfcGeometry` in the WASM heap. The parser today fetches the geometry, copies vertices/normals/indices into JS-owned typed arrays, and discards the id.

**Action:** add `geometryExpressID: number` to the `ParsedMesh` interface and propagate.

### F2 — `InstancedMesh` API surface in Three.js v0.183

Confirmed from `node_modules/three/src/objects/InstancedMesh.js`:

- Constructor: `new InstancedMesh(geometry, material, count)`. `count` is the **max** instance count — can be reduced at runtime via `.count = …`.
- Per-instance transform: `setMatrixAt(i, matrix4)` writes into the `instanceMatrix` buffer. After all writes, set `instanceMatrix.needsUpdate = true`.
- Per-instance tint: `setColorAt(i, color)` lazily allocates an `instanceColor` `InstancedBufferAttribute(count × 3)` and writes RGB. After all writes, set `instanceColor.needsUpdate = true`. The renderer multiplies the material's base color by this per-instance color in the shader (it's the `instanceColor` chunk wired into all built-in Three.js material shaders).
- Raycast: `InstancedMesh.raycast` (`InstancedMesh.js:259-309`) iterates each instance, transforms the mesh's bounding sphere through the per-instance matrix, runs a normal `Mesh.raycast` against the underlying geometry transformed by `matrixWorld × instanceMatrix`. Each intersect in the result has `intersect.instanceId: number` set, and `intersect.object` set to the `InstancedMesh` itself (not a synthetic per-instance mesh).
- `dispose()` (`InstancedMesh.js:391-402`) only frees the optional `morphTexture` — **geometry and material disposal is not handled by `InstancedMesh.dispose()`**, same as `Mesh.dispose()`. `ModelManager.removeModel` (`src/viewer/ModelManager.ts:107-132`) already disposes geometry + material per child of the model group, so the existing path covers this correctly **without modification**.
- `boundingBox` (the InstancedMesh's overall bounding box) is computed by `computeBoundingBox()` (`InstancedMesh.js:124-153`) by unioning every instance's transformed geometry box. For marquee we want **per-instance** boxes; we'll compute those ourselves from `geometry.boundingBox` + `instanceMatrix`.

### F3 — `userData.expressID` doesn't work for instances

The current selection / picking / marquee paths all read `mesh.userData.expressID` (`src/viewer/ModelManager.ts:80`, `src/inspector/SelectionManager.ts:593`, `src/inspector/MarqueeSelector.ts:267`). An `InstancedMesh` is a single Three.js object — `userData` is shared across all its instances. We need a **per-instance sidecar map**, attached to the InstancedMesh's `userData`.

Proposal: `mesh.userData.instanceExpressIds: Uint32Array` (the IDs themselves, in instance-index order). We use a `Uint32Array` because (a) IFC expressIDs are non-negative 32-bit integers, (b) it's the most compact storage, (c) it serializes / debugs cleanly. A normal `Map<number, number>` would also work but adds 50-100 bytes per entry vs 4 bytes for the typed array.

For the **inverse** lookup (`expressId → list of (mesh, instanceId)`), we extend the existing `ModelEntry.meshesByExpressId` (`src/viewer/ModelManager.ts:17`). Today it's `Map<number, THREE.Mesh[]>`. We change to:

```ts
export type MeshRef =
  | { kind: 'mesh'; mesh: THREE.Mesh }
  | { kind: 'instance'; mesh: THREE.InstancedMesh; instanceId: number };

export interface ModelEntry {
  // …
  meshesByExpressId: Map<number, MeshRef[]>;
}
```

The discriminated-union avoids losing type-safety while keeping the per-element index `O(1)` to read.

### F4 — Selection highlight needs `setColorAt`-based approach

`SelectionManager.highlightExpress` (`src/inspector/SelectionManager.ts:501-517`) clones the mesh's material with a blue emissive boost and swaps `mesh.material`. For an `InstancedMesh`, swapping material would tint **every** instance — wrong.

Three approaches considered (decisions section settles on **A**):

- **Plan A: per-instance `setColorAt`.** Highlighted instances get a blue-tinted color via `mesh.setColorAt(instanceId, blueTint)`. Non-highlighted instances stay at white (the identity color, leaving the base material color untouched). The highlight looks slightly different from today's emissive boost — it's an albedo modulation, not an emissive glow — but it's clearly visible and uses the documented Three.js API.
- Plan B: `onBeforeCompile` shader injection to add a per-instance emissive uniform / attribute. Truer to today's visual but the shader patch is fragile across Three.js upgrades.
- Plan C: temporarily lift the highlighted instance out into its own regular Mesh with an emissive material, decrement the InstancedMesh's effective count via a swap-to-last trick. Cleanest visual but the swap-to-last pattern mutates `instanceMatrix` ordering which would break our sidecar map.

Plan A wins for v1; document Plan B as the fallback if the visual difference is unacceptable in smoke.

### F5 — Raycast adaptation in `src/utils/raycast.ts`

`raycastVisible` (`src/utils/raycast.ts:7-39`) traverses the scene for `THREE.Mesh` and returns a `THREE.Intersection`. `InstancedMesh extends Mesh`, so the `instanceof THREE.Mesh` check already includes them, and `raycaster.intersectObjects` already invokes `InstancedMesh.raycast` which sets `intersect.instanceId`. **No change needed in `raycast.ts` itself.**

The change is at the **callers** of `raycastVisible`: `SelectionManager.handleClick` (`src/inspector/SelectionManager.ts:449-473`) and possibly `PivotPicker` / others. The caller must look at `hit.object` and `hit.instanceId` and resolve the right `expressID`. We centralize this resolution in a small helper:

```ts
// src/utils/raycast.ts
export function resolveExpressID(hit: THREE.Intersection): { modelId: string; expressId: number } | null;
```

That reads `hit.object.userData.instanceExpressIds[hit.instanceId]` for `InstancedMesh` and `hit.object.userData.expressID` for `Mesh`, plus the parent group's `.name` for modelId. Today's `identityFromHit` in `SelectionManager.ts:592-598` is the natural place to put the equivalent — we update it in-place.

### F6 — Marquee per-instance AABB tests

`MarqueeSelector.classifyMesh` (`src/inspector/MarqueeSelector.ts:477-504`) tests one AABB per mesh against the frustum. For an InstancedMesh that's wrong — all 1000 rebars of one geometry would share one giant AABB containing all of them, which would over-select.

**Per-instance AABB:** for each instance, compute `box = unitGeometryBox.applyMatrix4(instanceMatrix).applyMatrix4(mesh.matrixWorld)`. (The model group transform is identity in practice since transforms are baked at parse time, but defensive code uses `matrixWorld`.) Classify per-instance, contribute to the per-element bucket as today.

We extend the classifier API rather than overloading `classifyMesh`. New exported pure function:

```ts
export function classifyInstancedMesh(
  mesh: THREE.InstancedMesh,
  frustum: THREE.Frustum,
  clipPlanes: readonly THREE.Plane[],
  tmpBox: THREE.Box3,
  tmpMatrix: THREE.Matrix4,
  onInstance: (instanceId: number, classification: 'crossing' | 'window' | 'outside') => void,
): void;
```

The callback shape lets the existing bucket-builder in `commitSelection` (`src/inspector/MarqueeSelector.ts:244-300`) reuse its accumulation logic verbatim — it just calls `classifyInstancedMesh(child, …, (instId, c) => { /* same accumulator as classifyMesh's return */ })` instead of `classifyMesh`.

### F7 — `geometry.boundingBox` precompute is needed earlier

Today `ModelManager.addModel` does **not** call `computeBoundingBox` (`src/viewer/ModelManager.ts:53-60` deliberately leaves it lazy, paid by marquee). For instancing we need each unit geometry's `boundingBox` populated so `classifyInstancedMesh` can compute per-instance AABBs cheaply. Compute once per **unit geometry** (not per instance) at InstancedMesh construction.

The lazy-compute fallback in `classifyMesh` (`src/inspector/MarqueeSelector.ts:483-485`) still applies as a safety net for any non-instanced meshes.

### F8 — Material sharing synergy and the grouping key

PR #26's per-call `materialCache` (`src/viewer/ModelManager.ts:50-77`) already produces shared `MeshPhongMaterial` instances when two `ParsedMesh` entries share RGBA. For instancing, **two meshes must share both geometry AND material to instance together** — different colors on the same geometry must become separate InstancedMeshes (because color is per-material here, not per-instance).

Could we sidestep that with `setColorAt`? In principle yes — give every instance a different color via `setColorAt` and use one InstancedMesh per geometry-only group. We **explicitly choose not to** for v1 because:

- The base material's `opacity` / `transparent` flag varies by color (`MeshPhongMaterial({ transparent: c.a < 1 })`). Mixing opaque + transparent instances in one mesh would force one mode for all.
- Reusing the existing material cache means the rest of the pipeline (highlight variant cache, dispose accounting) doesn't need to change.
- Highlight via `setColorAt` is *additive* on top of the base color — if instances already varied by `setColorAt`, distinguishing "highlight tint" from "instance tint" gets complicated.

Grouping key: **`${geometryExpressID}|${matKey}`** where `matKey` is the existing RGBA string from `ModelManager.addModel`.

### F9 — Singletons and tiny groups

Groups of size 1 don't benefit from an InstancedMesh — same draw call cost, slight overhead from the instance matrix buffer. Groups of size 2-3 still produce 1 draw call vs 2-3 but with a noticeable constant overhead (texture lookup for `instanceMatrix`, etc.). Decision (settled below): **threshold = 4**. Groups < 4 stay as separate `THREE.Mesh` instances sharing the same `BufferGeometry` reference and the same material reference (still saves geometry memory).

### F10 — Existing tests are good safety nets but don't exercise instancing today

`tests/model-manager.test.ts` builds `ParsedModel` with `createMockParsedModel` (`tests/model-manager.test.ts:9-19`). The mock today has every mesh with a unique `expressID` but the **same vertices / normals / indices / transform** — which makes it accidentally a perfect instancing target once we expose `geometryExpressID`. The mock will be a Phase 1 update.

`tests/marquee-*.test.ts` will need a fixture that produces an InstancedMesh for the marquee classifier tests in Phase 4.

`tests/inspector-selection*.test.ts` will need an InstancedMesh fixture for the highlight tests in Phase 3.

### F11 — Existing `meshesByExpressId` consumers

`grep`-able consumers of `meshesByExpressId`:
- `SelectionManager.highlightExpress` (`src/inspector/SelectionManager.ts:506`)
- `SelectionManager.unhighlightExpress` (`src/inspector/SelectionManager.ts:525`)
- Any future code (none today).

Both callers iterate the array. We change the array's element type from `THREE.Mesh` to `MeshRef`. Both call sites need the dispatch (mesh vs instance) updated.

### F12 — `removeModel` traversal already handles InstancedMesh

`ModelManager.removeModel` (`src/viewer/ModelManager.ts:117-128`) traverses the model group with `child instanceof THREE.Mesh` (which is true for `InstancedMesh` too since it extends `Mesh`). The dispose loop calls `child.geometry.dispose()` + `child.material.dispose()`. Since `removeModel` walks **distinct** children, geometry shared between an InstancedMesh and a Mesh (i.e. when count was 3 → kept-as-Mesh AND count was 30 of same geom → InstancedMesh, then they share a `BufferGeometry`) would get `dispose()`'d twice. `BufferGeometry.dispose()` is idempotent (fires `dispose` event, GL renderer drops the buffer once), so this is safe — but a `Set<BufferGeometry>` dedup mirroring the existing material dedup is the right thing to add for accounting honesty, mirroring PR #26's pattern (`src/viewer/ModelManager.ts:116`).

In v1's grouping logic we **don't** share geometry across an InstancedMesh and a Mesh — only across instances of one InstancedMesh, or across the few unit Meshes in a singleton/small group. The dedup is cheap insurance.

---

## Confirmed scope decisions

| Decision | Choice | Why |
|----------|--------|-----|
| **D1: geometry grouping key** | Use `placedGeom.geometryExpressID` from web-ifc | Free, deterministic, guaranteed by web-ifc. See F1. Plumbing change in `ParsedMesh`. |
| **D2: instancing threshold** | `count >= 4` becomes `InstancedMesh`; `count 1..3` becomes regular `Mesh` instances (still sharing geometry / material) | F9. Threshold tunable in a single constant; if smoke shows a different sweet spot we revisit before Phase 5. |
| **D3: per-instance expressID storage** | `Uint32Array` sidecar at `mesh.userData.instanceExpressIds`. Forward index in `ModelEntry.meshesByExpressId` becomes `Map<number, MeshRef[]>` where `MeshRef` is a discriminated union. | F3. Compact, fast, no shader-side machinery. |
| **D4: highlight strategy** | Plan A — per-instance albedo tint via `setColorAt`. Plan B (shader-injection emissive) documented as fallback. | F4. Trade fidelity for simplicity in v1. |
| **D5: raycast API** | Keep `raycastVisible` returning `THREE.Intersection`. Resolve identity at callers via an updated `identityFromHit(hit)` (which reads `instanceExpressIds[instanceId]` when present). | F5. Minimal blast radius — callers already pass through `identityFromHit` today. |
| **D6: marquee per-instance** | New `classifyInstancedMesh(mesh, frustum, clipPlanes, tmpBox, tmpMatrix, onInstance)` pure function alongside existing `classifyMesh`. | F6. Avoids overloading `classifyMesh`'s signature; keeps the pure-function unit-test pattern clean. |
| **D7: disposal** | No change to `removeModel`'s walk (it's already `instanceof THREE.Mesh` which covers `InstancedMesh`). Add a `Set<BufferGeometry>` dedup mirroring the existing `Set<Material>` dedup. | F12. |
| **D8: material sharing synergy** | Compound key `${geometryExpressID}|${matKey}` — only group when **both** match. | F8. Avoids transparent/opaque mixing and instance-color-vs-highlight ambiguity. |
| **D9: experimental flag** | Yes — gated by `localStorage` key `ifcviewer:experimental-instancing` (default off). Until Phase 5 the flag stays opt-in. Phase 5 removes the flag and the legacy code path. | High risk surface; flag-gating buys safe iteration. |
| **D10: phasing** | Five PRs — Foundation / Grouping / Selection / Marquee / Unflag (see Implementation phases). | Each PR ships with green CI and a working manual smoke against `experimental-instancing=false`. |
| **D11: `instanceCount` cap** | None for v1 (`Uint32Array` covers > 4 billion which is well beyond any real model). The InstancedMesh `count` is `number` in Three.js. | Simplicity. |
| **D12: animations of instances** | Not in v1. Instance matrices are written once at build and never updated. | Scope discipline; reuse decision when section-cuts or hide-element features land. |
| **D13: shadows** | Today the viewer doesn't cast shadows. If/when shadow maps are added, `InstancedMesh.castShadow = true` already works (Three.js handles per-instance shadow). No special handling. | Future-proof. |
| **D14: bounding box precompute for unit geometry** | Yes — call `geometry.computeBoundingBox()` once per unit geometry at InstancedMesh construction. Cheap. | F7. Required for marquee. |

---

## Out of scope (v2+)

- **Per-instance LOD.** When a model gets too big to render even with instancing, drop low-importance instances at distance. Distinct ticket.
- **GPU-side frustum culling per instance.** Three.js skips a whole InstancedMesh when its overall bounding box is out-of-frustum, but doesn't cull individual instances. A compute-shader-based per-instance cull would lift another 2-5× on partially-visible models. Defer.
- **Deformable / animated instances.** Per-frame matrix updates work but require care. Don't ship until there's a use case (e.g. clash explode).
- **Per-vertex animations.** Out of scope.
- **Shader-injection-based emissive highlight (Plan B from F4).** Document as fallback. Implement only if smoke shows Plan A is unacceptable.
- **Mixing transparent + opaque in one InstancedMesh.** Not in v1; requires fine-grained sorting that the renderer doesn't do automatically per-instance.
- **InstancedBatchedMesh / `BatchedMesh`.** Newer Three.js API that combines instancing with batching (different geometries in one draw via indirect rendering). Powerful, but more invasive — defer.
- **Threshold > 4 tuning.** Defer to a perf-tuning PR after smoke shows real numbers.
- **Forcing all-singletons to one InstancedMesh per material.** Could collapse the long tail of count=1 / count=2 geometries into shared draws. Defer; probably small wins for big complexity.

---

## Architecture

### Touched module map

| Module | Role today | Role after Phase 5 |
|--------|-----------|---------------------|
| `src/parser/IfcParser.ts` | Emits `ParsedMesh[]` with vertex / index / transform / color | Same, plus `geometryExpressID` per `ParsedMesh` |
| `src/viewer/ModelManager.ts` | Builds per-element `THREE.Mesh` instances; per-call material cache; `meshesByExpressId: Map<number, Mesh[]>` | Groups by `(geometryExpressID, matKey)`; `count >= 4` → `InstancedMesh`, else `Mesh`; `meshesByExpressId: Map<number, MeshRef[]>`; per-call geometry cache; per-call material cache (existing); per-instance expressID sidecar on InstancedMesh |
| `src/utils/raycast.ts` | Walks visible meshes, raycasts, returns first hit respecting clip planes | **Unchanged** — `InstancedMesh extends Mesh`, raycast already returns `intersect.instanceId` |
| `src/inspector/SelectionManager.ts` | `identityFromHit(mesh)` reads `userData.expressID`; `highlightExpress` swaps `mesh.material` to a cached cloned variant | `identityFromHit(hit)` (takes `Intersection`, not mesh — passes through `instanceId` resolution); `highlightExpress` dispatches mesh-vs-instance and tints via `setColorAt` for instances |
| `src/inspector/MarqueeSelector.ts` | `classifyMesh(mesh, …)` returns one classification per mesh | Adds `classifyInstancedMesh(mesh, …, onInstance)`; `commitSelection` dispatches by `instanceof InstancedMesh` |
| `tests/*` | 387 tests, all passing | +~25 tests across the five PRs |
| `dev/plans/roadmap.md` | `instanced-meshes` card status = `blocked` | After Phase 5: card moved to **Done** |

### Data flow before and after

**Before (today, post PR #26):**

```
IfcParser
  StreamAllMeshes → ParsedMesh { expressID, vertices, indices, normals, transform, color }
                    [a ParsedMesh per (element, geometry)]
ModelManager.addModel(ParsedModel)
  for each ParsedMesh:
    BufferGeometry (new)
    MeshPhongMaterial (cached by RGBA)
    Mesh (new) with applyMatrix4(transform); userData.expressID = expressID
    meshesByExpressId.get(expressID).push(mesh)
  scene.add(group)
```

**After (Phase 5):**

```
IfcParser
  StreamAllMeshes → ParsedMesh { expressID, geometryExpressID, vertices, indices, normals, transform, color }
ModelManager.addModel(ParsedModel)
  // Phase A: bucket by (geometryExpressID, matKey)
  buckets: Map<key, ParsedMesh[]>
  for each ParsedMesh: buckets.get(key).push(parsed)
  // Phase B: build the unit geometry once per (geometryExpressID, *) (across all matKeys)
  geomCache: Map<geometryExpressID, BufferGeometry>
  // Phase C: emit
  for each bucket of size N:
    if N >= 4: emit one InstancedMesh
      → setMatrixAt(i, transformMatrix_i)
      → userData.instanceExpressIds: Uint32Array (length N)
      → meshesByExpressId.get(expressId_i).push({ kind: 'instance', mesh, instanceId: i })
    else: emit N regular Meshes sharing the same BufferGeometry + Material
      → userData.expressID = expressID
      → meshesByExpressId.get(expressID).push({ kind: 'mesh', mesh })
```

### Selection paths

**Single-click pick:**

```
canvas pointerdown / pointerup → SelectionManager.handleClick
  raycastVisible → Intersection { object, instanceId? }
  identityFromHit(hit) ← reads object.userData (Mesh or InstancedMesh sidecar)
  apply('replace'/'add'/'remove', identity)
```

`identityFromHit` becomes:
```ts
function identityFromHit(hit: THREE.Intersection): ElementIdentity | null {
  const obj = hit.object;
  const parent = obj.parent;
  if (!parent || !parent.name || !(obj instanceof THREE.Mesh)) return null;
  let expressId: number | undefined;
  if (obj instanceof THREE.InstancedMesh) {
    const ids = obj.userData.instanceExpressIds as Uint32Array | undefined;
    if (!ids || typeof hit.instanceId !== 'number') return null;
    expressId = ids[hit.instanceId];
  } else {
    expressId = obj.userData.expressID;
  }
  if (typeof expressId !== 'number') return null;
  return placeholderIdentity(parent.name, expressId);
}
```

**Highlight:**

`SelectionManager.highlightExpress(modelId, expressId)` becomes:
```
matches = model.meshesByExpressId.get(expressId)  // MeshRef[]
for each ref of matches:
  if ref.kind === 'mesh':
    // existing path — material swap to highlight variant
    if highlights.has(ref.mesh.uuid) continue
    variant = getHighlightVariant(ref.mesh.material)
    ref.mesh.material = variant
    highlights.set(ref.mesh.uuid, { mesh: ref.mesh, originalMaterial: ref.mesh.material })
  else:
    // instance path — setColorAt tint
    key = `${ref.mesh.uuid}:${ref.instanceId}`
    if instanceHighlights.has(key) continue
    ref.mesh.setColorAt(ref.instanceId, HIGHLIGHT_TINT_COLOR)
    ref.mesh.instanceColor.needsUpdate = true
    instanceHighlights.set(key, { mesh: ref.mesh, instanceId: ref.instanceId })
```

`unhighlightExpress` mirrors the dispatch — for instances, `setColorAt(instanceId, IDENTITY_COLOR)` and `instanceColor.needsUpdate = true`, then drop from `instanceHighlights`.

**Marquee classification:**

In `MarqueeSelector.commitSelection` (`src/inspector/MarqueeSelector.ts:244-300`):
```
for each entry of getAllModels():
  for each child of entry.group.children:
    if child instanceof THREE.InstancedMesh:
      classifyInstancedMesh(child, frustum, clipPlanes, tmpBox, tmpMatrix, (i, c) => {
        const expressId = child.userData.instanceExpressIds[i]
        bucket = buckets.get(`${entry.id}:${expressId}`)
        bucket.all += 1
        if c !== 'outside': bucket.touches += 1
        if c === 'window': bucket.window += 1
      })
    else if child instanceof THREE.Mesh:
      // existing path unchanged
```

But — careful. Today's bucket logic does `bucket.all += 1` once per call (`MarqueeSelector.ts:287`), reflecting "this element has one more rendered mesh". For an InstancedMesh holding N instances of `expressID=X`, the **same expressID can repeat across instances**? In practice no — IFC instance placements share `geometryExpressID` (the shape) but each placement is a different element with a different `expressID`. We assert this in the unit test: every entry of `instanceExpressIds` for one InstancedMesh is unique.

But across **multiple** InstancedMeshes, the same expressID could appear in different shape-buckets only if a single IFC element has multiple visual representations — which today produces multiple `placedGeom` entries with the same `flatMesh.expressID` but different `geometryExpressID`. That's exactly today's situation already handled by the "one expressID maps to multiple meshes" pattern. We preserve it.

So the marquee bucket math is unchanged conceptually:
- `bucket.all` counts how many rendered instances belong to this element across all instanced+non-instanced meshes.
- `bucket.touches` counts how many of those instances are at least crossing.
- `bucket.window` counts how many are fully inside.
- `bucketResults` decision (crossing vs window) (`src/inspector/MarqueeSelector.ts:514-529`) doesn't change.

### Feature flag

Phase 2 introduces:
```ts
// src/viewer/ModelManager.ts
const INSTANCING_THRESHOLD = 4;

function isInstancingEnabled(): boolean {
  try {
    return window.localStorage?.getItem('ifcviewer:experimental-instancing') === 'true';
  } catch { return false; }
}
```

The grouping path inside `addModel` checks the flag. With flag off, every `ParsedMesh` still becomes its own `Mesh` (today's behavior bit-exact). With flag on, the grouping runs.

Phases 3 and 4 update selection / marquee paths to handle InstancedMeshes — but those paths are invoked regardless of the flag, because they need to deal with both shapes (either is possible depending on the flag). The flag only gates the **construction** side.

Phase 5 removes the flag and the legacy fallback path inside `addModel`.

### Sketch — new types in `src/viewer/ModelManager.ts`

```ts
/** A back-reference to a renderable that represents an IFC element. */
export type MeshRef =
  | { kind: 'mesh'; mesh: THREE.Mesh }
  | { kind: 'instance'; mesh: THREE.InstancedMesh; instanceId: number };

export interface ModelEntry {
  id: string;
  group: THREE.Group;
  visible: boolean;
  meshesByExpressId: Map<number, MeshRef[]>;
}
```

Today: `Map<number, THREE.Mesh[]>`. After Phase 2: `Map<number, MeshRef[]>`. Selection / marquee read `MeshRef[]` regardless of flag; legacy code path emits all `kind: 'mesh'` entries.

---

## Algorithm details

### Grouping (Phase 2)

Inside `ModelManager.addModel(parsed: ParsedModel)`:

```
materialCache: Map<string, MeshPhongMaterial>     // existing, RGBA key
geomCache: Map<number, BufferGeometry>            // new, geometryExpressID key
groupKey(parsedMesh): `${geometryExpressID}|${matKey(parsedMesh.color)}`
buckets: Map<string, ParsedMesh[]>                // groupKey → entries

1) Single pass: for each parsedMesh, append to buckets.get(groupKey(parsedMesh))
2) For each bucket [count = bucket.length]:
   a) Resolve / build BufferGeometry (geomCache by geometryExpressID).
      First time: build geometry from parsedMesh.vertices/normals/indices.
                  Compute bounding box.
                  Insert into geomCache.
      Subsequent: reuse the cached geometry. (vertices/normals/indices in
                  later ParsedMesh entries are byte-equal to the first; we
                  trust web-ifc here — no validation needed in v1, but
                  Phase 1 could add an opt-in debug assertion.)
   b) Resolve / build material (existing materialCache by matKey).
   c) If count >= INSTANCING_THRESHOLD (4):
        instMesh = new THREE.InstancedMesh(geom, material, count)
        ids = new Uint32Array(count)
        for i in 0..count-1:
          matrix = Matrix4.fromArray(bucket[i].transform)
          instMesh.setMatrixAt(i, matrix)
          ids[i] = bucket[i].expressID
        instMesh.instanceMatrix.needsUpdate = true
        instMesh.userData.instanceExpressIds = ids
        // setColorAt(i, white) for every i so instanceColor is initialized
        // to identity. We do this lazily on first highlight to avoid the
        // memory cost — see "Per-instance color buffer lifecycle" below.
        group.add(instMesh)
        for i in 0..count-1:
          meshesByExpressId.get(ids[i]).push({ kind: 'instance', mesh: instMesh, instanceId: i })
      else:
        for each parsedMesh in bucket:
          mesh = new THREE.Mesh(geom, material)
          mesh.applyMatrix4(Matrix4.fromArray(parsedMesh.transform))
          mesh.userData.expressID = parsedMesh.expressID
          group.add(mesh)
          meshesByExpressId.get(parsedMesh.expressID).push({ kind: 'mesh', mesh })
```

Notes:

- The `setMatrixAt` matrix is the **placement transform** from web-ifc, not an identity. That matches today: regular meshes do `mesh.applyMatrix4(parsedMesh.transform)`. For instanced meshes the placement IS the instance matrix.
- `instMesh.matrixWorld` stays identity (the group's transform is identity in practice). Per-instance world = `matrixWorld × instanceMatrix` = `instanceMatrix`.
- The order of instance indices within an InstancedMesh is the order of insertion from the bucket. This matters because the sidecar `instanceExpressIds[i]` must align with the matrix at instance `i`. We never reorder.

### Per-instance color buffer lifecycle

Three.js lazily allocates `instanceColor` on first `setColorAt`. Two strategies:

- **Eager**: at construction, call `setColorAt(i, white)` for every instance. Costs `count * 3 * 4 = 12 * count` bytes of GPU memory per InstancedMesh from the start, but means highlight code can simply call `setColorAt(highlightedInstanceId, blue)` without worrying about per-instance defaults.
- **Lazy**: don't initialize `instanceColor` until the first highlight on this mesh; on first highlight, the `setColorAt` call in `InstancedMesh.setColorAt` allocates the buffer and `.fill(1)`s it (Three.js does this — see `InstancedMesh.js:322`). All other instances start at white (identity). Then we just set the highlighted one's slot.

We choose **lazy** because:
- Most InstancedMeshes will never have a highlighted instance during a session (a marquee selects a tiny fraction of bolts).
- Three.js already does the `.fill(1)` lazily; no need to duplicate.
- Saves `12 * total_instances` bytes of GPU upload at load.

Cost: a tiny first-highlight delay (one buffer alloc + one upload). Imperceptible.

### Highlight tint color

Today's emissive highlight is `HIGHLIGHT_COLOR = 0x3b82f6` (`src/inspector/SelectionManager.ts:44`) with intensity 0.3. The closest albedo tint that reads as "selected" without being garish is **`new THREE.Color(0x6a9fff)`** (a desaturated brand-blue, lighter than the brand color). This is multiplicative with the base material color, so dark base materials still get a perceptible blue cast.

We expose this as a new constant `HIGHLIGHT_INSTANCE_COLOR` next to the existing `HIGHLIGHT_COLOR`. Smoke calibrates it.

Reset to identity: `new THREE.Color(1, 1, 1)` — white, which multiplies as no-op.

### Marquee per-instance classification

```ts
export function classifyInstancedMesh(
  mesh: THREE.InstancedMesh,
  frustum: THREE.Frustum,
  clipPlanes: readonly THREE.Plane[],
  tmpBox: THREE.Box3,
  tmpMatrix: THREE.Matrix4,
  onInstance: (instanceId: number, classification: 'crossing' | 'window' | 'outside') => void,
): void {
  if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
  const local = mesh.geometry.boundingBox;
  if (!local) {
    for (let i = 0; i < mesh.count; i++) onInstance(i, 'outside');
    return;
  }

  // Early-out: the InstancedMesh's overall bounding sphere out-of-frustum
  // means every instance is out-of-frustum. Three.js's frustum culling
  // already handles this for rendering; we replicate for marquee speed.
  if (mesh.boundingSphere === null) mesh.computeBoundingSphere();
  // (boundingSphere is the union of per-instance spheres; if it doesn't
  // intersect the frustum, no instance can — fast path.)
  // … sphere-vs-frustum test using frustum.intersectsSphere
  // (skipped if not safe; conservative fallback is no-early-out.)

  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, tmpMatrix);
    // World matrix = mesh.matrixWorld * instanceMatrix.
    tmpMatrix.premultiply(mesh.matrixWorld);
    tmpBox.copy(local).applyMatrix4(tmpMatrix);

    // Clip-plane reject.
    let clipped = false;
    for (const plane of clipPlanes) {
      if (boxFullyClippedByPlane(tmpBox, plane)) { clipped = true; break; }
    }
    if (clipped) { onInstance(i, 'outside'); continue; }

    if (!frustum.intersectsBox(tmpBox)) { onInstance(i, 'outside'); continue; }
    if (boxFullyInsideFrustum(tmpBox, frustum)) { onInstance(i, 'window'); continue; }
    onInstance(i, 'crossing');
  }
}
```

The existing `boxFullyClippedByPlane` and `boxFullyInsideFrustum` helpers in `MarqueeSelector.ts:542-566` are reused unchanged.

---

## Files to touch

| Phase | File | Change |
|-------|------|--------|
| 1 | `src/parser/IfcParser.ts` | Add `geometryExpressID: number` to `ParsedMesh`. Read `placedGeom.geometryExpressID` (already loaded, line 46) and copy into the emitted `ParsedMesh`. No other behavior change. |
| 1 | `tests/model-manager.test.ts` (helper) | `createMockParsedModel` now supplies `geometryExpressID` (default to a generated value; new test-case overrides for grouping tests). |
| 1 | `tests/parser-shape.test.ts` (NEW, small) | Unit test asserting `IfcParser.parse` populates `geometryExpressID` correctly for a stub `IfcAPI`. Optional — if parser tests already exist, extend instead. |
| 2 | `src/viewer/ModelManager.ts` | (a) Extend `ModelEntry.meshesByExpressId` to `Map<number, MeshRef[]>`. (b) Export `MeshRef`. (c) Refactor `addModel` body into `addModelLegacy` (current code) and `addModelInstanced` (new grouping path). Dispatch via `isInstancingEnabled()`. (d) `removeModel` adds `Set<BufferGeometry>` dedup. |
| 2 | `tests/model-manager.test.ts` | New describe block `geometry instancing (flag on)`: enables flag, asserts InstancedMesh emitted for count ≥ 4 of same geomKey, asserts singletons stay as Mesh, asserts `meshesByExpressId` populated with `MeshRef` of correct kind. Sets / restores localStorage in `beforeEach` / `afterEach`. |
| 3 | `src/utils/raycast.ts` | **No change.** (Confirmed in F5.) Add a `// NOTE:` comment that `InstancedMesh` is implicitly supported via `Mesh`-instanceof. |
| 3 | `src/inspector/SelectionManager.ts` | (a) `identityFromHit` becomes `identityFromHit(hit: THREE.Intersection)`. (b) `handleClick` passes the full intersection. (c) New private `instanceHighlights: Map<string, { mesh, instanceId }>`. (d) New helper `getHighlightInstanceColor()` returning `HIGHLIGHT_INSTANCE_COLOR`. (e) `highlightExpress` / `unhighlightExpress` dispatch on `MeshRef.kind`. (f) `clearInternal` clears both maps and resets instance colors. |
| 3 | `tests/inspector-selection.test.ts` | New tests: highlight via setColorAt path on an InstancedMesh fixture; unhighlight resets; clear resets all instances; `instanceColor.needsUpdate` flipped to true after each tint write. |
| 4 | `src/inspector/MarqueeSelector.ts` | (a) Export new `classifyInstancedMesh`. (b) `commitSelection` dispatches by `instanceof InstancedMesh`. (c) Bucket-emission unchanged. |
| 4 | `tests/marquee-classify.test.ts` | New tests: per-instance classification — three instances at different world positions, marquee covering only the middle one → only middle returns `window`. |
| 4 | `tests/marquee-selector.test.ts` | New end-to-end test: Alt-drag with InstancedMesh fixture, assert `applyMany` called with the right `expressID` subset. |
| 5 | `src/viewer/ModelManager.ts` | Delete `addModelLegacy`. Delete `isInstancingEnabled` and the flag check. The instanced path becomes the only path. |
| 5 | `dev/plans/roadmap.md` | Move `instanced-meshes` card from Queued/blocked to Done with the merged PR number. |
| 1-5 | `dev/profiling.md` | Append a new "Baselines" entry per phase with measured draw-call / heap / parse-time numbers on RIB.ifc + Snowdon. |

**Files NOT to touch:**

- `src/utils/raycast.ts` (Phase 3 verifies it doesn't need to change; only adds a comment).
- `src/viewer/Viewer.ts` — no API change needed.
- `src/core/App.ts` — no construction or wiring change.
- `src/tools/ClippingTool.ts`, `src/tools/MeasurementTool.ts` — they use `raycastVisible` and ignore `instanceId`; unchanged behavior on click (today's behavior is "first hit"; an instanced mesh hit gives the same `intersect.point` / `intersect.face`).
- `src/inspector/InspectorPanel.ts` — consumes `ElementIdentity[]`, unchanged.
- `src/store/sessionStore.ts` and the ModelRecord registry (commit `0e28450`) — they serialize the IFC bytes, not the rendered scene.

---

## Implementation phases

### Phase 1 — Foundation (PR #N+1)

**Scope:** plumb `geometryExpressID` through `ParsedMesh`. No rendering change. No flag. No InstancedMesh anywhere.

**Branch:** `feature/instanced-meshes-1-parser`.

**Steps:**
1. Confirm baseline green on main (`npm test && npm run lint && npm run typecheck`).
2. Branch off main.
3. Update `ParsedMesh` interface in `src/parser/IfcParser.ts:3-10` to add `geometryExpressID: number`.
4. Update `IfcParser.parse` (`src/parser/IfcParser.ts:72-79`) to set `geometryExpressID: placedGeom.geometryExpressID` on the emitted `ParsedMesh`.
5. Update `tests/model-manager.test.ts`'s `createMockParsedModel` helper to populate `geometryExpressID` (default: unique per-mesh, distinct, so today's tests still cover the no-grouping case).
6. Run full test suite. Should be 387/387 green (no new tests yet).
7. Lint + typecheck. Clean.
8. Manual smoke: load RIB.ifc, confirm rendering unchanged.
9. PR with title `Phase 1/5 — Expose geometryExpressID through ParsedMesh (instanced meshes)`. Body links this plan + the roadmap card.

**Tests:** none added. The shape change is type-safe-only and existing tests catch any regression in the parser shape.

**Manual smoke:** load RIB.ifc + Snowdon. Confirm models render identically. No console errors.

**Risks for this phase:** none — pure plumbing.

### Phase 2 — Grouping + InstancedMesh construction (PR #N+2)

**Scope:** add the grouping logic and InstancedMesh emission in `ModelManager.addModel`, gated by the `experimental-instancing` localStorage flag. Selection / raycast / marquee paths are **NOT** updated yet — with the flag on, single-click and marquee will silently misbehave on instanced meshes (a click on a bolt would resolve to `undefined` expressID and silently no-op). That's fine because the flag is off by default.

**Branch:** `feature/instanced-meshes-2-build`.

**Steps:**
1. Confirm Phase 1 merged to main; rebase.
2. Branch off main.
3. Extend `ModelEntry` interface (`src/viewer/ModelManager.ts:4-18`):
   ```ts
   export type MeshRef =
     | { kind: 'mesh'; mesh: THREE.Mesh }
     | { kind: 'instance'; mesh: THREE.InstancedMesh; instanceId: number };
   meshesByExpressId: Map<number, MeshRef[]>;
   ```
4. Refactor existing `addModel` body into `addModelLegacy(parsed): ModelEntry` (functionally identical to today, but pushes `{ kind: 'mesh', mesh }` into the map).
5. Add `addModelInstanced(parsed): ModelEntry` with the grouping algorithm described in **Algorithm details**.
6. Add `isInstancingEnabled()` helper and dispatch in `addModel`.
7. Add `Set<BufferGeometry>` dedup in `removeModel` mirroring the existing material dedup.
8. Update all consumers of `meshesByExpressId.get(eid)` — currently just `SelectionManager`. **In Phase 2 we only adapt the callsite shape (type compiles), but the highlight semantics still assume `MeshRef.kind === 'mesh'`.** A type-narrowing guard `if (ref.kind !== 'mesh') continue;` is fine; the instance path is fully wired in Phase 3.
9. Add the Phase 2 test block:
   - `geometry instancing (flag on) — groups by geometryExpressID`: 5 ParsedMesh with same geomID → 1 InstancedMesh, `count=5`, `userData.instanceExpressIds` has all 5 IDs in order.
   - `geometry instancing (flag on) — count < 4 stays as Mesh`: 3 ParsedMesh with same geomID → 3 separate Mesh instances, all sharing the same `BufferGeometry` reference (assert `meshes[0].geometry === meshes[1].geometry`).
   - `geometry instancing (flag on) — different colors do not group`: 5 ParsedMesh with same geomID but two distinct colors (3 + 2) → one InstancedMesh of count 3 and (since 2 < 4) two Mesh instances. Materials differ; geometries are the same reference.
   - `geometry instancing (flag off) — legacy behavior unchanged`: existing tests still pass with flag off (they do — the test suite never sets the flag).
   - `removeModel disposes shared geometry only once`: 5 ParsedMesh with same geomID → InstancedMesh + 0 extra. Spy on `BufferGeometry.dispose`. Expect exactly 1 call.
   - `meshesByExpressId populated with kind: instance for InstancedMesh members`: assert ref.kind and ref.instanceId.
10. Full test run. Should pass with flag default off and pass with flag on.
11. Lint + typecheck.
12. Manual smoke:
    - **With flag OFF** (default): load RIB.ifc + Snowdon. Confirm no behavior change. All selection / marquee / inspector flows work as today.
    - **With flag ON** (set in DevTools console: `localStorage.setItem('ifcviewer:experimental-instancing', 'true')`, reload): load Snowdon. Confirm rendering is **visually identical**. Confirm `viewer.getRenderer().info.render.calls` drops dramatically. **Selection and marquee will misbehave on instanced meshes** — document this expected limitation in the PR body. Reset flag to off.
    - With flag ON and load → remove cycle: heap returns to baseline (± 5 MB).
13. PR with title `Phase 2/5 — InstancedMesh construction under experimental flag (instanced meshes)`.

**Tests:** ~6 new in `tests/model-manager.test.ts`, all in a `describe('experimental instancing', …)` block with `beforeEach` enabling the flag and `afterEach` clearing it.

**Manual smoke acceptance:**
- Flag-off rendering bit-equivalent to main.
- Flag-on rendering visually identical (color, lighting, occlusion).
- Flag-on draw-call reduction visible in `renderer.info`.

**Risks:** highest-risk phase. Mitigation: keep `addModelLegacy` intact and dispatch via the flag — any production regression can be hotfixed by toggling the default.

### Phase 3 — Selection compatibility (PR #N+3)

**Scope:** make single-click pick, highlight, unhighlight, and clear all work on `InstancedMesh`. With the flag on, the user can click a bolt and see only that bolt highlight. The marquee still misbehaves on instanced meshes — that's Phase 4.

**Branch:** `feature/instanced-meshes-3-selection`.

**Steps:**
1. Confirm Phase 2 merged.
2. Branch off main.
3. Update `identityFromHit` in `src/inspector/SelectionManager.ts:592-598` to take a `THREE.Intersection` and resolve via the `instanceExpressIds` sidecar when applicable.
4. Update `handleClick` (`src/inspector/SelectionManager.ts:449-473`) to pass `hit` (not `hit.object`) to `identityFromHit`.
5. Add `private instanceHighlights = new Map<string, { mesh: THREE.InstancedMesh; instanceId: number }>();` to `SelectionManager` (`src/inspector/SelectionManager.ts:97-101` block).
6. Add `HIGHLIGHT_INSTANCE_COLOR = new THREE.Color(0x6a9fff)` and `IDENTITY_INSTANCE_COLOR = new THREE.Color(1, 1, 1)` constants.
7. Update `highlightExpress` to dispatch on `MeshRef.kind`:
   - `'mesh'`: existing material-clone path.
   - `'instance'`: `mesh.setColorAt(instanceId, HIGHLIGHT_INSTANCE_COLOR); mesh.instanceColor.needsUpdate = true; instanceHighlights.set(...)`.
8. Update `unhighlightExpress` to mirror — `setColorAt(instanceId, IDENTITY_INSTANCE_COLOR); instanceColor.needsUpdate = true; instanceHighlights.delete(...)`.
9. Update `clearInternal` to also reset every instance in `instanceHighlights` and clear the map.
10. Update `onModelRemoved` to clear any `instanceHighlights` entries whose mesh's parent group name matches the removed model.
11. Phase 3 tests:
    - Highlight a single instance: `setColorAt` called with tint color, `instanceColor.needsUpdate` true after.
    - Highlight then unhighlight: `setColorAt` called twice (tint, then identity).
    - Highlight two instances of the same InstancedMesh, deselect one: only that one resets to identity.
    - Click on a regular Mesh still uses the material-clone path (regression).
    - `clearInternal` resets all instance highlights.
    - `onModelRemoved` clears instance highlights for the removed model.
    - `identityFromHit` returns correct expressID for instanced hits and `null` for hits without an instanceId on an InstancedMesh (defensive).
12. Full test run.
13. Lint + typecheck.
14. Manual smoke:
    - Flag ON, load Snowdon. Click a bolt — only that bolt highlights (visible tint). Click a different bolt — first one returns to base color, second tints.
    - Ctrl-click adds to selection — multiple bolts tint blue.
    - Shift-click removes — tinted bolts return to base.
    - Click a wall (regular Mesh, count was 1): existing emissive highlight works.
    - Mixed selection: a wall (Mesh) + a bolt (Instance). Wall material-cloned, bolt tinted. Esc clears both.
    - Inspector panel updates correctly with the right expressIDs.
    - Click empty canvas → clears selection.
15. PR with title `Phase 3/5 — Selection / highlight for InstancedMesh (instanced meshes)`.

**Tests:** ~7 new in `tests/inspector-selection.test.ts`, mostly in a `describe('instanced mesh highlight', …)` block.

**Manual smoke acceptance:** click-to-pick of a bolt produces the right highlight visually and the right `expressID` in the inspector.

**Risks:** the tint color might look subtly wrong (too washed-out, too saturated). If smoke fails on the visual, escalate to Plan B (shader-injection emissive). Decision documented before merge.

### Phase 4 — Marquee compatibility (PR #N+4)

**Scope:** marquee selection respects per-instance AABBs.

**Branch:** `feature/instanced-meshes-4-marquee`.

**Steps:**
1. Confirm Phase 3 merged.
2. Branch off main.
3. Add `classifyInstancedMesh` pure function to `src/inspector/MarqueeSelector.ts` (alongside `classifyMesh`).
4. In `commitSelection` (`src/inspector/MarqueeSelector.ts:244-300`), dispatch by `instanceof InstancedMesh`. For instance path, call `classifyInstancedMesh` with a callback that does the same bucket-accumulation logic.
5. Add a reusable `tmpMatrix = new THREE.Matrix4()` near `tmpBox`.
6. Phase 4 tests:
    - `classifyInstancedMesh` with 3 instances at distinct world positions, marquee covers only middle → callback fires `outside`, `window`, `outside` in order.
    - With crossing marquee straddling two instances → callback fires `crossing`, `crossing`, `outside`.
    - With clip plane on cut-side of all instances → callback fires `outside` × 3.
    - Marquee end-to-end test (jsdom): InstancedMesh of count 5 with diverse `expressID`s, drag covers instances 1 and 3 → `applyMany('replace', identities)` called with identities[1, 3].
    - Mixed scene: 1 InstancedMesh + 1 Mesh, marquee covers both → both end up in the bucket / selection.
7. Full test run.
8. Lint + typecheck.
9. Manual smoke:
    - Flag ON. Load Snowdon. Marquee a small region containing some bolts and some walls. Confirm only the bolts inside the marquee tint, plus the walls inside tint via material clone.
    - Right-to-left marquee (crossing): partial bolts included.
    - Left-to-right marquee (window): only fully-enclosed bolts.
    - Marquee respect for clipping: place a clip plane through a row of bolts, marquee the row → bolts on the visible side selected, bolts on the cut side not.
    - Hidden model: hide one model, marquee covers both → only visible model's instances classified.
    - Esc during drag: no commit.
    - Performance: marquee covering all of Snowdon (~17k instances): release-to-highlight latency under ~500 ms (vs the ~10 ms target for 50k regular meshes per `phase-marquee-selection.md`'s notes — per-instance math is heavier).
10. PR with title `Phase 4/5 — Marquee per-instance classification (instanced meshes)`.

**Tests:** ~5 new across `tests/marquee-classify.test.ts` and `tests/marquee-selector.test.ts`.

**Manual smoke acceptance:** marquee on Snowdon under flag-on selects the right elements visibly and propagates the right `expressID`s to the inspector.

**Risks:** per-instance classification is O(instance-count) per InstancedMesh. On 17k instances it's still fast (microseconds per instance × 17k = ~10 ms-100 ms total). If smoke shows the marquee feels slow on huge models, add the bounding-sphere early-out from F6.

### Phase 5 — Unflag + cleanup (PR #N+5)

**Scope:** make instancing the default. Remove the flag. Remove `addModelLegacy`. Update docs.

**Branch:** `feature/instanced-meshes-5-default`.

**Steps:**
1. Confirm Phases 1-4 merged + manual smoke green.
2. Branch off main.
3. Delete `addModelLegacy` and the flag check in `ModelManager.addModel`. The instanced path becomes the only path.
4. Delete the `isInstancingEnabled` helper.
5. Remove the `localStorage` key `ifcviewer:experimental-instancing` from any documentation that references it (smoke notes, dev docs).
6. Update `dev/plans/roadmap.md` — move the `instanced-meshes` card from Queued/blocked to Done with the merged PR number(s). Reference each phase PR.
7. Append final measured numbers to `dev/profiling.md` Baselines section (RIB + Snowdon, draw calls / heap / parse / orbit smoothness).
8. Update `tests/model-manager.test.ts` — the test block that toggled the flag becomes the default behavior; remove the `beforeEach` flag setter.
9. Full test run. Should be 387 + ~25 ≈ ~412 green.
10. Lint + typecheck.
11. Manual smoke:
    - Fresh tab, no localStorage tinkering needed. Load Snowdon. Confirm instancing applied (draw-call reduction visible in `renderer.info`).
    - Full smoke from previous phases — click, ctrl-click, shift-click, marquee, hide model, clip plane, inspector — all green.
    - Load → remove → reload Snowdon: heap returns to baseline.
12. PR with title `Phase 5/5 — Make instancing the default; remove experimental flag (instanced meshes)`.

**Tests:** test refactor only — no new tests, no test-count change.

**Risks:** if any user opted into the flag before Phase 5 lands, their localStorage still holds the key. Harmless — the code no longer reads it. Optional: write a one-line localStorage cleanup in Phase 5 that removes the key on first load (no breaking change either way).

---

## Tests

### Phase 1
- (extension) `createMockParsedModel` adds `geometryExpressID` field.
- (existing) all 387 tests continue to pass.

### Phase 2
- `tests/model-manager.test.ts`:
  - `experimental instancing > groups by geometryExpressID` — 5 same-geom ParsedMesh → 1 InstancedMesh with count 5.
  - `experimental instancing > singletons stay as Mesh` — 3 same-geom ParsedMesh → 3 Mesh instances sharing geometry.
  - `experimental instancing > different colors split` — same geom, two colors (3+2 split) → 1 InstancedMesh + 2 Meshes.
  - `experimental instancing > meshesByExpressId records instance refs` — entries are `{ kind: 'instance', mesh, instanceId }`.
  - `experimental instancing > instance matrices are applied in placement order` — verify `getMatrixAt(i)` equals `Matrix4.fromArray(parsedMesh[i].transform)`.
  - `experimental instancing > Uint32Array sidecar populated` — `instanceExpressIds[i] === parsed.meshes[i].expressID`.
  - `removeModel > shared geometry disposed once` — count.dispose() invocations.
  - `experimental instancing > flag off uses legacy path` — flag unset, verify all output is `kind: 'mesh'`.

### Phase 3
- `tests/inspector-selection.test.ts`:
  - `instanced highlight > setColorAt with tint on first highlight`.
  - `instanced highlight > setColorAt with identity on unhighlight`.
  - `instanced highlight > instanceColor.needsUpdate flipped to true after each write`.
  - `instanced highlight > clearInternal resets all tinted instances`.
  - `instanced highlight > onModelRemoved drops bookkeeping for removed-model instances`.
  - `identityFromHit > resolves InstancedMesh hit via sidecar` — synthetic Intersection with `instanceId`.
  - `identityFromHit > returns null for InstancedMesh hit without instanceId` — defensive.
  - `mixed scene > Mesh + InstancedMesh selection both work in one operation`.

### Phase 4
- `tests/marquee-classify.test.ts`:
  - `classifyInstancedMesh > per-instance classification` — three instances, distinct classifications.
  - `classifyInstancedMesh > respects clip planes per instance`.
  - `classifyInstancedMesh > matrixWorld stacked on instanceMatrix`.
- `tests/marquee-selector.test.ts`:
  - `instanced + Alt drag > applyMany called with right instance subset`.
  - `instanced + crossing mode > partial instances included`.

### Phase 5
- No new tests. The Phase 2-4 `experimental instancing` describe blocks have their `beforeEach` flag-setter removed; the tests now exercise the default path.

### Total added: ~25 tests. Total tests post-Phase-5: ~412.

---

## Manual smoke tests

These run **per phase** as listed above. Consolidating the full Phase-5-acceptance list:

### Correctness
1. Load RIB.ifc. Visual rendering identical to main: same colors, same opacity, same lighting. No console errors.
2. Load Snowdon Towers Sample Structural.ifc. Same.
3. Load both. Both render correctly side-by-side.
4. Click on a wall (low-instance-count element). Highlight as today (emissive blue).
5. Click on a bolt (high-instance-count element). Highlight as expected (tinted blue).
6. Click on a bolt, then click another bolt. First returns to base color; second tints.
7. Ctrl-click adds: 3 bolts and 1 wall all tinted/highlighted.
8. Shift-click removes: from a 4-element selection, shift-click one bolt → 3 left.
9. Esc clears all.
10. Click on empty canvas → clears.
11. Inspector panel shows correct `expressID`s for each click (cross-check by reading the inspector header).
12. Open the tree view, navigate to the bolt's row, confirm it matches the visually-tinted bolt.

### Marquee
13. Alt-drag left-to-right covering some bolts and walls. Only fully-enclosed elements tinted/highlighted. Inspector shows correct N elements.
14. Alt-drag right-to-left covering the same region. Includes partially-touching elements.
15. Alt+Ctrl-drag adds to existing selection.
16. Alt+Shift-drag removes.
17. Esc during drag cancels with no selection change.
18. Marquee on 17k-element Snowdon (whole model): completes in under 1 second.

### Clipping
19. Place a clip plane through a row of bolts. Click a bolt on the visible side → highlights. Click a bolt on the cut-side: ray misses (correct; `raycastVisible` filter).
20. Marquee the row: only visible-side bolts tinted.

### Visibility
21. Hide a model via the tree row. Click in that model's region: no hit (correct).
22. Marquee covers a hidden model and a visible model. Only visible elements selected.

### Performance
23. Open DevTools console. Read `viewer.getRenderer().info.render.calls` (with the temporary `__viewer` exposure described in `dev/profiling.md:83-88`). **Record this for both pre-instancing main and post-instancing main on Snowdon.** Target: post should be < 1500 vs pre ~ 17000.
24. Orbit Snowdon for 5 seconds. Subjectively smooth (no stutter). Compare to pre-instancing main. Note in PR body.
25. Performance recording (Chrome DevTools Performance tab) during orbit: no Long Tasks > 50 ms.

### Memory
26. `performance.memory.usedJSHeapSize` before load → load → after load: record delta.
27. Remove the model. Force GC. Heap returns to ± 5 MB of baseline.
28. Load → remove cycle 3 times. Heap doesn't ratchet up.

### Regression
29. All existing manual smoke flows from `phase-element-inspector.md`, `phase-marquee-selection.md`, `phase-clipping-ux-fix.md` continue to pass on Snowdon.

### Session restore (existing functionality)
30. Load Snowdon. Reload tab. Model restores. Click a bolt → highlights correctly (i.e. instancing was re-applied during the restore parse).

### Console hygiene
31. No errors, no warnings, no NaN-related noise across the entire smoke run.

---

## Risks & open questions

### R1 — `setColorAt` highlight is visually less prominent than emissive
**Severity:** medium. The current emissive glow at 0.3 intensity stands out *because it's emissive* — it lights pixels even in shadow. Albedo tint at the same color may read as "selected" only when the base material is similar enough to make the tint obvious; on a black bolt with low diffuse contribution it might look subtle.

**Mitigation:**
- Calibrate `HIGHLIGHT_INSTANCE_COLOR` during Phase 3 smoke. If the user reports it's hard to see, switch to Plan B (shader-injection emissive). Implementing Plan B is ~30 lines in `SelectionManager` via `Material.onBeforeCompile` injecting a per-instance emissive uniform / attribute.
- Reserve a Phase 3.5 mini-PR for Plan B if smoke fails.

### R2 — Instance order changes between sessions
**Severity:** low. Today, `meshesByExpressId` order is parse order. With instancing, the order within an InstancedMesh is the order of insertion from the grouping bucket — which is parse order within a (geom, color) group. The forward index from `expressId → MeshRef` still works.

But: serialized session data (`sessionStore`) holds the IFC bytes, and re-parsing on restore produces a different web-ifc internal expressID order (web-ifc is deterministic but version-sensitive). If a user copies an `expressID` from a previous session into the URL or a bookmark, it should still resolve (the expressID itself is stable per IFC text).

**No mitigation needed** — the contract is that expressID survives restore, which it already does.

### R3 — Different `mesh.material` reference vs. shared between InstancedMesh and Mesh
**Severity:** low. If one bucket has count 5 (InstancedMesh) and another bucket with the same (geom, color) somehow exists with count 2 — impossible by construction (the bucket key is exactly (geom, color)), so this can't happen.

But: if the count threshold changes mid-load (it can't — it's a constant), or if the material cache hits across different (geom, color) buckets sharing color but different geom, the Mesh and InstancedMesh might share a material. That's fine — both reference the same `MeshPhongMaterial`. Disposing it once via the existing dedup is correct.

**No mitigation needed.**

### R4 — Phase 2 with flag ON breaks selection silently
**Severity:** acknowledged. From the Phase 2 spec: with flag on, single-click on a bolt resolves to `undefined` expressID (because `identityFromHit` reads `userData.expressID` which isn't there on the InstancedMesh). The pick silently no-ops.

**Mitigation:** flag defaults to OFF. The PR body documents the limitation. Phase 3 lifts it. CI test gate: no test should turn on the flag and rely on selection to work — Phase 2 tests assert construction only.

### R5 — `instanceColor` buffer not initialized lazily on some Three.js versions
**Severity:** low. Three.js v0.183's `setColorAt` lazily allocates `instanceColor` with `.fill(1)`. Confirmed in `InstancedMesh.js:318-328`. Older Three.js versions don't `.fill(1)` — they leave the buffer at zero, which means untinted instances render black. We're on `three@^0.183`; verify in `package.json`.

**Mitigation:** Phase 3 test asserts `instanceColor.array` is all-ones after the first `setColorAt` call on a fresh InstancedMesh. If a future Three.js upgrade breaks this, the test catches it.

### R6 — `geometryExpressID` collision across schemas
**Severity:** very low. web-ifc emits expressIDs scoped to one model. We key on `geometryExpressID` within a `ModelManager.addModel` call, never across models, so collisions across different files are physically impossible.

**Mitigation:** none needed; document in code comment.

### R7 — Per-instance AABB compute overhead at marquee
**Severity:** low-medium. 17k bolts in one InstancedMesh → marquee runs 17k `getMatrixAt` + `applyMatrix4` + `intersectsBox` + (for window mode) 8× `containsPoint`. That's ~17k × ~20 floats × ~10 ops = ~3.4M FLOPs. Modern CPU does this in ~10-50 ms. Fine.

**Mitigation:** the bounding-sphere early-out (skip the whole InstancedMesh if its overall sphere is out-of-frustum) cuts this dramatically for partial-screen marquees.

### R8 — `BufferGeometry` shared between Mesh and InstancedMesh, dispose order
**Severity:** low. In v1's grouping, a unit geometry is either shared across N Meshes (count < 4) OR across 1 InstancedMesh (count ≥ 4) — never both, because each (geom, color) bucket goes to one outcome only. But two different colors with the same geom produce two materials sharing the same geometry — across an InstancedMesh and Mesh instances. Disposal needs to dedup.

**Mitigation:** the `Set<BufferGeometry>` dedup in `removeModel` (Phase 2). Test covers it.

### R9 — Highlight tint on an already-tinted instance (e.g. select, then re-select, then deselect)
**Severity:** low. The `instanceHighlights` map prevents double-tinting. Re-select is no-op. Deselect resets to identity (white).

**Mitigation:** test covers it.

### R10 — Phase ordering / merge friction
**Severity:** low. Each phase is small enough to land in days. The phases are strictly sequential — Phase 3 requires Phase 2's `MeshRef` shape; Phase 4 requires Phase 3's helpers. Each can ship to main independently (the flag stays off until Phase 5).

**Mitigation:** clear PR titles indicating phase order; the agent rebases on main between phases.

### Open questions to confirm during implementation

- **Q1: Is the unit `BufferGeometry` shared across colors safe?** If two ParsedMesh with the same `geometryExpressID` have different colors, they share one `BufferGeometry` but use two different `MeshPhongMaterial`s. Three.js handles this without issue (geometry is a pure data resource), but verify in a Phase 2 test.
- **Q2: Does `MarqueeSelector`'s clip-plane semantics need adjustment for per-instance?** No: the same `boxFullyClippedByPlane` helper works per-instance because we pass the per-instance world-space AABB.
- **Q3: Does `viewer.fitToBox` work correctly with InstancedMesh?** `Box3.setFromObject` traverses children and uses `boundingBox` on each. `InstancedMesh` exposes its overall `boundingBox` via `computeBoundingBox`. As long as we either call `instMesh.computeBoundingBox()` at construction OR trust `setFromObject` to fall back to per-instance, fit-to-view works. Verify in Phase 2 smoke.
- **Q4: Does `App.parseQueue` change?** No — instancing is post-parse, inside `ModelManager.addModel`. The parser still produces a `ParsedModel`.
- **Q5: ModelRecord persistence (commit `0e28450`) — does it care about instancing?** No — it serializes IFC bytes, not the rendered scene.

---

## Definition of done (all five phases shipped)

- [ ] **Phase 1 PR merged** — `ParsedMesh.geometryExpressID` populated by `IfcParser`.
- [ ] **Phase 2 PR merged** — `ModelManager.addModel` produces `InstancedMesh` for groups of size ≥ 4 when the `ifcviewer:experimental-instancing` flag is on. Tests cover the grouping logic. Manual smoke confirms flag-off bit-equivalent to main and flag-on draw-call reduction visible.
- [ ] **Phase 3 PR merged** — selection / highlight / unhighlight / clear all work on `InstancedMesh` via `setColorAt`. Tests cover the dispatch. Manual smoke confirms per-instance picking works.
- [ ] **Phase 4 PR merged** — marquee classifies per-instance via `classifyInstancedMesh`. Tests cover the geometry math. Manual smoke confirms marquee on instanced bolts picks the right subset.
- [ ] **Phase 5 PR merged** — flag removed; instancing is the default. `addModelLegacy` deleted. Roadmap card moved to Done. `dev/profiling.md` baseline numbers updated.
- [ ] **`renderer.info.render.calls` reduction documented in `dev/profiling.md`** — concrete before/after on Snowdon.
- [ ] **All ~412 tests pass on main.**
- [ ] **No regressions** — every manual smoke from `phase-element-inspector.md`, `phase-marquee-selection.md`, `phase-clipping-ux-fix.md` runs green on the user's 191 MB model.
- [ ] **User approves** the merged Phase 5 PR after their own smoke.

---

## Roadmap update

After Phase 5 lands, in `dev/plans/roadmap.md`, replace the existing `instanced-meshes` card (lines 94-104) by removing it from the Queued section and appending the following entry to the **Done** section at the bottom of the file:

```md
### `instanced-meshes` — Switch repeated geometry to InstancedMesh (PRs #N+1..#N+5, merged YYYY-MM-DD)
- **Outcome:** Five-phase rollout collapsed repeated geometry in loaded IFCs into `THREE.InstancedMesh` keyed on web-ifc's `placedGeom.geometryExpressID` × the existing material RGBA. Threshold `count >= 4` becomes an InstancedMesh; smaller groups stay as separate Mesh instances sharing geometry + material. Per-instance `expressID` stored as a `Uint32Array` sidecar on `userData.instanceExpressIds`; reverse index `ModelEntry.meshesByExpressId: Map<number, MeshRef[]>` (discriminated union over `{ kind: 'mesh' }` and `{ kind: 'instance', mesh, instanceId }`). Selection highlight on instances uses `setColorAt` with a desaturated brand-blue tint (`0x6a9fff`); regular Mesh highlights still use the cloned-material emissive path from PR #21. Marquee classification adds a per-instance `classifyInstancedMesh` pure function; bucket math unchanged. Phases ship behind a `localStorage` experimental flag (`ifcviewer:experimental-instancing`) until Phase 5 flips the default and deletes the legacy `addModelLegacy` path. Measured on Snowdon Towers Sample Structural.ifc (17 254 objects): per-frame draw calls dropped from ~XXX to ~YYY (-Z%). Heap delta on load: -A%. Orbit subjectively smooth; no Long Tasks > 50 ms in DevTools recording. Existing manual smoke flows (element inspector, marquee, clipping) all regression-clean. ~25 new tests across `tests/model-manager.test.ts`, `tests/inspector-selection.test.ts`, `tests/marquee-classify.test.ts`, `tests/marquee-selector.test.ts`. 387 → ~412 tests.
```

(Fill in the actual PR numbers, merge date, and measured numbers at Phase 5 time.)
