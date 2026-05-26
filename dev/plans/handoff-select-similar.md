# Plan — Select Similar (find elements by a matching parameter)

Implementation-ready plan. Branch `feature/select-similar` off `main`. Effort
**M**. A `Scope` *source* of `phase-scope-ops-and-undo.md` and the inline,
lowest-friction form of the Data Insight `filter-by-parameter` card. From one
element, "select everything with a similar value" — the result is a normal
selection that can then be basketed, hidden, faded, colored, or aggregated.

## Goal

Looking at a beam whose `Type Mark = B12`, one click selects **all** `B12`
beams. No filter-expression authoring; the parameter you're already looking at
*is* the query.

## Dependencies — split in two (SS2, confirmed)

This feature ships in two cuts with different prerequisites:

1. **Type / class presets — no new dependency.** "Select all of the same IFC
   type" / "same class" only needs the type code + class, which are already on
   the element identity / cheap to enumerate. This cut can land **early**
   (alongside the context menu / appearance work) as extra functionality.
2. **Parameter value-match — depends on bulk property access.** Evaluating
   "param == value" across a model means reading that parameter for every
   element: the **`bulk-property-fetch-and-cap`** card (the worker's
   `getMany(ids)` + real `enumerateExpressIds` / `describeSchema`, currently
   stubbed). The value-match cut **cannot ship before that lands** — and the
   same work also unblocks `parameter-coloring` + `data-aggregation-tabs`, so it
   pays for three features at once.

## "Similar" — what it means (v1)

- **Exact value match of one parameter** (the default): selected element's
  parameter X has value V → select all elements where X == V.
- **Quick presets** offered alongside: **same IFC type** (`ifcTypeCode`) and
  **same class** (`ifcClass`) — these don't even need bulk *property* reads
  (the type/class is already on the identity / cheap to enumerate), so they can
  ship as a lightweight first cut even before full bulk property access.
- Multi-criteria / ranges / operators (`>`, `contains`) → the heavier
  **filter panel**, deferred to a later card (`filter-by-parameter` proper).

## UX — inline in the inspector (recommended)

The inspector already lists a selected element's parameters. Give each property
row a hover affordance **"⌕ Select similar"** → selects all elements whose value
for that parameter equals this row's value. Mirrored as a **"Select similar ▸"**
submenu in the right-click context menu (`handoff-context-menu.md`), listing the
element's parameters (+ the type/class presets).

Only meaningful for a **single-element selection** (a multi-selection has no
single "this value"); greyed/hidden otherwise. In the context menu it follows
CM2 — it acts on the current selection, so "Select similar" appears only when
exactly one element is selected.

## Mechanism

1. User picks parameter X (value V) on the selected element.
2. App asks the worker to evaluate the predicate across the model:
   `enumerateExpressIds(modelId)` → `getMany(ids)` → filter where `X == V`
   (the predicate runs in the worker to keep it off the main thread; for large
   models stream results / show "Finding matches… N / M").
3. The matching ids become a selection via `SelectionManager.selectExactly`
   (lock-bypassing — matches may span the model; one selection, one undo step).
4. From there the result flows into everything else: M+ to basket, Hide/Isolate,
   transparency, coloring, aggregation.

## Files

| File | Change |
|------|--------|
| `src/inspector/repository/WorkerPropertyRepository.ts` + `src/parser/ifcWorker.ts` | `getMany` / real `enumerateExpressIds` (the bulk-access card). |
| `src/parser/ifcMessages.ts` | Worker messages for bulk fetch / enumerate. |
| `src/inspector/panel/renderFlat.ts` / `renderTree.ts` | Per-row "⌕ Select similar" affordance. |
| `src/ui/ContextMenu.ts` (consumer) | "Select similar ▸" submenu of parameters + presets. |
| `src/core/App.ts` | Run the predicate (worker), drive `selectExactly` with the result, progress UI for big models. |

## Edge cases

- **Huge match sets** (e.g. "all `IfcReinforcingBar`") → reuse the marquee/
  bulk selection path (already O(N) after PR #21) + a progress overlay; respect
  any selection soft-cap and the settings the user wanted tunable.
- **`varies` / missing values** → an element lacking parameter X is not a match;
  define "match null == null" as **no** (only present-and-equal matches).
- **Value typing** → compare normalized values (the repository already
  normalizes measure-wrapped numerics vs enums/labels — reuse
  `propertyNormalizer`), so `B12` (label) and `12` (number) compare correctly
  within their own types.
- **Cross-model** → v1 evaluates within the selected element's model; "across
  all loaded models" is a later toggle.
- **Undo** → the resulting selection is one command (via `handoff-undo-redo.md`).

## Test plan

**Automated**:
- Worker bulk fetch + enumerate (mock web-ifc): `getMany` returns properties for
  a batch in one round trip; `enumerateExpressIds` lists products.
- Predicate match: given a stub property set, "X == V" yields the right id set;
  presets (same type / same class) yield the right sets; missing-value elements
  excluded.
- Wire-up: selecting "similar" drives `selectExactly` with the match set (mock
  SelectionManager); single-element-only gating (hidden for multi-select).

**Manual smoke**:
1. Select a beam → inspector row `Type Mark = B12` → "⌕ Select similar" →
   all B12s selected; count matches expectation; one Ctrl+Z deselects.
2. Context-menu "Select similar ▸ → IFC type" → all same-type elements.
3. Run on a large class on a big model → progress shown, UI stays responsive.
4. Result → M+ to basket / Hide others — flows into the rest of the toolset.

## Open decisions

- **SS1 — entry point**: inline inspector affordance vs dedicated filter panel.
  Recommend **inline first**; filter panel as a later card.
- **SS3 — scope**: within the element's model (v1) vs all loaded models.
  Recommend within-model for v1.

## Confirmed (build to this)

- **SS2 — two cuts.** Ship the **type / class presets first** (no dependency on
  what we're building now — pure extra functionality), and the **parameter
  value-match** once bulk property access lands. See Dependencies above.
