# Plan — Bulk Property Access (worker `intersectProperties` / `enumerateExpressIds` / `findMatching`)

Implementation-ready plan. Branch `feature/bulk-property-access` off `main`.
Effort **M**. The **data keystone** of `phase-scope-ops-and-undo.md` and feature 3
of `phase-data-insight.md`: the worker primitives for **reducing** N elements'
properties into a single result, **enumerating** ids, and **matching** by a
single property — all off the main thread. Unblocks **select-similar (F)**
value-match, **filter-by-parameter**, **parameter-coloring**, and
**data-aggregation**, and removes the inspector's multi-select bottleneck.
Supersedes the stale roadmap card `bulk-property-fetch-and-cap` (which predates
the worker move in PR #33).

## Why the roadmap card is superseded

The card says implement `getMany` via `web-ifc.GetLines(...)` on the main thread
and "`InspectorPanel.beginMultiFetch` uses getMany". **PR #33 moved all web-ifc
work into the worker** (`src/parser/ifcWorker.ts`). web-ifc is no longer
reachable from the main thread, so every primitive here is a **worker message +
thin main-thread proxy**, exactly like the existing `getProps` path. This doc
describes that protocol.

## Core principle — reduce in the worker, return only the result

The expensive part of "show the shared properties of N selected elements" (or
"aggregate N elements") is **not** the web-ifc reads alone — it's (a) shipping N
full property records across the worker→main boundary and (b) doing the
reduction synchronously on the main thread, which blocks the render loop.

So: **whenever the consumer only needs a reduced result, the reduction runs in
the worker and only the small result crosses to main.** The worker computes the
reduction **incrementally** (one chunk at a time, keeping only the running
result), so worker memory is O(1) in N — nothing is ever fully materialized,
on either thread. Model navigation (orbit/pan/zoom) is pure main-thread + GPU
and never touches the worker, so it stays smooth at any N.

This principle covers the inspector **intersection** (now) and **aggregation**
(later, feature 6 — same pattern). `getMany` (full props to main) is
**deferred** to its first real consumer (parameter-coloring / export) — the
revised design eliminated its near-term use.

## Goal

Three reusable worker primitives, all reusing the existing single-element
pipeline (`fetchElementProperties` + per-model unit-table cache +
`propertyNormalizer`), so single and reduced reads normalize identically:

1. **`intersectProperties(ids)`** — compute the common-properties intersection
   in the worker (incremental fold) and return only the **single synthetic
   result** (shared keys; differing values flagged `varies`). The inspector
   multi-select display path.
2. **`enumerateExpressIds(modelId, ifcClass?)`** — list expressIds (one class
   or all products). Cheap; backed by web-ifc `GetLineIDsWithType`. Unblocks
   the select-similar **presets** cut and is the candidate set for value-match.
3. **`findMatching(modelId, ifcClass | null, selector, value)`** — run a
   value-match predicate **in the worker** and return only the **matching ids**
   (tiny payload). For select-similar value-match + filter-by-parameter, so a
   50k-element class never ships 50k property bags to the main thread.

`intersectProperties` and `findMatching` share ONE internal worker helper
(`readProps` over `getOne`) so there is a single normalization path.

## Architecture — one worker pipeline, several output shapes

```
                          ┌─────────────────────── worker (ifcWorker.ts) ───────────────────────┐
main thread               │  getOne(modelID, id, expressId, unitTable) ── fetchElementProperties │
─────────────             │   └ readProps(id, ids[]) reads in chunks, macrotask-yield between     │
WorkerPropertyRepository  │        │                                                              │
  .get(id)         ───────┼──getProps (unchanged) ──────────────► `props`                         │
  .intersectProperties()  ┼──intersect ─► incremental fold in-worker ─► `intersection` (+progress) │
  .findMatching()  ───────┼──findMatching ─► readProps + compare(normalized) ─► `ids` (+progress) │
  .enumerateExpressIds()  ┼──enumerateIds ─► GetLineIDsWithType ─► `ids`                           │
  .cancel(reqId)   ───────┼──cancel ─── out-of-queue flag set ───► (running job bails)            │
                          └──────────────────────────────────────────────────────────────────────┘
   (heavy reduction stays right of the line; only small results cross it)
```

### New worker messages (`src/parser/ifcMessages.ts`)

```ts
// main → worker (add to ToWorker)
| { type: 'intersect';    reqId: number; id: string; expressIds: number[] }
| { type: 'enumerateIds'; reqId: number; id: string; ifcClass?: string }
| { type: 'findMatching'; reqId: number; id: string; ifcClass: string | null;
    selector: PropertySelector; value: PropertyValue }
| { type: 'cancel';       reqId: number }   // NOT enqueued — see "Worker concurrency"

// worker → main (add to FromWorker)
| { type: 'progress';     reqId: number; done: number; total: number }
| { type: 'intersection'; reqId: number; props: ElementProperties }
| { type: 'ids';          reqId: number; ids: number[] }
```

- All request/reply pairs correlated by the existing monotonic `reqId`. Every
  failure path posts `error` with the same `reqId` (the protocol's existing
  invariant).
- `progress` is one generic message shared by `intersect` and `findMatching`
  (and future aggregate), so the UI has one progress path.
- `PropertySelector` and the value's shape are pinned in **"Selector contract"**
  below.

## Worker concurrency — strictly serial, with out-of-queue cancel

`ifcWorker.ts` deliberately runs a **single FIFO promise-chain queue**
(`queue = queue.then(work, work)`) and never yields, because web-ifc is not
re-entrant. The original A draft claimed `readProps` would "yield between
chunks so a huge read doesn't starve other worker messages" — that was wrong:
yielding inside one queued job does **not** let other queued jobs run; they're
gated behind it. So during a big `intersect`/`findMatching`, queued `getProps`
messages **are** blocked until it finishes.

The robust design accepts this and adds **cancellation** so a superseded big
job stops grinding:

- **`cancel` is handled outside the queue.** The worker's `onmessage` switch
  intercepts `cancel { reqId }` synchronously and writes `true` into a
  `cancelled: Map<reqId, boolean>` — it never calls `enqueue`.
- **Big jobs yield a macrotask between chunks** (`await new Promise(r =>
  setTimeout(r, 0))`) so the cancel message gets dispatched and they can
  observe the flag. A microtask `await` is **not** sufficient — incoming
  postMessages are delivered as tasks.
- **Between chunks, the running job checks the flag** and bails (posting no
  reply; the proxy's stale-reqId guard already drops the missing response).
  No partial result is committed.
- **Head-of-line blocking of other property reads during a bulk op is
  accepted** — the user does one bulk op at a time, and superseded ones
  self-cancel quickly when the user changes selection.
- The proxy's existing `onCrash` reject-all still covers all inflight requests,
  bulk or single.

### Throttled progress

The worker posts `progress` at most **per chunk** AND **no more than ~once per
100 ms**. A progress post is a 3-number message; at ~10/sec the cost is
negligible. The main thread only updates a text node ("Processing parameter
intersections 4 200 / 40 260"), which costs microseconds and does not stutter
the render loop. Per-element posts (the only way a counter could slow things)
are explicitly avoided. The macrotask yield required for cancel-delivery also
serves progress (one yield, both effects).

## Worker side (`ifcWorker.ts`)
- `getOne(modelID, id, expressId, unitTable)`: extracted from the existing
  `handleGetProps` body so the unit-table cache + normalization are shared. No
  second code path.
- `readProps(id, ids, reqId)`: chunk `ids` (default **CHUNK = 200**), `getOne`
  each, macrotask-yield between chunks, check the cancel flag, emit throttled
  `progress`. Shared by intersect and findMatching.
- `handleIntersect`: fold over `readProps` chunks, maintaining only the
  **running intersection** (seed with the first element's props; for each
  subsequent element drop keys whose normalized value differs, marking
  `varies`); post `intersection` with the single result. **O(1) memory in N**
  — never holds all props.
- `handleEnumerateIds`: `GetLineIDsWithType(modelID, type)` for a class; for
  "all products" iterate the product-type set (see Centralization).
- `handleFindMatching`: enumerate candidates, fold over `readProps` chunks,
  compare the selected property to `value` via `propertyNormalizer`, collect
  matching ids, post `ids`. Present-and-equal only (missing ≠ match). O(1)
  memory.

### Incremental intersect is a real refactor, not a trivial extraction

The existing `src/inspector/intersection.ts` is **pure** (good — worker-
importable, no DOM/Three deps) but it's a **batch** function that holds all N
inputs and walks `flat` rows N-wise. The worker wants an **incremental fold**
seeded by the first element and updated one element at a time. Converting
while preserving the existing semantics — `varies` sentinels, group survival
(a pset only survives if every input has it), `intersectMaterials`, and the
`Identity.`-prefixed direct-row handling — is a behavior-preserving refactor
with divergence risk.

**Mandatory regression-lock:** the fold version is tested against the existing
batch `intersectProperties` on identical inputs (the existing intersection
suite stays green and a new test asserts `fold(...inputs)` deep-equals
`batch(inputs)` over a representative property fixture).

## Main-thread proxy (`WorkerPropertyRepository.ts`)
- `intersectProperties(ids, onProgress?)`: **group ids by model**, send one
  `intersect` per model, then do the trivial final combine of the per-model
  synthetic results on main (cost = number of models, not elements). Returns
  one `ElementProperties`.
- `enumerateExpressIds(modelId, ifcClass?) → Promise<number[]>`: one `reqId`
  → `ids` reply. (Interface changes from the stubbed `AsyncIterable<number>`
  to `Promise<number[]>` — no consumer needs lazy semantics; faking an
  iterator over an array is debt.)
- `findMatching(modelId, ifcClass, selector, value, onProgress?)`: one `reqId`
  → `ids` reply.
- `cancel(modelId, expressId)` stays a no-op (it's about single `getProps`).
  A new `cancelRequest(reqId)` posts the out-of-queue `cancel` message — the
  inspector calls this when a multi-select supersedes an in-flight intersect.
- `onProgress` is driven by the generic `progress` message, keyed by `reqId`.
- The shared memo (`(modelId, expressId) → Promise<ElementProperties>`) is
  populated **only** by single `get()`. `intersect` returns the synthetic
  result and does not cache per-element — that's the O(1)-memory trade-off
  (see "Drill-down trade-off" below).

## Selector contract (for findMatching and F's "Select similar")

The selector identifies one property using the structure the inspector
**already uses** — no new identity concept enters the codebase.

```ts
interface PropertySelector { path: string }  // e.g. "Pset_WallCommon.LoadBearing" or "Identity.Tag"
// `value` on the message is the PropertyValue at that path on the source element
```

- **Path is the `PropertyFlatRow.path`** used everywhere already
  (`intersection.ts`, the Flat view, `getDistinctValuesForPath`).
- The worker, for each candidate, runs the same `getOne` normalization, finds
  the flat row whose `path` matches, and compares its `rawValue` to the
  target `value`.

### Matchable kinds (v1)

Only **`single`** and **`enumerated`** rows are matchable; F hides "⌕ Select
similar" on the other `PropertyValue` kinds where equality is ambiguous or
fragile:

- **`single`** — compare normalized scalar value (string / number / boolean).
  **`null` is excluded** (present-but-null isn't a meaningful match target).
- **`enumerated`** — set equality of `values`.
- **`quantity` is excluded in v1.** Exact float equality is fragile
  (`2.3401 ≠ 2.34`) and "select all elements with the exact same volume" is
  low-value. Reconsider with a tolerance / display-precision rule if it's
  ever actually requested.
- **`list` / `table` / `complex` / `bounded` / `material-ref` / `varies`** —
  deep equality is undefined or expensive; affordance hidden.

### Exact-path semantics

`findMatching` matches the **same flat-row path** in candidates. Cross-class
concept matching (e.g. a beam's `Pset_BeamCommon.TypeMark` and a column's
`Pset_ColumnCommon.TypeMark`) is **out of scope** for v1 — the paths differ.
F therefore **defaults the candidate set to the source element's `ifcClass`**;
"all products" is an opt-in. This is cheaper and path-consistent.

## Drill-down trade-off (option a — decided)

The current `beginMultiFetch` fetches each element via `get()`, populating the
shared memo, so clicking one element afterward is instant. Worker-side
`intersect` returns only the synthetic result, so **drill-down after a
multi-select pays one `getProps` round-trip per click** — **milliseconds**,
not seconds; the single-`get()` path still memos so the second visit is
instant.

Decided: accept this. Filter / aggregation workflows reduce in the worker
anyway and never depended on the memo, so they are unaffected.

**Back-pocket (only if it ever bites):** when `intersect` runs on a small N
(e.g. ≤ 500), the worker can opportunistically stream the per-element props
via `propsChunk` so the main-side memo fills as a side-effect. Tiny addition,
not now.

## Implementation order — risk-first phasing

The drill-down trade-off (option a — no memo populate on `intersect`) and the
incremental-intersect refactor (fold ≡ batch) are the two architectural bets
that could force a redesign mid-build. We validate both first in a minimal
vertical slice, then build the rest on the confirmed foundation.

**Phase 1 — Risk slice (its own PR, e.g. `feature/bulk-intersect-worker`).**
The smallest end-to-end that exercises both bets in production:

1. Refactor `intersection.ts` to an incremental fold + regression-lock test
   asserting `fold(...inputs)` deep-equals the existing batch
   `intersectProperties(inputs)` on representative fixtures.
2. Add the `intersect` worker message + handler (incremental fold + throttled
   `progress`; **no cancel yet** — single-bulk-op-at-a-time is fine for
   validation).
3. Add `WorkerPropertyRepository.intersectProperties` (per-model split +
   combine).
4. Switch `InspectorPanel.beginMultiFetch` to `repository.intersectProperties`.
   **The existing 1 000 cap stays in place for Phase 1** — raised in Phase 2
   once the trade-off holds.

**Phase 1 manual checkpoint:** multi-select ~500–2 000 elements with the
inspector open, then click one element to drill down. Two go/no-go criteria:

- **Drill-down latency must be in ms, not seconds.** If it's not, stop and
  pivot to the back-pocket (opportunistic `propsChunk` from `intersect` at
  small N) before building the rest.
- **Intersected display must match the previous main-thread intersection**
  for the same selection. If it diverges, the fold is wrong — fix it before
  building consumers on top.

**Phase 2 — Robustness, cap, F unblock (PR `feature/bulk-property-access`).**
Only after Phase 1 is merged and the checkpoint passes:

1. Out-of-queue `cancel` handler + cancel flag + macrotask yield in
   `readProps`; `InspectorPanel.cancelRequest` on supersede.
2. Cap policy: remove the 1 000 refusal; add the 10 000 sanity guard +
   "compute anyway".
3. `enumerateExpressIds` + interface change to `Promise<number[]>`.
4. `findMatching` (tested with a stub selector; F wires the real one).
5. Product-type constant centralized in the worker.

## Centralization

1. **`src/inspector/elementKey.ts`** — `makeKey(modelId, expressId)`. **Done**
   in `refactor/element-key` (PR #40). All five former copies (the four
   `makeKey` locals + the inline codec in `InspectorPanel.multiKey`) are gone.
2. **Shared incremental intersection reducer** — extract from
   `src/inspector/intersection.ts` into a pure module the worker imports.
   Regression-locked against the batch function (see "Incremental intersect"
   above).
3. **Product-type list** — the set of IFC classes that count as "elements"
   for `enumerateIds(all)` lives in one constant the worker owns, so
   enumerate, marquee classification, and future aggregation agree on "what
   is an element".

## Files

| File | Change |
|------|--------|
| `src/parser/ifcMessages.ts` | New `intersect` / `enumerateIds` / `findMatching` / `cancel` requests; `progress` / `intersection` / `ids` replies. |
| `src/parser/ifcWorker.ts` | Extract `getOne` from `handleGetProps`; add `readProps` (chunked + macrotask-yielding + throttled progress + cancel-flag check), `handleIntersect` (incremental fold, O(1) memory), `handleEnumerateIds`, `handleFindMatching`; out-of-queue `cancel` handler in the message switch; product-type constant. |
| `src/inspector/intersection.ts` | Refactor `intersectProperties` into an incremental fold (seed + step); export both the fold (for worker) and a thin batch wrapper preserving the existing main-thread API for any remaining callers. |
| `src/inspector/repository/ElementPropertyRepository.ts` | Add `intersectProperties(ids, onProgress?)`, `findMatching(...)`, `cancelRequest(reqId)`; change `enumerateExpressIds` to `Promise<number[]>` (drop AsyncIterable). |
| `src/inspector/repository/WorkerPropertyRepository.ts` | Implement the above (per-model intersect combine, generic progress, out-of-queue cancel post); remove the `not implemented` stubs. |
| `src/inspector/InspectorPanel.ts` | `beginMultiFetch` → one `repository.intersectProperties(identities, onProgress)` instead of `identities.map(get)` + `Promise.all` + main-thread `intersectProperties`. On supersede, call `cancelRequest`. Live "N / M" overlay; cap becomes the high sanity guard below. |

## Cap policy — confirmed: 10 000 with overlay + "compute anyway"

The cap **only** governs the inspector's multi-select property-intersection
display. It does **not** limit selecting, hiding, isolating, coloring,
`findMatching`, or aggregation; those act on ids or reduce in the worker and
are effectively unbounded.

- Replace the hard `MULTI_SELECT_SOFT_CAP = 1000` refusal with a **live "N / M"
  progress overlay** and process the whole selection.
- Keep a **sanity guard at 10 000** — above it, offer a one-click "compute
  anyway" rather than a refusal. Below the guard the result feels fast and
  navigation is unaffected; above it the user opts in.
- Read the guard from a central constant so the future `settings-panel` can
  expose / raise / disable it.
- Aggregation is **not** governed by this cap (separate worker-reduce path).

## Out of scope (defer — avoid premature abstraction)

- **`getMany(ids)` (full props to main)** — no near-term consumer:
  `intersect`/`findMatching` reduce in the worker, F gets ids back from
  `findMatching`, not props. Defer until parameter-coloring / export needs
  it; that feature owns the design.
- **`describeSchema`** (class counts / schema summary) — leave stubbed; it
  serves the filter panel / aggregation UIs, not select-similar. Scope it
  with feature 4/6, not here.
- **Worker-side aggregation** (group + sum/avg/count) — same reduce-in-worker
  pattern, belongs to `data-aggregation-tabs` (feature 6). This doc only
  establishes the pattern + the shared `readProps` it will reuse.
- The filter-expression UI, multi-criteria predicates, cross-model
  value-match — later cards. `findMatching` here is single-selector,
  present-and-equal, within one model, default-scoped to the source class.

## Edge cases

- **Memory** — `intersect` / `findMatching` keep only a running result (O(1)
  in N). Nothing is fully materialized.
- **Cross-model selection** — `intersectProperties` groups ids by model,
  reduces each in its worker model, and combines the few per-model results
  on main.
- **Stale requests** — the inspector calls `cancelRequest(reqId)` on
  supersede; the worker bails between chunks and posts nothing; the proxy's
  stale-reqId guard drops any in-flight reply that arrives anyway.
- **Head-of-line blocking** — bulk ops block other property reads while
  running; superseded ones cancel within one chunk so the queue frees
  quickly. Acceptable trade for one-bulk-op-at-a-time UX.
- **Drill-down after multi-select** — one `getProps` per click (milliseconds);
  second visit is memoized by the single-`get()` memo.
- **`findMatching` with no/`varies`/null value** — present-and-equal only;
  element lacking the path is not a match; null on the source row hides the
  affordance (F).
- **Huge match sets** — `findMatching` returns ids only; the resulting
  selection rides the O(N) marquee/`selectExactly` path (PR #21).
- **Model disposed mid-request** — `disposeModel` already clears memo + tells
  the worker to close; in-flight request rejects via the unknown-modelId
  error path.
- **Worker crash mid-stream** — `onCrash` rejects all inflight (existing).

## Test plan

**Automated** (mock web-ifc in worker tests; mock the worker in proxy tests):
- `enumerateExpressIds` lists a class's ids (mock `GetLineIDsWithType`);
  "all" covers the product-type set; empty class → empty.
- **`intersectProperties` fold ≡ batch** — regression-lock: the new fold
  yields deep-equal output to the existing `intersection.ts` batch function
  on representative inputs; the existing intersection suite stays green.
- `intersectProperties` cross-model ids combine correctly via the proxy.
- `findMatching`: selector `X == V` yields the right id set; missing-value
  elements excluded; comparison uses `propertyNormalizer` (label vs number);
  unmatchable kinds (`list`, `complex`, `quantity`, etc.) are rejected by F
  (panel test) but the worker handles them as "no match" if asked.
- **Cancel**: a `cancel(reqId)` posted mid-job aborts within one chunk; no
  `intersection`/`ids` reply; throughput resumes; cancelling an already-
  finished or unknown reqId is harmless.
- **Progress throttling**: a `readProps` over many chunks posts `progress`
  per-chunk-but-throttled (assert: not per-element; monotonic `done`; final
  `done === total` on completion).
- `getOne` extraction: single `getProps` behaviour unchanged (existing
  inspector tests stay green).
- `beginMultiFetch`: uses `intersectProperties` (one reduced result, not N
  fetches + main diff); overlay shows N/M; the 10k guard renders "compute
  anyway" not a refusal; stale guard holds via `cancelRequest`.

**Manual smoke**:
1. Multi-select ~2 000 elements with the inspector open → shared properties
   resolve with a live "Processing … N / M" overlay; **orbit/pan the model
   during processing — navigation stays smooth**.
2. Multi-select 30 000 → progress climbs, nav smooth; above the 10k guard
   you get "compute anyway", not a wall. While processing, queued
   single-clicks pause (expected).
3. Rapid selection changes mid-process: each new selection should cancel the
   previous within ~one chunk; UI doesn't pile up jobs.
4. After a 5 000-element intersection, click one element → properties appear
   in **ms** (single `getProps`). Re-click → instant (memo).
5. (With F wired) `findMatching` over a same-class candidate set → matching
   selection appears, worker responsive, only ids cross the boundary.

## Open decisions

- **BP1 — chunk size.** Recommend **200** ids/chunk; tune against the 191 MB
  model. The only remaining knob.

## Confirmed (build to these)

- **Worker-based, not main-thread** — every primitive is a worker message +
  proxy (web-ifc lives in the worker since PR #33).
- **Reduce in the worker, return only the result** — intersection (now) and
  aggregation (later) fold incrementally in the worker (O(1) memory) and
  ship only the small result; the main thread stays free.
- **Strict-FIFO worker + out-of-queue cancel + macrotask yield** — bulk ops
  block other property reads while running but cancel within one chunk on
  supersede. Documented, not pretended away.
- **One normalization pipeline** — `getProps` / `intersect` / `findMatching`
  all flow through `getOne` / `readProps` + unit-table cache +
  `propertyNormalizer`. No second path.
- **Shared intersection reducer** — one pure incremental fold used by the
  worker, regression-locked against the existing batch function so semantics
  cannot drift.
- **Predicate runs in the worker** (`findMatching` returns ids) — matches
  `handoff-select-similar.md`.
- **Selector = `PropertyFlatRow.path`** with matchable kinds **single +
  enumerated** (null excluded; quantity excluded in v1); **exact-path**
  semantics; **default candidate set = source element's `ifcClass`**.
- **`enumerateExpressIds` → `Promise<number[]>`** — drop the stubbed
  AsyncIterable, no consumer needs laziness.
- **`getMany` deferred** — no near-term consumer in this phase. Owned by
  parameter-coloring (the feature that first needs full props on main).
- **Throttled progress** — one generic `progress` message, per-chunk and
  ~10/sec, never per element — so the live counter is free.
- **Drill-down trade-off: option (a)** — `intersect` does not populate the
  memo; drill-down pays one `getProps` round-trip (ms). Filter / aggregation
  unaffected (they're worker-reduce). Back-pocket: opportunistic
  `propsChunk` from `intersect` at small N if it ever bites.
- **Cap = 10 000 with overlay + "compute anyway"** — central constant; only
  governs the inspector intersection display.
- **`elementKey` codec centralized** — done in `refactor/element-key`
  (PR #40); five former copies removed.
