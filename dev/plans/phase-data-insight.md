# Phase — Data Insight: Speckle-style data aggregation for IFC

## North star

Let anyone who loads IFC model(s) quickly understand the data inside them —
**select, filter, colorize, and aggregate** element data — as a free,
open-source, IFC-focused alternative to Speckle's data-aggregation.

Non-negotiables (carry these into every sub-feature):
- **Intuitive UX** — calm, discoverable; contextual buttons consistent with
  the existing "Remove clipping" idiom.
- **Thorough testing** — every feature gets both automated tests and a manual
  smoke pass; no regressions to what already works.
- **Stay lightweight** — keep the simple, fast feel we have. The way we do
  that is the shared `Scope` spine below: one concept, many small consumers —
  not four tangled features.

## The spine — a shared `Scope`

Every item on the wishlist either **produces** a set of elements or
**consumes** one. So we build ONE concept, not N features.

A **`Scope`** is a set of element identities `(modelId, expressId)`.

```
SOURCES (produce a Scope)        CONSUMERS (act on a Scope)
─────────────────────────        ──────────────────────────
• whole model(s)          ──┐    ┌──► visibility  (hide / unhide / isolate)
• selection basket        ──┼──► │──► coloring     (apply a color scale)
• filter result           ──┘    └──► aggregation  (pivot → data-agg tabs)
• live click-selection (already exists, via SelectionManager)
```

Decisions baked in (user-approved):
1. **Adopt `Scope` as a first-class shared concept** — sources and consumers
   both speak `Scope`. This is what keeps the epic lightweight.
2. Build order is foundational-first; each feature ships as its own PR with
   its own hand-off-grade plan, tests, and manual smoke.

## Workspace tabs

The app becomes a **tabbed workspace** (top tab bar):

- **MODEL** tab — today's 3D viewport + model tree + inspector + tools.
  Unchanged behaviour; it just gains a tab label.
- **Data-aggregation tabs** (`DATA_AGG_1`, …) — **appear when the user
  creates an aggregation**. Each is:
  - **Renamable**, and there can be **several**.
  - Built from a **set of models** / a `Scope`.
  - **Pivot-table-style** (Excel-like rows / columns / values) — shows the
    aggregated elements plus the result tables (graphs later).
  - **Persisted in the session** alongside the loaded models.

How aggregations are *authored* (the pivot UX) is deferred to feature 6's
detailed plan — the user is aiming for "Excel pivot tables."

## Features — dependencies & build order

Each row is its own PR. Earlier rows unblock later ones.

| # | Feature | Depends on | Notes |
|---|---------|------------|-------|
| 1 | **Selection basket** | — | First `Scope` source; CRUD; the calculator M+/M−/MR/Clear feel |
| 2 | **Element visibility** (hide / unhide / isolate) | — | Prerequisite for filter; useful alone |
| 3 | **Bulk property access** | the worker | Enabler for filter + aggregation; folds the existing `bulk-property-fetch-and-cap` card |
| 4 | **Filter by parameter** | 2, 3 | Produces a filter `Scope` |
| 5 | **Parameter coloring** | a `Scope` + material override | Color scale over a scope; Naviate-style |
| 6 | **Data aggregation + tabs** | 3 + `Scope` | The capstone; sub-phased (tab infra → pivot → graphs → export) |

## Per-feature sketches

(Each gets its own hand-off doc before code — these are orientation only.)

### 1. Selection basket
A persistent, user-curated `Scope`. CRUD that feels like a calculator:
**M+** add current selection, **M−** remove, **MR** recall (select the
basket's contents), **Clear**. When the basket is non-empty a **"Clear
basket"** button shows in the contextual-action tray (same idiom as "Remove
clipping"). Basket is the canonical first `Scope`; everything downstream can
target it.

### 2. Element visibility
Hide / unhide / isolate by `Scope`. A **"Show all"** contextual button when
anything is hidden. This is the mechanism filter uses ("show matching, hide
the rest"). Reuses `ModelManager.setVisible`-style plumbing at the element
level (today it's per-model).

### 3. Bulk property access
The worker gains `getMany(ids)` plus real `enumerateExpressIds` /
`describeSchema` (currently stubbed). Reading one parameter across thousands
of elements is the core need for both filter and aggregation; the worker
keeps it off the main thread. Subsumes the queued `bulk-property-fetch-and-cap`.

### 4. Filter by parameter
From a selected element (or class), pick parameter(s) and a match → the
matching elements become a `Scope`, shown/isolated via feature 2. Needs
bulk property access (3) to evaluate the predicate across the model.

### 5. Parameter coloring
Apply a **color scale** to a chosen parameter/type across a `Scope`:
gradient for numeric values, categorical for discrete — with a **legend**.
Temporary (a view overlay, restored on clear). Reuses the highlight-variant
material mechanism `SelectionManager` already has.

### 6. Data aggregation + tabs
The capstone. Sub-phases:
- **6a — workspace-tab infrastructure**: the tab bar, MODEL ↔ data-agg view
  switching, per-tab state, session persistence of tab definitions.
- **6b — pivot aggregation**: over a `Scope` (model / basket / filter),
  group + sum / avg / count / min / max; show the contributing elements +
  result tables.
- **6c — graphs + report/export**.

## Cross-cutting

- **UX**: contextual buttons mirror "Remove clipping"; nothing modal or noisy.
- **Testing**: automated + manual per feature; the worker proxies and the
  `Scope` logic are pure/unit-testable; visual bits get manual smoke.
- **Lightweight**: reuse what exists — the contextual-action tray, the
  highlight-variant materials (coloring), the worker (bulk reads), the
  session store (tab persistence). No premature abstractions.

## What needs separate detailed planning (own hand-off doc each)

- All six features individually.
- Highest design-risk: the **pivot-aggregation authoring UX** (6b) and the
  **workspace-tab + session-persistence** model (6a).
