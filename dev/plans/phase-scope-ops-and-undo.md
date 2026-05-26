# Phase — Scope Operations + Undo/Redo (the reversible editing layer)

## North star

Turn the viewer from "look at the model" into "**act on** the model": hide,
isolate, fade, and find-similar elements — over a shared **`Scope`** — with a
right-click menu that feels native, and **Ctrl+Z / Ctrl+Y** so every action is
safe to try. This is the interaction layer that the Data Insight phase
(`phase-data-insight.md`) sits on top of: the same `Scope` these ops produce
and consume is what later gets colored and aggregated.

Non-negotiables (carry into every sub-feature):
- **Reversible** — anything that edits the scene (selection, visibility,
  appearance, clipping, measurement) is one undoable event at the granularity
  the *user* perceives (see Undo granularity below). Camera moves are not.
- **Calm, native-feeling UX** — a real right-click menu; contextual recovery
  buttons mirroring "Remove clipping"; nothing modal.
- **Lightweight** — reuse what exists: `meshesByExpressId` (element lookup),
  the highlight-variant material trick (transparency), the contextual-action
  tray (recovery), the worker (bulk reads), the session store (persistence).

## How it relates to the `Scope` spine

`phase-data-insight.md` defined a **`Scope`** = a set of `(modelId, expressId)`.
This phase adds new **sources** and **consumers** on that spine, plus a
cross-cutting **history** that makes the consumers safe:

```
SOURCES (produce a Scope)            CONSUMERS (act on a Scope)
• selection basket   ✅ shipped      • visibility   (hide / unhide / isolate)   ← this phase
• live selection     ✅              • appearance   (transparent / opaque)       ← this phase
• select similar     ← this phase    • coloring / aggregation  (Data Insight)
                                     ─────────────────────────────────────────
CROSS-CUTTING: history (undo/redo) wraps every Scope-consuming edit + the
existing clipping & measurement tools, at user-perceived granularity.
```

## The features (each gets a hand-off doc)

| # | Feature | Hand-off doc | Depends on |
|---|---------|--------------|------------|
| A | **Bulk property access** (worker `getMany` + real `enumerateExpressIds`) | roadmap card `bulk-property-fetch-and-cap` (already detailed) | the worker |
| B | **Undo/redo core** + selection undo | `handoff-undo-redo.md` | — |
| C | **Right-click context menu** (selection-aware) | `handoff-context-menu.md` | — (debuts with D) |
| D | **Element appearance** — hide / isolate / show-all + transparent / opaque | `handoff-element-appearance.md` | B, C |
| E | **Undo/redo retrofit** — clipping + measurement | `handoff-undo-redo.md` (§ Retrofit) | B |
| F | **Select similar** — find elements with a matching parameter | `handoff-select-similar.md` | A, B |
| → | parameter-coloring, data-aggregation-tabs | `phase-data-insight.md` | A + Scope |

## Logical implementation order

Two independent **keystones** first, then the features that build on them.
Within a row, work is parallelizable.

```
                ┌─────────────────────────────────────────────┐
  PHASE 0       │  A. bulk-property-access   B. undo-redo core │   two keystones,
  (foundations) │     (data keystone)           + selection    │   independent →
                └───────┬─────────────────────────┬───────────┘   build in parallel
                        │                          │
  PHASE 1               │              ┌───────────┴───────────┐
  (reversible           │              │  C. context menu      │
   scene edits)         │              │  D. element appearance│  (born undo-aware,
                        │              │     hide → isolate     │   uses C + tray)
                        │              │     → transparency     │
                        │              └───────────┬───────────┘
  PHASE 2               │                          │
  (retrofit)            │              E. undo-redo retrofit:
                        │                 clipping + measurement
                        │                          │
  PHASE 3               └──────────► F. select similar (inline + menu)
  (data-backed source)                             │
                                                   ▼
  PHASE 4 (Data Insight) ─────► parameter-coloring · data-aggregation-tabs
```

**Why this order:**
1. **Both keystones go first and in parallel.** `bulk-property-access` (A) is
   pure worker/data work with no UI; `undo-redo core` (B) is pure
   interaction-state work. They don't touch the same files, so they can be two
   concurrent PRs. A unblocks F + coloring + aggregation; B unblocks D + E + F.
2. **Build D undo-aware from birth, not retrofit.** Once B exists, the new
   hide/transparency edits emit commands from day one — no rework. The context
   menu (C) is the surface they debut on, so C + D ship together (C first or
   same PR).
3. **Retrofit the existing tools (E) after the core proves out.** Clipping and
   measurement already work; making them reversible is additive and lower-risk
   once the `Command`/`HistoryManager` contract is settled by B + D.
4. **Select similar (F) lands once data (A) is in.** Its result is just a
   selection — already undoable via B — so it slots in cleanly.
5. **Coloring + aggregation (Data Insight) are last** and already planned; they
   consume the same `Scope` and the same bulk reads.

If we want a single shippable first slice that feels great on its own:
**B (core + selection undo) → C + D-hide/isolate**. That alone delivers
"right-click → Hide / Isolate / Show all, and Ctrl+Z to undo it" — a complete,
satisfying capability — before transparency, select-similar, or the data work.

## Cross-cutting decisions — CONFIRMED 2026-05-26 (build to these)

- **Undo granularity = one user-perceived gesture = one command:**
  - *Selection*: a whole gesture is one event — a marquee adding 1000 elements
    undoes as a single step, not 1000.
  - *Clipping*: a drag from pointer-down to pointer-up is one event (capture
    plane state at start + end); creating / removing a plane is one event each.
  - *Measurement*: a completed measurement is one event (undo removes the whole
    measurement); removing one is one event.
  - *Visibility / appearance*: each hide / isolate / fade op over a Scope is one
    event.
  - *Selection basket*: **M+ / M− / MC are undoable** (one event each) — an
    accidental clear or an over-eager bulk add is recoverable. MR (recall) is
    just a selection change, already covered by selection undo.
  - *Camera* (orbit / pan / zoom / fly-to / pivot): **never recorded.**
- **History clears on model add/remove** (U2) — safe v1; prune-only later.
- **Context menu acts only on the current selection** (CM2): right-click opens
  a menu scoped to whatever is selected and **does not read or change the
  element under the cursor** (no raycast, no select-on-right-click). To act on
  an element, select it first; to act on the basket, MR it into the selection
  first. With a basket *and* a separate live selection, the menu acts on the
  live selection. No selection (and no active recovery action) → no menu.
- **Appearance is one system, states mutually exclusive** (A4): a single
  per-element manager with one state (normal / hidden / transparent); a new op
  overrides the current one (no combined transparent+hidden). It normalizes to
  base before applying a new state, so transitions stay robust. See
  `handoff-element-appearance.md`.
- **Select similar ships in two cuts** (SS2): type/class presets first (no
  dependency on this phase), parameter value-match once bulk property access
  lands.

## Roadmap cards to add (when we commit this set)

Add to `dev/plans/roadmap.md` under the Data Insight section, statuses `queued`:
- `undo-redo` (Effort M) — core history + selection undo; source `handoff-undo-redo.md`.
- `undo-redo-retrofit` (Effort S–M, depends `undo-redo`) — clipping + measurement.
- `context-menu` (Effort M) — selection-aware right-click menu; source `handoff-context-menu.md`.
- `element-appearance` (Effort M, depends `undo-redo` + `context-menu`) —
  supersedes/expands the existing `element-visibility` card to include
  transparency + isolate + undo; source `handoff-element-appearance.md`.
- `select-similar` (Effort M, depends `bulk-property-fetch-and-cap` + `undo-redo`)
  — the inline form of the existing `filter-by-parameter` card; source
  `handoff-select-similar.md`.

Update the existing `element-visibility` and `filter-by-parameter` cards to
cross-reference `element-appearance` and `select-similar` respectively.
