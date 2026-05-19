# Plan — `web-worker-parse`: move IFC parsing off the main thread

Implementation-ready plan. Pick up as its own PR, branched off `main`.
Estimated effort **M–L** — the geometry side is small; the property
inspector side is the bulk.

## TL;DR

Run web-ifc in a **Web Worker**. The worker owns every web-ifc model and
runs all parsing and property queries; the main thread renders. The main
thread never blocks — smooth 60 fps for the whole load — and the parse is
**single-pass** (faster than `progressive-scene-fill`'s reverted
main-thread streaming, comparable to the old blocking `parse()`).

## Why

The reverted `progressive-scene-fill` streamed on the main thread. To
yield, it had to walk the model **twice** (one `StreamAllMeshes` pass for
the product IDs, one `StreamMeshes` pass for geometry) and pay per-batch
scheduler overhead — which made medium models (~48 MB `SBM_RIE.ifc`) load
slower than the old blocking parse. A worker removes the trade entirely:
it is not the UI thread, so it never yields — it does ONE `StreamAllMeshes`
pass, extracts geometry inside the callback, and `postMessage`s batches as
it goes.

## What it fixes — and what it doesn't

**Fixes:** main thread never blocks; single-pass parse; geometry crosses
zero-copy via Transferable `ArrayBuffer`s.

**Does NOT fix:** raw parse CPU time — still single-threaded web-ifc, one
core. A worker *relocates* the work, it does not parallelize it. True
multi-core parsing is web-ifc's internal WASM pthreads (`mt-wasm-coop-coep`,
**blocked**, unrelated).

## Critical clarification — this is NOT `mt-wasm`

A plain `Web Worker` needs **no COOP/COEP headers, no service worker, no
`crossOriginIsolated`**. That is completely separate from the failed
`mt-wasm-coop-coep` (web-ifc's *internal* pthreads, which do need COI). A
regular worker wrapping single-threaded web-ifc just works, everywhere.

Rendering stays on the main thread (WebGL / Three.js are main-thread-bound).
The split is: **worker = parse + property queries**, **main = build
`THREE.Mesh` + render + UI**.

## De-risk — web-ifc in a worker is VERIFIED (source-level)

Checked `node_modules/web-ifc/web-ifc-api.js`:
- It defines `ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope` and
  branches on it — the browser build is **worker-aware by design**.
- The only bare `document`/`window` uses are: `window.prompt` in Emscripten
  stdin paths (never hit by parsing), and `document.currentScript` in the
  **MT** build path (`require_web_ifc_mt`) — never reached by a plain
  worker, where `self.crossOriginIsolated` is `false` so `Init()`
  auto-selects the single-threaded build.
- `package.json` `module: ./web-ifc-api.js` — Vite bundles the browser ESM
  build into the worker chunk.

Remaining unknown is small and is **Step 1** below: confirm Vite bundles
the module worker and `IfcAPI.Init()` + the `.wasm` fetch succeed from
worker scope. Low risk — standard Vite worker support; the `.wasm` fetch is
a same-origin HTTP request.

## Architecture

```
main thread                              worker thread (ifcWorker.ts)
-----------                              ----------------------------
WorkerIfcParser.parseStreaming(buf,id)
  post {type:parse, id, buffer}  ───────► OpenModel → models.set(id, numId)
                                          StreamAllMeshes(cb):
                                            extract geometry
  ModelManager.appendMeshes      ◄──────     post {type:batch, id, meshes,
  (renders progressively)                          progress}              ×N
                                 ◄──────── post {type:parsed, id}

WorkerPropertyRepository.get(id,eid)
  memo hit? → return
  post {type:getProps, reqId,...} ───────► fetchElementProperties(...)
  InspectorPanel ◄──────────────────────── post {type:props, reqId,
                                                  ElementProperties}
```

The main thread **reuses `ModelManager.beginStream / appendMeshes /
endStream` and the `StreamProgress` type unchanged** — only the *source*
of the batches changes (worker messages instead of a callback).

## Design decisions (review these before implementing)

1. **The worker is the single owner of all web-ifc state.** It holds the
   `IfcAPI` instance, every open model, and its own `Map<appId, numericId>`.
   The main thread never sees a numeric web-ifc modelID — it uses the
   app-UUID `id` in every message. *(Alternative — keep the model on the
   main thread for properties, worker only for geometry — does not unfreeze
   the property path; rejected.)*

2. **The worker serializes all requests on an internal promise-chain
   queue** (mirrors today's `App.parseQueue`). web-ifc is not thread-safe;
   one request completes fully before the next starts. This **replaces both
   `App.parseQueue` and `WebIfcPropertyRepository`'s `enqueue`** — parses
   and property queries serialize naturally in the worker.

3. **`App.parseQueue` and `App.modelIdMap` are deleted.** Serialization
   moves into the worker (decision 2); the numeric modelID lives in the
   worker (decision 1). `App.closeWebIfcModel` becomes a `closeModel`
   message; the `getModelIdMap()` test hook is removed.

4. **The property fetch+normalize core is extracted to a shared,
   worker-importable module** — see next section. `WebIfcPropertyRepository`
   is deleted; `App` uses the new `WorkerPropertyRepository`.

5. **Memoization stays on the main thread** (in `WorkerPropertyRepository`)
   so repeated clicks never round-trip. The per-model **unit-table cache
   stays in the worker** (it is part of the fetch core).

## The property path (the hard part)

Today `WebIfcPropertyRepository.fetch` does: `getItemProperties` +
`fetchPropertyGroups` (the destructive-`getPropertySets` two-call merge) +
`getMaterialsProperties` + `getUnitTable`, then normalizes via
`propertyNormalizer` / `unitTable` / `flatRows`. All of that must run where
web-ifc lives — the worker.

**Extract the core.** Move `fetch`, `fetchPropertyGroups`,
`buildPsetAndQtoGroups`, and the unit-table logic out of
`WebIfcPropertyRepository` into a pure-ish module, e.g.:

```ts
// src/inspector/repository/fetchElementProperties.ts
export async function fetchElementProperties(
  api: PropertyApi,
  webIfcId: number,
  modelId: string,
  expressId: number,
  unitTable: UnitTable,
): Promise<ElementProperties>
```

- The **worker** imports this + `propertyNormalizer` / `unitTable` /
  `flatRows` / `format` (all pure, portable) and calls it on a `getProps`
  message. It posts back the `ElementProperties` — a plain
  object/array/primitive tree, so it is structured-cloneable.
- `WebIfcPropertyRepository` is **deleted** (App's only consumer moves to
  `WorkerPropertyRepository`). The `PropertyApi` / unit-table types stay
  (the extracted core and the worker use them).

**`WorkerPropertyRepository implements ElementPropertyRepository`** (new,
main thread):
- `get(id, expressId)` — check the main-thread memo
  (`Map<modelId, Map<expressId, Promise<ElementProperties>>>`); on miss,
  post `getProps {reqId, id, expressId}`, await the matching `props` reply,
  store the promise in the memo.
- `disposeModel(id)` — clear the main-thread memo for `id` **and** post
  `disposeModel {id}` so the worker frees its unit-table cache.
- `cancel` — no-op (unchanged from today).
- `enumerateExpressIds` / `describeSchema` — still throw "not implemented"
  (unchanged).
- No `enqueue`, no `resolveModelId` — the worker serializes and owns the
  numeric IDs.

## Message protocol (precise)

Every request carries a correlation key — the model `id` for model-scoped
ops, or a monotonic `reqId` for property queries. **Every failure path must
post an `error` reply**, or a main-thread `await` hangs forever.

```ts
// main → worker
type ToWorker =
  | { type: 'parse';      id: string; buffer: ArrayBuffer }   // buffer transferred
  | { type: 'openForProps'; id: string; buffer: ArrayBuffer } // buffer transferred; cache-restore path
  | { type: 'getProps';   reqId: number; id: string; expressId: number }
  | { type: 'disposeModel'; id: string }                      // CloseModel + free caches
  | { type: 'dispose' };                                      // Dispose all; precedes worker.terminate()

// worker → main
type FromWorker =
  | { type: 'batch';  id: string; meshes: CachedMesh[]; progress: StreamProgress } // mesh buffers transferred
  | { type: 'parsed'; id: string }                            // also resolves openForProps
  | { type: 'props';  reqId: number; props: ElementProperties }
  | { type: 'error';  id?: string; reqId?: number; message: string };
```

- Transfer the `.buffer` of every typed array — the `.ifc` bytes in
  `parse`/`openForProps`, the vertices/normals/indices in `batch`. **After
  transferring a buffer the sender must not touch it** (it is neutered).
- `meshes` in `batch` carries the geometry as transfer-friendly typed
  arrays (the existing `ParsedMesh` shape works; reuse it).

## App-level changes

- **`handleFile`** — `parser.parse` → `workerParser.parseStreaming(buffer,
  id, onBatch)`. `onBatch` feeds `ModelManager.appendMeshes` (as
  `progressive-scene-fill` did). `parseStreaming` still resolves with the
  full `ParsedModel` (accumulate the batches) so `geometryCache.save(hash,
  parsed.meshes)` is unchanged. Drop the `modelIdMap.set` line.
- **`restoreSession`, cache hit** — `addModel(cachedMeshes)` stays instant;
  then post `openForProps {id, buffer}`. The old `scheduleBackgroundReparse`
  + `modelID: -1` placeholder + `disposeModel` dance is **deleted** — a
  later `getProps` for that `id` simply queues behind `openForProps` in the
  worker and resolves once the model is open. The "properties unavailable"
  gap is handled by message ordering, for free.
- **`restoreSession`, cache miss / v1 fallback** — `parser.parse` →
  `workerParser.parseStreaming`.
- **`resetView`** — replace each `closeWebIfcModel` + `parser.parse` with a
  `disposeModel` message + `parseStreaming`. Keep the existing
  teardown/rebuild structure.
- **`removeModel`** — `closeWebIfcModel(id)` → `disposeModel` message;
  `propertyRepository.disposeModel(id)` already posts that message, so call
  one or the other (not both).
- **`dispose`** — post `dispose`, then `worker.terminate()`.

## Files

| File | Change |
|------|--------|
| `src/parser/ifcWorker.ts` | NEW — worker entry. Holds `IfcAPI` + open models + the serial queue. Handles `parse` / `openForProps` / `getProps` / `disposeModel` / `dispose`. |
| `src/parser/WorkerIfcParser.ts` | NEW — main-thread proxy. Owns the `Worker`; `parseStreaming(buffer, id, onBatch)` returning `Promise<ParsedModel>`. |
| `src/parser/ifcMessages.ts` | NEW — the `ToWorker` / `FromWorker` message types, shared by worker + proxies. |
| `src/parser/types.ts` | NEW — move `ParsedMesh` / `ParsedModel` / `StreamProgress` here (shared by worker + main; `IfcParser.ts` is deleted). |
| `src/inspector/repository/fetchElementProperties.ts` | NEW — extracted property fetch+normalize core. |
| `src/inspector/repository/WorkerPropertyRepository.ts` | NEW — `ElementPropertyRepository` impl backed by worker messages. |
| `src/parser/IfcParser.ts` | DELETE — parse logic → `ifcWorker.ts`; types → `types.ts`. |
| `src/inspector/repository/WebIfcPropertyRepository.ts` | DELETE — core → `fetchElementProperties.ts`; App → `WorkerPropertyRepository`. |
| `src/core/App.ts` | Use `WorkerIfcParser` + `WorkerPropertyRepository`; delete `parseQueue`, `modelIdMap`, `closeWebIfcModel`, `scheduleBackgroundReparse`, `getModelIdMap`. |

`propertyNormalizer` / `unitTable` / `flatRows` / `format` are unchanged
(pure) and imported by the worker. `flatRows.displayStringForValue` is also
imported by `InspectorPanel` — fine, shared pure code bundled into both.

## Step-by-step (test-first)

1. **Step 1 — integration spike.** Vite-bundle a trivial module worker
   that imports `web-ifc`, calls `Init()`, `OpenModel` on `RIB.ifc`, posts
   back the mesh count. Confirm it runs in the browser and the `.wasm`
   loads from worker scope. **Stop and reassess if this fails.**
2. Message types (`ifcMessages.ts`) + shared `types.ts`.
3. Geometry path: `ifcWorker.ts` `parse` handler (single-pass
   `StreamAllMeshes`, post `batch`es) + `WorkerIfcParser`. Wire
   `App.handleFile`. Model on screen, sourced from the worker.
4. Extract `fetchElementProperties.ts`; re-point the RIB property
   regression test at it (verify the two-call-merge still holds).
5. Property path: worker `getProps` / `openForProps` / `disposeModel`
   handlers + the serial queue + `WorkerPropertyRepository`. Wire the
   inspector.
6. App lifecycle: `restoreSession` (both paths), `resetView`, `removeModel`,
   `dispose`. Delete `IfcParser` / `WebIfcPropertyRepository` /
   `parseQueue` / `modelIdMap`.
7. Full suite + lint + typecheck; manual smoke (RIB, SBM_RIE, SMB_ARK).

## Testing

- `WorkerIfcParser` / `WorkerPropertyRepository` — unit-test with a mock
  `Worker` (`postMessage` / `onmessage` stub). Cover: request/reply
  correlation by `reqId`; **error replies reject the right promise**; memo
  hits skip the round-trip.
- `fetchElementProperties` — test directly with a real `IfcAPI` against
  `RIB.ifc`; this is where the existing RIB property regression test moves
  (it still guards the destructive-`getPropertySets` two-call merge).
- `buildFlatRows` test — unchanged (pure).
- `ifcWorker.ts` itself — integration-smoke via the manual test; a real
  worker is awkward to unit-test.
- Audit `inspector-parser-lifetime.test.ts` and `inspector-repository.test.ts`
  — re-point or remove the parts that construct `WebIfcPropertyRepository`
  / `IfcParser` directly.

## Risks

- **Property-path refactor is the real cost** — budget most of the effort
  on Steps 4–6.
- Error propagation across the boundary — every worker failure mode must
  post `error`, or a main-thread `await` hangs. Enforce in code review.
- Transferable ownership — a transferred buffer is neutered; never reuse
  one after `postMessage`.
- Worker-side serialization — do not let an `await` inside a handler
  interleave the next message; use the explicit promise-chain queue.
- `worker.terminate()` ordering on `dispose` — drain or abandon in-flight
  requests cleanly.

## What `progressive-scene-fill` (closed PR #30) left ready

- `ModelManager.beginStream / appendMeshes / endStream` — the worker
  version consumes batches through this **unchanged**.
- `StreamProgress` — the worker posts the same shape.
- The closed `feature/progressive-scene-fill` branch has a working
  reference for the geometry-extraction loop and the `App.handleFile`
  streaming wiring.
