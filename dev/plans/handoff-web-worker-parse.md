# Hand-off — `web-worker-parse`: move IFC parsing off the main thread

## TL;DR

Run web-ifc parsing in a **Web Worker**. The main thread stays at 60 fps for
the whole load; the worker streams geometry batches over and the main thread
renders them. This removes the medium-model slowdown introduced by
`progressive-scene-fill` (PR #30) **and** the frozen UI on huge models — in
one move.

Picked up after PR #30 merges. Intended as its own PR. Estimated effort:
**M–L** — the geometry side is small (it reuses PR #30's `ModelManager`
stream API); the property-inspector side is the bulk of the work.

## Why

PR #30 made big-model loads progressive by streaming on the **main thread**,
with a time-boxed yield (`FrameYielder`). That trades total speed for
responsiveness:

- It walks the model **twice** — one `StreamAllMeshes` pass for the product
  IDs, one batched `StreamMeshes` pass for geometry — because a main-thread
  loop cannot yield in the middle of a monolithic `StreamAllMeshes` call, and
  streamed geometry is only valid inside a stream callback.
- It pays per-batch scheduler / yield overhead.

Net: huge models (200 MB+) win big (a frozen minute becomes an interactive
progressive build); medium models (~48 MB, measured on `SBM_RIE.ifc`) load
**noticeably slower** than the old blocking parse. A Web Worker removes the
trade-off entirely.

## What a worker fixes — and what it doesn't

**Fixes:**
- **Main thread never blocks** → smooth 60 fps UI for the entire load.
- **Single-pass parse.** The worker is not the UI thread, so it never needs
  to yield. It runs ONE `StreamAllMeshes`, extracts geometry inside the
  callback, and `postMessage`s batches as it goes. No second pass, no yield
  overhead → faster wall-clock than PR #30's streaming, comparable to the old
  blocking `parse()`.
- Geometry crosses the boundary **zero-copy** via Transferable `ArrayBuffer`s.

**Does NOT fix:**
- **Raw parse CPU time.** Still single-threaded web-ifc, one core. A worker
  relocates the work, it does not parallelize it. True multi-core parsing is
  web-ifc's internal WASM pthreads — the `mt-wasm-coop-coep` card, which is
  **blocked** and unrelated to this.

## Critical clarifications

- **No cross-origin isolation needed.** A plain `Web Worker` requires NO
  COOP/COEP headers, no service worker, no `crossOriginIsolated`. This is
  completely separate from the failed `mt-wasm-coop-coep` (that was web-ifc's
  *internal* WASM pthreads, which do need COI). A regular worker wrapping
  single-threaded web-ifc just works, everywhere.
- **Rendering stays on the main thread.** WebGL / Three.js are
  main-thread-bound. The split is: **worker = parse**, **main = build
  `THREE.Mesh` + render**. (OffscreenCanvas could move rendering too, but
  that is a much larger, separate effort — out of scope here.)

## Architecture

```
main thread                          worker thread
-----------                          -------------
App.handleFile
  post {parse, id, buffer}   ───────► OpenModel(buffer)
                                      StreamAllMeshes(cb): extract geometry
  ModelManager.appendMeshes  ◄──────    post {batch, meshes, progress}   ×N
  (renders progressively)
                             ◄─────── post {parsed, id}

  user clicks an element
  repo.get(id, expressId)
  post {getProps, reqId}     ───────► properties.* + normalize
  InspectorPanel             ◄─────── post {props, reqId, ElementProperties}
```

The main thread **reuses PR #30's `ModelManager.beginStream / appendMeshes /
endStream` unchanged** — only the *source* of the batches changes (worker
messages instead of `parseStreaming`'s callback). That API was built
forward-compatible on purpose.

## The hard part — the property inspector

Today `WebIfcPropertyRepository` holds a web-ifc `api` reference and queries
it on the main thread. If the parsed model lives in the **worker**, the main
thread has no `api`.

**Recommended approach:** the worker owns the web-ifc model for its whole
lifetime, and property queries become messages.

- The worker runs both web-ifc AND the existing normalization
  (`propertyNormalizer`, `unitTable`, `flatRows`) — those modules are
  pure/portable. It posts back fully-normalized `ElementProperties` objects
  (structured-cloneable), so normalization is also off the main thread.
- The main thread gets a **new `ElementPropertyRepository` implementation**
  that is a thin message proxy: `get(id, expressId)` posts `{getProps,
  reqId}` and awaits the matching reply. `ElementPropertyRepository.get()` is
  already `async` (returns a `Promise`), so this fits with **no interface
  change** — only a new implementation alongside `WebIfcPropertyRepository`.

This is the bulk of the effort. The geometry path is small; the inspector
data-path is the real work.

## Message protocol (sketch)

- **Main → Worker:** `parse {id, buffer}` · `getProps {reqId, id, expressId}`
  · `closeModel {id}`
- **Worker → Main:** `batch {id, meshes, progress}` · `parsed {id}` ·
  `props {reqId, ElementProperties}` · `error {id|reqId, message}`

Transfer the `.buffer` of every typed array — the `.ifc` bytes in `parse`,
the vertices/normals/indices in `batch` — so they cross zero-copy. **After
transferring a buffer the sender must not touch it** (it is neutered).

## Files

- **NEW `src/parser/ifcWorker.ts`** — worker entry. Holds web-ifc, the open
  models, runs parse + property queries. Vite bundles it via
  `new Worker(new URL('./ifcWorker.ts', import.meta.url), { type: 'module' })`.
- **NEW `src/parser/WorkerIfcParser.ts`** — main-thread proxy: owns the
  `Worker`, exposes a `parseStreaming`-shaped API that turns worker `batch`
  messages into the same `onBatch(meshes, progress)` callback `App` already
  uses.
- **NEW `src/inspector/repository/WorkerPropertyRepository.ts`** — an
  `ElementPropertyRepository` implementation backed by worker messages.
- `src/core/App.ts` — construct the worker parser + worker-backed repository;
  model lifecycle (close / reset / dispose) becomes worker messages.
- `src/parser/IfcParser.ts` — the parse + `openForProperties` logic moves
  into the worker; the normalization modules are imported by the worker.

## Step-by-step

1. Branch off main (after PR #30 merges).
2. Stand up a trivial worker: `parse` message → `OpenModel` → post `parsed`.
   Wire `App.handleFile` to it, geometry via `appendMeshes`. Get a model on
   screen sourced from the worker.
3. Stream batches from the worker (`StreamAllMeshes`, extract, post with
   transferables). Confirm progressive fill and single-pass behaviour.
4. Move the property path: worker runs the normalization;
   `WorkerPropertyRepository` proxies `get()`. Wire the inspector.
5. Model lifecycle messages (close / reset / dispose).
6. Geometry cache: the main thread accumulates the worker's batches → still
   writes the full `ParsedMesh[]` to the IDB cache. Cache-restore hydrates
   from cache, then asks the worker to open the model for properties only.
7. Tests + manual smoke (RIB, SBM_RIE, SMB_ARK).

## Testing

- Worker message protocol — unit-test the proxy with a mock `Worker`
  (`postMessage` / `onmessage` stub).
- The worker entry itself — integration-tested via the existing real-IFC
  smoke against `RIB.ifc`.
- `WorkerPropertyRepository` — mock-Worker unit tests; the RIB property
  regression test moves to exercise the worker path.

## Risks

- **The property-path refactor is the real cost** — it touches the
  inspector's whole data path. Budget most of the effort here.
- web-ifc WASM init inside the worker — `SetWasmPath` must resolve from
  worker scope (same-origin fetch, no COI).
- Transferable ownership — a transferred buffer is neutered; never reuse one
  after `postMessage`.
- All model state lives in the worker — lifecycle (close on remove / reset /
  dispose) is now async messaging; get the teardown ordering right.
- Error propagation across the boundary — every worker failure mode needs a
  message back, or a main-thread `await` hangs forever.

## What PR #30 already did for this

- `ModelManager.beginStream / appendMeshes / endStream` — the worker version
  consumes batches through this **unchanged**.
- `StreamProgress` — the worker posts the same shape.
- `FrameYielder` — no longer needed for parsing (the worker does not yield),
  but harmless and reusable for other main-thread loops.
