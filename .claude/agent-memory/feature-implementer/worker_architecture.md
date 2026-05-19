---
name: worker-architecture
description: IFC parsing + property queries run in a Web Worker — module layout and message protocol
metadata:
  type: project
---

`web-worker-parse` (PR for branch `feature/web-worker-parse`) moved ALL
web-ifc work off the main thread into a plain Web Worker.

**Why:** main-thread parsing froze the UI on large models (200MB+). A
plain worker (NOT a pthread/COI worker — no COOP/COEP headers needed)
relocates the single-threaded web-ifc work so the UI stays at 60fps.

**How to apply:** any new web-ifc-touching feature (clash, section
queries, schema enumeration) belongs in the worker, reached via a message,
not by adding a main-thread `IfcAPI` call.

**Module layout (`src/parser/`)**
- `ifcWorker.ts` — worker entry. Sole owner of the `IfcAPI`, every open
  model, the `Map<appUUID, numericModelId>`, and a serial promise-chain
  queue (`enqueue`). Handles `parse` / `openForProps` / `getProps` /
  `disposeModel` / `dispose`.
- `WorkerIfcParser.ts` — main-thread proxy, owns the `Worker`. Geometry
  path: `parseStreaming(buffer, id, onBatch)`, `openForProperties`,
  `disposeModel`, `dispose`. Also owns the single `worker.onmessage` and
  multiplexes — `setExtraMessageSink` lets `WorkerPropertyRepository`
  receive `props`/property-`error` messages over the SAME worker.
- `ifcMessages.ts` — `ToWorker` / `FromWorker` typed protocol.
- `types.ts` — `ParsedMesh` / `ParsedModel` / `StreamProgress` (shared by
  worker + main; worker-importable, no DOM deps). `ParsedModel` is just
  `{ id, meshes }` — the numeric web-ifc modelID is gone from the main
  thread entirely.
- `index.ts` — re-exports `WorkerIfcParser` + the types.

**Property path**
- `repository/fetchElementProperties.ts` — extracted pure-ish fetch+
  normalize core (the destructive-`getPropertySets` two-call merge lives
  here). Worker-importable. Takes a structural `PropertyApi`.
- `repository/WorkerPropertyRepository.ts` — `ElementPropertyRepository`
  impl; main-thread memo + `getProps` round-trip correlated by `reqId`.
- `WebIfcPropertyRepository.ts` and `IfcParser.ts` were DELETED.

**Key invariants**
- Every worker failure path MUST post an `error` reply (id- or
  reqId-correlated) or a main-thread `await` hangs forever.
- Transferables: `.ifc` buffers and mesh vertex/normal/index buffers are
  transferred (neutered) — never reuse a buffer after `postMessage`.
- The worker serializes ALL requests on its promise-chain queue; do not
  rely on main-thread serialization for web-ifc safety.
- `App` keeps a `loadChain` only to order `handleFile`'s main-thread
  bookkeeping — NOT for web-ifc safety (the worker handles that).

**Vite worker bundling** — `new Worker(new URL('./ifcWorker.ts',
import.meta.url), { type: 'module' })` makes Vite emit a separate
`ifcWorker-*.js` chunk with `web-ifc` bundled in. Confirmed by `npm run
build`. The `.wasm` is served from `public/` (copied by the `postinstall`
script); `SetWasmPath(import.meta.env.BASE_URL)` works from worker scope.
