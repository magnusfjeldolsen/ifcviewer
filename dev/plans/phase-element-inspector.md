# Phase — Element Properties Inspector

## TL;DR

Add a left-click element selection mechanism and a properties inspector panel (bottom-left, above the cookie banner) that surfaces a picked element's IFC properties. The user toggles between two views via icon buttons (Dalux-style):
- **Tree** — native nested structure grouped by Pset / Qto / Materials, each group showing its row count.
- **Flat** — alphabetically sorted `path | value | unit` rows with a substring filter.

A pill in the header shows the element's **total property count** at a glance. Properties are fetched on demand from web-ifc via the `IfcAPI.properties` helper.

Selection supports multi-pick: `click` = replace, `ctrl+click` = add, `shift+click` = remove. Multi-selection shows only properties common to all selected elements; differing values render as *varies* in italic. An optional "single-model selection" checkbox locks multi-pick to one model at a time.

**End goal:** users can inspect any element's psets, quantities, type-inherited properties, materials, and direct attributes — and the underlying flat-row representation becomes the substrate for future filtering, data aggregation, calculated fields (e.g. cost-per-length), and `.ifcproject` serialization of saved inspections.

---

## Goal

When a user left-clicks any visible element in the viewer:
1. The clicked element is highlighted in blue.
2. A panel appears at bottom-left (above the cookie banner) showing the element's identity (Name, GlobalId, IfcClass, Tag) in its header.
3. The panel body offers two views, switched via an **icon toggle** in the panel header (Dalux pattern: a tree icon and a list icon side by side; clicking sets the active view). A pill on the left of the toggle shows the element's total property count.
   - **Tree** — psets, qtos, type-inherited properties, materials, and direct attributes grouped by source. Each group shows its row count.
   - **Flat** — every leaf property as a `path | value | unit` row, alphabetically sorted, with a substring filter input.
4. Multi-select via `ctrl+click` / `shift+click` shows the **intersection** of common property keys; values that differ across the selection display as *varies* (italic).
5. `Esc` clears the selection. Clicking empty space clears it.

---

## Background & Motivation

Today the viewer can render and persist models but exposes nothing about the elements inside them. Users routinely need to answer: "what's the load-bearing rating of this wall?" / "what's the manufacturer of that door?" — questions answered by IFC psets and qtos.

A properties inspector is also a prerequisite for the larger workflows the user has signaled:
- **Filter** on similar elements (re-use the flat-row substrate).
- **Data aggregation** with count / sum / average over filtered subsets.
- **User-defined calculated fields** (e.g. `cost = price_per_unit × Qto.NetVolume`).
- **Serialization** of saved inspections / filters / aggregations into the `.ifcproject` manifest.

The data model in this plan is shaped so those follow-up features plug in without re-architecting.

---

## Key technical findings (from research)

1. **Engine:** browser-only stack means **web-ifc** (WASM), not IfcOpenShell. All retrieval goes through `IfcAPI.properties` (`getItemProperties`, `getPropertySets`, `getMaterialsProperties`). All methods are async, per-element.

2. **Blocker:** `IfcParser.parse()` calls `CloseModel(modelID)` after geometry extraction (`src/parser/IfcParser.ts:82`). Once closed, **no property queries work**. Fix: keep the model open after parse; `App.removeModel` and `App.resetView` own `CloseModel`. `IfcParser.parse` returns `{ id, modelID, meshes }` so `App` can route the web-ifc modelID into the property repository.

3. **Selection plumbing already exists:** `src/utils/raycast.ts` returns the hit mesh; `mesh.userData.expressID` and `mesh.parent.name` (the model app UUID) give us a `(modelId, expressId)` pair for free.

4. **One element → multiple meshes:** an `IfcProduct` with multiple geometries produces multiple `THREE.Mesh` objects sharing the same `expressID`. Highlight must apply to all of them.

5. **No batch API:** `properties.*` methods are per-element. A pick triggers 3 parallel awaits (`getItemProperties`, `getPropertySets`, `getMaterialsProperties`). Typical cost: 30–200 ms on a mid-size model.

---

## Confirmed scope decisions

| Decision | Choice |
|----------|--------|
| IFC engine | web-ifc (only browser-compatible option) |
| Model lifetime | Keep open after parse; close on model remove / reset |
| Selection mechanism | Always-on default behavior, not a registered Tool |
| Visual highlight | Emissive material clone (`emissive: 0x3b82f6`) — same blue as the brand accent |
| Panel placement | Bottom-left, above cookie banner; independent absolute positioning, collapsible |
| Identity attributes | Show in **both** panel header **and** dedicated "Identity" section in Tree view |
| View switching | Icon toggle (Dalux pattern), not tabs. Tree icon + list icon side by side; active state highlighted. |
| Total property count | Pill in header next to the toggle (`63 properties`) |
| Type-level psets | Inline merge with "from type" badge; overridden rows marked |
| Unit display | Separate **third column** in Flat view (and tagged in Tree) — raw numeric value preserved for aggregation |
| Multi-select modifiers | `click` = replace; `ctrl+click` = add (toggle when already selected); `shift+click` = remove |
| Multi-select from empty | `ctrl+click` works as initial pick; `shift+click` from empty = no-op |
| Multi-select scope | Optional "single-model selection" checkbox in panel header (default behavior to be decided — see open questions); ESC always clears all |
| Intersection rule | Centralized; same logic applies to Tree and Flat views |
| Differing values | Rendered as *varies* in italic (literal string `varies` with italic styling) |
| Selection persistence | Survives tool activation / deactivation |
| Soft cap on multi-select | Body disables and shows "Too many selected for inspection — refine selection" past N (default 1000, configurable) |

## Out of scope (v2+)

- **Classifications** (`IfcRelAssociatesClassification`) — proper IFC classification system (e.g. NS 3420 codes as `IfcClassificationReference`). Classification codes stored as plain pset values *will* still appear naturally as pset rows. The dedicated classification mechanism is its own future workflow.
- **Filter on similar elements** — UI for cross-element filtering. The flat-row substrate is in place; the filter authoring UI is a separate phase.
- **Data aggregation** (count/sum/avg) — separate phase, depends on filter UI.
- **User-defined calculated fields** — separate phase, depends on aggregation.
- **Serialization of inspections / filters / aggregations into `.ifcproject`** — depends on the upstream features.
- **Schema discovery** (`describeSchema`) — useful for future filter UI; stub the repository method but don't implement walk-everything-once yet.
- **Right-click context menu on elements** — preserve current "no-op outside tools" behavior.

---

## Architecture

### Directory layout

```
src/inspector/
├── types.ts                     # Public data shapes
├── SelectionManager.ts          # Selection state, highlight lifecycle, modifier handling
├── repository/
│   ├── ElementPropertyRepository.ts   # Interface
│   └── WebIfcPropertyRepository.ts    # Concrete v1 implementation
├── intersection.ts              # Multi-select common-property logic (centralized)
├── format.ts                    # Value → display string; unit resolution
└── InspectorPanel.ts            # UI component (DOM-driven, no framework)
```

### Wiring

`App` constructs and owns:
- `WebIfcPropertyRepository(parser.api, modelIdMap)` — one instance, shared.
- `SelectionManager(viewer, modelManager, toolManager)` — one instance.
- `InspectorPanel(appEl, repository, selectionManager)` — one instance.

`App.removeModel(id)`:
- `selectionManager.onModelRemoved(id)` (drops any selected `expressId`s belonging to that model)
- `repository.disposeModel(id)` (frees memoized properties)
- `parser.api.CloseModel(webIfcId)` (frees web-ifc heap)
- (existing) `modelManager.removeModel(id)`, panel + record cleanup

`App.resetView()`:
- Clears selection.
- Closes all web-ifc models, re-parses from cached buffers. `modelIdMap` is rebuilt as re-parses complete.

### Model lifetime change (the core enabling change)

`IfcParser.parse(buffer, id)` today:
- `OpenModel(buffer)` → `modelID`
- Stream geometry → meshes
- **`CloseModel(modelID)`** ← remove this
- return `{ id, meshes }`

After change:
- `OpenModel(buffer)` → `modelID`
- Stream geometry → meshes
- (no close)
- return `{ id, modelID, meshes }`

`App` maintains `private modelIdMap = new Map<string, number>()` parallel to `bufferCache` / `modelRecords`. Populated in `handleFile` and `restoreSession`, cleared in `removeModel` / `resetView`.

`App.dispose()` adds: close every entry in `modelIdMap`.

**Memory note:** web-ifc holds the parsed schema in its WASM heap. For very large models or many loaded models, this is a real cost. Mitigation: aggressive close on `removeModel` (already in plan). Future: a "close inactive" eviction policy if multiple large models become common.

---

## Data model

### `src/inspector/types.ts`

```ts
export interface ElementIdentity {
  modelId: string;          // app UUID (matches ModelManager / SessionStore)
  expressId: number;        // IFC line ID (per model)
  ifcClass: string;         // "IfcWall"
  ifcTypeCode: number;      // numeric code, for fast type equality
  globalId?: string;        // 22-char IfcGloballyUniqueId
  name?: string;
  objectType?: string;
  tag?: string;
  predefinedType?: string;
}

export type SelectionMode = 'replace' | 'add' | 'remove';

export type SelectionState =
  | { kind: 'none' }
  | { kind: 'single'; identities: [ElementIdentity] }
  | { kind: 'multi'; identities: ElementIdentity[]; lockedModelId?: string };

export type PropertySource =
  | 'direct'         // Name, GlobalId, Tag, PredefinedType ...
  | 'pset'           // IfcPropertySet
  | 'qto'            // IfcElementQuantity
  | 'type'           // IfcRelDefinesByType → type's own psets
  | 'material';      // IfcRelAssociatesMaterial

export type PropertyValue =
  | { kind: 'single'; value: string | number | boolean | null;
      raw: { typeCode: number; value: unknown } }
  | { kind: 'enumerated'; values: string[]; enumRef?: string }
  | { kind: 'list'; values: PropertyValue[] }
  | { kind: 'bounded'; lower?: number; upper?: number; setpoint?: number }
  | { kind: 'table'; defining: PropertyValue[]; defined: PropertyValue[] }
  | { kind: 'complex'; children: PropertyNode[] }
  | { kind: 'quantity'; quantityKind: 'length'|'area'|'volume'|'count'|'weight'|'time';
      value: number }
  | { kind: 'material-ref'; materialName: string; expressId: number }
  | { kind: 'varies' };                 // sentinel for multi-select intersection

export interface PropertyNode {
  key: string;                          // "LoadBearing"
  label?: string;
  value: PropertyValue;
  unit?: string;                        // Resolved unit suffix, separate from value
  description?: string;
  source: PropertySource;
  inheritedFromType?: boolean;
  overridesType?: boolean;              // instance value, but a type value exists with same name
}

export interface PropertyGroup {
  name: string;                         // "Pset_WallCommon"
  source: PropertySource;
  inheritedFromType?: boolean;
  description?: string;
  properties: PropertyNode[];
}

export interface ElementProperties {
  identity: ElementIdentity;
  direct: PropertyNode[];               // Identity attributes as rows
  psets: PropertyGroup[];               // Instance + type-inherited (merged inline)
  qtos: PropertyGroup[];
  materials: PropertyValue[];           // material-ref + layered children
  flat: PropertyFlatRow[];              // Precomputed once at fetch time
  fetchedAt: number;
}

export interface PropertyFlatRow {
  path: string;                         // "Pset_WallCommon.LoadBearing"
  name: string;                         // "LoadBearing" (last segment)
  rawValue: PropertyValue;              // For aggregation / filtering
  displayValue: string;                 // Formatted string of the value only
  unit?: string;                        // Separate column
  source: PropertySource;
  inheritedFromType?: boolean;
  description?: string;
}
```

### Repository interface

```ts
export interface ElementPropertyRepository {
  get(modelId: string, expressId: number): Promise<ElementProperties>;
  cancel(modelId: string, expressId: number): void;
  disposeModel(modelId: string): void;

  // Future hooks (stubbed in v1)
  enumerateExpressIds(modelId: string, ifcClass?: string): AsyncIterable<number>;
  describeSchema(modelId: string): Promise<ModelSchema>;
}
```

### Intersection logic (centralized)

`src/inspector/intersection.ts` exports one pure function:

```ts
export function intersectProperties(elements: ElementProperties[]): ElementProperties;
```

- Identity in result: synthetic — `name` is omitted, `ifcClass` is shared class or "(mixed)" if elements differ, `expressId`/`globalId` are undefined.
- For each `PropertyFlatRow.path` present in **all** input elements:
  - If all `rawValue` instances are deep-equal → include with that value.
  - Otherwise → include with `{ kind: 'varies' }`.
- Tree groups (psets/qtos/etc.) are rebuilt by walking the common rows.
- Used by both Tree and Flat views — single source of truth for "common across selection."

Performance: with N elements, intersection is O(N × avg_rows). avg_rows is typically 50–200. At N = 1000 → 200k row-touches per intersection. Recompute only when selection changes, not on render.

---

## UI design

### Panel placement & structure

```
┌────────────────────────────────────┐
│ Exterior Wall 200mm          ◀ ✕  │  ← title (name or fallback) + collapse + close
├────────────────────────────────────┤
│ IfcWall · Tag W-12A               │  ← class + tag
│ GUID 2O2Fr$t4X7Zf… [copy]          │  ← truncated GUID, copy on click
│ modelB.ifc                        │  ← model name (only if >1 model loaded)
│ ☐ Single-model selection          │  ← checkbox (multi-select scope; Phase 4)
├────────────────────────────────────┤
│ ╭───╮                  ╭──╮╭──╮   │
│ │ 63│ properties        │🌳││📋│   │  ← count pill + tree/flat icon toggle
│ ╰───╯                  ╰──╯╰──╯   │
├────────────────────────────────────┤
│  (body — Tree or Flat depending   │
│   on toggle)                      │
└────────────────────────────────────┘
```

The icon toggle is a segmented control: two `<button>` elements with `aria-pressed` indicating the active view. The active button has a colored border (matching brand blue). Last-used view persists in localStorage under `ifcviewer:inspectorView` (default: `tree`).

The count pill (`63 properties`) gives at-a-glance scale information — useful when the user is about to flip into Flat view for a huge element.

CSS (target shape):
```
.inspector-panel {
  position: absolute;
  left: 12px;
  bottom: 48px;                   /* clears collapsed cookie icon */
  width: 280px;
  max-height: min(50vh, calc(100% - 60px - 48px - 12px));
  background: rgba(255, 255, 255, 0.95);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  z-index: 10;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.inspector-panel.collapsed { width: 36px; }
.inspector-panel.hidden { display: none; }
```

### Tree view rendering

Top-level collapsible sections in fixed order:
1. **Identity** — direct attributes (Name, GlobalId, ObjectType, Tag, PredefinedType, Description if present)
2. **Property Sets** — each pset as a sub-collapsible group; inherited type psets shown inline with "from type" badge; instance properties that override type are marked.
3. **Quantities** — each qto as a sub-collapsible.
4. **Materials** — layered/profile rendering for `IfcMaterialLayerSet` etc.

Each section header shows the row count next to the group name (e.g. `Pset_WallCommon  4`), matching the Dalux idiom.

Row format: `[badge?] Name = Value [unit-pill]`.
- *Varies* values render in italic gray text with a tooltip listing the distinct values (capped at 5 + "+N more").
- `IfcComplexProperty` renders as a nested collapsible row (recursive, max depth 6 indent before flattening with a `…` prefix).
- Long values truncate with ellipsis; tooltip shows full text; click-to-copy.

### Flat view rendering

Three columns: `Name | Value | Unit`.
- Alphabetically sorted by `path` (the path is shown as the Name column with dotted prefix for nested complex props, e.g. `Pset_WallCommon.LoadBearing`).
- Filter input at top of the body (substring match on `path`, debounced 100ms).
- *Varies* values in italic gray, unit column empty (because units could also vary; that's a v2 enhancement).
- For N < 500 rows, render as plain DOM list. Virtualization deferred.

### Multi-select header

When `state.kind === 'multi'`:
- Header changes to `N elements selected` (with ifcClass mix if shared).
- Identity rows replaced with summary: `3 IfcWall, 2 IfcDoor` etc.
- Body shows intersection as described.
- Soft cap behavior: at N > 1000, body shows "Too many selected for inspection — refine selection". Identity summary still renders.

### Empty / loading / error states

| State | Render |
|-------|--------|
| No model loaded | Panel hidden |
| No selection | Panel hidden |
| Selection, fetching < 50ms | Show panel, header populated from `userData` (expressId + ifcClass), body shows nothing yet |
| Selection, fetching > 50ms | Spinner in body |
| Selection, loaded | Full render |
| Selection, error | Inline error banner; console.log details |
| Model removed while selected | Selection auto-cleared; panel hides |

### Single-model selection toggle

A checkbox in the inspector header (below identity, above the view toggle):
- **Checked (default? — open question):** multi-select within one model only. Switching to a different model with no modifier clears selection in A and starts fresh in B.
- **Unchecked:** ctrl+click works across models; selection can span multiple models simultaneously.

State persists in `localStorage` under `ifcviewer:inspectorSingleModelLock`.

---

## Selection mechanism

### Always-on default behavior

`SelectionManager` installs `pointerdown` + `pointerup` on the canvas. Click-vs-drag distinguished by 3px movement threshold (same as `MeasurementTool`).

On a click:
1. If any tool is active (`toolManager.getActiveTool() !== null`) → bail. Tools own clicks during their lifetime.
2. If pivot picking is active (`viewer.isPivotPicking()`) → bail.
3. Raycast via `raycastVisible`.
4. Determine mode from modifier keys:
   - No modifier → `replace`
   - `ctrl/cmd` → `add` (or toggle if already selected)
   - `shift` → `remove`
5. On empty hit + no modifier → `clear`.
6. On empty hit + modifier → no-op.
7. Apply selection change; emit `onChange`.

### Highlight

Per-mesh state stored in `SelectionManager`:
- `selectedMeshes: Map<meshUuid, { mesh: THREE.Mesh; originalMaterial: THREE.Material | THREE.Material[] }>`

On select:
- For each mesh sharing the selected `expressID` (need to look up by walking `modelManager.getModel(modelId).group.children` once; for many selected elements, batch this):
  - Save original material reference.
  - Clone material; set `emissive: 0x3b82f6`, `emissiveIntensity: 0.3` (probe-test value, tune to taste).
  - Replace mesh.material.

On deselect:
- Restore original material; dispose clone; remove from map.

`raycast.ts` is extended to skip a new `userData.isSelection` flag (in case future affordances use overlay meshes). For now the highlight is in-place so no exclusion is needed.

### ESC

The keyboard shortcut `Escape` (`App.ts:204-213`) is extended: if no tool is active and pivot is not picking, clear the selection.

### Tool composition

- Selection persists across tool activations.
- Clicks during tool active state route to the tool, not selection.
- Clipping in PLACING owns mousedown. Selection ignores.
- Measurement always owns clicks while active.
- Pivot picking owns clicks while flag set.

---

## Implementation phases

This is large enough to warrant phasing. Each phase ends green (tests + lint + typecheck) and is independently mergeable.

### Phase 1 — Model lifetime + repository (foundation)

**Goal:** make web-ifc properties queryable after parse, with a clean repository abstraction.

1. Branch off `main`: `feature/inspector-foundation`.
2. Update `IfcParser.parse` signature to return `{ id, modelID, meshes }`. Remove `CloseModel` call. Update tests.
3. Add `modelIdMap` to `App`. Update `handleFile`, `restoreSession`, `removeModel`, `resetView`, `dispose` to populate and close as appropriate.
4. Create `src/inspector/types.ts` (data shapes only, no logic).
5. Create `src/inspector/format.ts` (value formatter + unit resolution).
6. Create `src/inspector/repository/ElementPropertyRepository.ts` (interface).
7. Create `src/inspector/repository/WebIfcPropertyRepository.ts` (concrete impl). Fetch via `getItemProperties`, `getPropertySets`, `getMaterialsProperties`. Normalize into `ElementProperties`. Build `flat` array at fetch time. Memoize per `(modelId, expressId)`.
8. Unit tests (no UI yet): repository normalization against a fixture IFC file (use a small sample from `public/`).
9. PR + manual smoke test (verify models still load + render after the parser change).

### Phase 2 — Selection + highlight

**Goal:** clicking an element selects and highlights it. No inspector UI yet.

1. Branch off `main`: `feature/inspector-selection`.
2. Create `src/inspector/SelectionManager.ts`. Implements click/ctrl-click/shift-click logic, highlight via material clone, model-removed cleanup.
3. Wire `SelectionManager` into `App`. Pass `toolManager` so it can defer to active tools.
4. Extend `App` Escape handler to clear selection when no tool / no pivot.
5. Extend `App.removeModel` and `App.resetView` to call `selectionManager.onModelRemoved` / `clear`.
6. Unit tests for `SelectionManager`: state transitions, modifier handling, multi-model lock.
7. Manual: click renders highlight, click empty clears, ESC clears, ctrl+click adds, shift+click removes, tool active blocks selection.
8. PR.

### Phase 3 — Inspector panel (single-select only)

**Goal:** panel renders for single selection with Tree + Flat views switchable via icon toggle.

1. Branch off `main`: `feature/inspector-panel`.
2. Create `src/inspector/InspectorPanel.ts` (DOM idioms matching `ModelTreePanel`).
3. Header: identity rows, copy-on-click GUID, total-property count pill, tree/flat icon toggle (segmented control).
4. Tree view: collapsible sections (with row count next to group name), recursive complex property rendering, identity section.
5. Flat view: three-column table (`Name | Value | Unit`), substring filter, alphabetical sort.
6. State machine: hidden / fetching / loaded / error. Spinner appears at 50ms.
7. CSS in `styles.css` extending the existing panel idiom.
8. Wire to `selectionManager.onChange` + `repository.get`.
9. Unit tests (jsdom): state transitions, render structure.
10. Manual: select various element types, verify all sections render and look right.
11. PR.

### Phase 4 — Multi-selection + intersection

**Goal:** multi-select with intersection logic and *varies* rendering.

1. Branch off `main`: `feature/inspector-multiselect`.
2. Create `src/inspector/intersection.ts` (pure function).
3. Extend `SelectionManager` to handle the multi state. Highlight all selected.
4. Extend `InspectorPanel` to render multi-select header (`N selected`), apply intersection, soft cap behavior.
5. Add the "Single-model selection" checkbox; persist in localStorage.
6. Unit tests: intersection logic with crafted fixtures, varies sentinel, soft cap.
7. Manual: select 2 walls (similar values → most things match); select 1 wall + 1 door (very few common keys); test ctrl/shift modifier combos; verify single-model lock checkbox behavior.
8. PR.

### Phase 5 (optional first cut) — Polish

Only land if Phases 1–4 are stable.
- Tooltip for varies values listing distinct values.
- Click-to-copy on path, value, GUID.
- Better empty state copy.
- Performance profiling on a real large model.

---

## Manual smoke tests per phase

Each phase ends with the user running this checklist in a browser. Tests are listed in order — earlier tests verify foundation; later tests verify the phase's new behavior. Any test failing should block the PR.

### Phase 1 — Model lifetime + repository

**Goal of smoke test:** confirm nothing user-visible regresses after the `IfcParser` lifetime change.

1. **Fresh load** — open the app in a private/incognito window, drag in a small `.ifc`. Verify it renders and orbit works.
2. **+ button** — click `+` in the model panel, pick a `.ifc` from file dialog. Verify it loads.
3. **Multiple models** — load 2–3 models in sequence (drag, +, then drag). All visible in the tree panel; all geometry visible in viewport.
4. **Remove one** — click `×` on a model row. Geometry disappears; tree row gone; other models still rendered correctly.
5. **Reset view** — click the reset (`↺`) toolbar button. All models re-parse from buffer and re-render. No errors. Tree panel rebuilt with the same models.
6. **Remote URL** — paste a remote `.ifc` URL into the URL input. Verify load.
7. **Memory toggle on** — toggle the memory switch on, load a model. Refresh the page. The model should restore.
8. **Memory toggle remove** — with memory on, remove a model via `×`. Refresh. The removed model should not come back (regression check on the existing fix).
9. **Browser dev console** — open DevTools console. Throughout the above, **no red errors or unhandled rejections**. Yellow warnings okay if pre-existing.
10. **(Internal) modelID persistence** — temporary `console.log` during dev: after parse, verify the web-ifc modelID is stored in `App.modelIdMap` and persists across other model loads.
11. **(Internal) close on remove** — after `×` on a model, temporary log confirms `parser.api.CloseModel(modelID)` was called for that model only.

**Stop signs:** if `OpenModel` is called twice for the same buffer in a session, or `CloseModel` runs while the model is still in the scene, fix before moving on.

---

### Phase 2 — Selection + highlight

**Goal of smoke test:** confirm clicks select and highlight as designed, with correct tool composition.

Prerequisites: Phase 1 merged. Load a model with at least 50 elements (so there's plenty to click).

**Basic selection**
1. Left-click an element → element turns blue (emissive boost visible).
2. Left-click empty space (outside any geometry) → highlight clears.
3. Left-click element A, then element B → A returns to original color, B is highlighted.
4. Press `Esc` while element selected → highlight clears.
5. Click on a complex element (e.g. a wall with multiple geometries) → **all meshes of that element** highlight together, not just the clicked face.

**Multi-select modifiers** (single-model lock is not present yet in Phase 2 — modifiers work freely)
6. Ctrl+click element A, then ctrl+click element B → both highlighted.
7. Ctrl+click element A, then ctrl+click A again → A deselected.
8. Shift+click an unselected element → no change (no-op confirmed).
9. Ctrl+click 3 elements, then shift+click the second → it deselects, other two remain.
10. Ctrl+click 3 elements, then `Esc` → all deselected.
11. With nothing selected, ctrl+click an element → selects it (ctrl from empty acts like a normal pick).
12. With nothing selected, shift+click an element → no-op (confirmed).

**Tool composition**
13. Select element A. Activate Clipping tool (`C`). Click on geometry → clipping plane placed, element A still selected (highlight persists).
14. Cancel clipping placement (`Esc`) → clipping deactivated, A still highlighted.
15. Activate Measurement (`M`). Click 2 points to measure → measurement placed, original selection unchanged.
16. Activate pivot picking (`V`). Click on geometry → pivot set, selection unchanged.
17. With clipping active and PLACING, click an element → does NOT select (tool owns click). Confirm by inspecting state after — no selection change.

**Cross-model + lifecycle**
18. Load a second model. Click an element in model A (highlight). Click an element in model B (with no modifier) → A's selection clears, B is highlighted.
19. With element selected in model A, click `×` on model A's row → selection auto-clears, no errors.
20. Reset view → selection cleared, all models re-render.

**Console**
21. Throughout above: no errors.

---

### Phase 3 — Inspector panel (single-select only)

**Goal of smoke test:** confirm panel renders correctly for single-selected elements in both Tree and Flat views.

Prerequisites: Phase 2 merged. Use a model with rich properties (walls, doors, windows with psets and qtos).

**Panel lifecycle**
1. Open app, no model loaded → inspector panel hidden.
2. Load a model, no selection → inspector still hidden.
3. Click an element → panel appears bottom-left, above any visible cookie banner.
4. Click another element → panel content updates (header + body).
5. Click empty space → panel hides.
6. Press `Esc` → panel hides.
7. Collapse button (`◀`) → panel collapses to a thin strip. Click `▶` to expand again.

**Header content**
8. Selected element's **Name** shown as title (e.g. "Exterior Wall 200mm").
9. If Name is missing → fallback to `<IfcClass> #<expressId>` (e.g. `IfcWall #12345`).
10. IfcClass shown as a small label (e.g. "IfcWall").
11. Tag shown if present.
12. GUID truncated to ~20 chars with `…`; full GUID in tooltip on hover.
13. Click on GUID → full GUID copied to clipboard. Brief visual confirmation (e.g. "Copied!" or color flash).
14. With multiple models loaded → model filename shown in header. With only one → suppressed.

**Property count pill + toggle**
15. Pill shows total leaf-property count (`63 properties` or similar).
16. Two icon buttons visible (tree icon, list icon). One is highlighted as active.
17. Click the inactive icon → view switches; the icon highlight moves.
18. Reload page → view defaults to last-used (verifying localStorage persistence).

**Tree view**
19. Top sections render: Identity, Property Sets, Quantities, Materials (only sections that have content).
20. Each section header shows row count (e.g. "Pset_WallCommon  4").
21. Click section caret → expands; rows visible.
22. Click again → collapses.
23. Identity section shows Name, GlobalId, ObjectType (if present), Tag (if present), PredefinedType (if present).
24. Pset rows render as `Name = Value [unit-pill]`.
25. Unit pill present for measure types (e.g. `200 mm`, `72.208 m²`, `21.662 m³`).
26. Inherited type pset (if model has them) → "from type" badge visible.
27. Find a property with an `IfcComplexProperty` value → click to expand → children render with deeper indent.
28. Long value (e.g. long description) → truncates with ellipsis; tooltip shows full text on hover.
29. Click a value → copies to clipboard with brief visual confirmation.

**Flat view**
30. Switch to Flat → three columns visible: Name | Value | Unit.
31. Rows alphabetically sorted by path (`Pset_WallCommon.IsExternal` before `Pset_WallCommon.LoadBearing`).
32. Filter input at top → typing `LoadBearing` narrows visible rows.
33. Clear filter → all rows reappear.
34. Unit column populated for measure types; empty for booleans/strings.
35. Raw numeric values in Value column (e.g. `200`, not `200 mm`) — unit is separate.
36. Boolean values render `true` / `false`.
37. Null / empty values render as empty cell or `—`.

**Performance / states**
38. Click element with many properties (>200) → renders without visible jank.
39. Click element quickly in succession (multiple elements) → no stale data lingers; each click updates within ~200ms.
40. Trigger a fetch error artificially (temporary log throw inside repository) → inline error banner appears, no crash, console-log shows details.
41. With memory toggle on, refresh page → no inspector visible (no selection persists across reload, by design).

**Console**
42. Throughout: no errors.

---

### Phase 4 — Multi-selection + intersection

**Goal of smoke test:** confirm intersection logic and `varies` rendering for multi-element selections.

Prerequisites: Phase 3 merged. Use a model with multiple walls (similar) and at least one door (different) for contrast.

**Multi-select basics**
1. Ctrl+click two similar walls → header shows "2 elements selected" (or similar). Body shows intersection.
2. Verify common psets (e.g. `Pset_WallCommon`) appear; properties that match across both walls show their value; properties that differ show *varies* in italic gray.
3. Hover *varies* value → tooltip lists distinct values (cap at 5 + "+N more").
4. Ctrl+click a third wall → still common pset visible; more values may now be *varies*.
5. Shift+click one of the three → drops back to 2, intersection recomputed.
6. Ctrl+click 1 wall + 1 door → very few common properties; mostly identity attrs.
7. Header summary shows mixed class (e.g. "2 IfcWall, 1 IfcDoor" or "(mixed)" badge).

**Single-model selection checkbox**
8. With 1 model loaded, checkbox visible in header.
9. With multiple models loaded, checkbox still visible (always shown when selection exists).
10. Default state of checkbox (per decision — TBD): verify it matches the chosen default.
11. **Lock ON, switching models**: select elements in model A. Click an element in model B with no modifier → A's selection clears, B's element is selected (single).
12. **Lock ON, ctrl+click in another model**: with elements selected in A, ctrl+click in model B → A's selection clears, B starts fresh (lock prevents cross-model multi-select).
13. **Lock OFF, ctrl+click in another model**: with elements selected in A, ctrl+click in B → element added; selection now spans both models. Intersection across all selected.
14. Toggle checkbox while multi-select active in mixed-model state → if changing to ON, selection collapses to the last-clicked model only (or clears — decide which).
15. Reload page → checkbox state persisted via localStorage.

**Soft cap**
16. Ctrl+click ~1000 elements (or temporarily lower cap to e.g. 5 for testing) → past the cap, body shows "Too many selected for inspection — refine selection". Identity summary still shown.
17. Shift+click to drop one element back below the cap → full inspector returns.

**Tree view + intersection**
18. Multi-select 2 walls. Switch to Tree view → same intersection rule applies. *Varies* markers in Tree where they appear in Flat.

**Tool composition (regression)**
19. Multi-select 3 elements. Activate Clipping → click on geometry → clipping placed, selection persists.
20. With multi-select active, press `Esc` → selection clears, panel hides.

**Lifecycle**
21. Multi-select across two models (lock OFF), remove one model via `×` → only that model's elements drop from selection; the others remain.
22. Reset view with multi-selection → selection clears.

**Console**
23. Throughout: no errors. No "intersection took >100ms" warnings on N ≤ 10.

---

## Testing strategy

### Unit tests (vitest)

- **`format.test.ts`** — `formatValue(typed) → display string` for each `PropertyValue` kind, unit-suffix resolution from a stub unit assignment.
- **`intersection.test.ts`** — `intersectProperties` correctness: identical elements → identical out; different values → varies; one element missing a path → path not in result.
- **`WebIfcPropertyRepository.test.ts`** — using a small fixture .ifc loaded via the parser, fetch properties for a known element, assert shape and values. Requires fixture in `public/` or `tests/fixtures/`.
- **`SelectionManager.test.ts`** — pure state-transition tests with stub viewer / modelManager / toolManager.
- **`InspectorPanel.test.ts`** — jsdom-based; mount, simulate selection change, assert DOM structure.

### Manual test plan

Per phase (see above). The Phase 4 manual test is the most thorough — verify:
- Single click, ctrl+click sequences, shift+click sequences
- Multi-select across different ifcClasses → very few common props
- Multi-select of identical elements → all props identical (no varies)
- Multi-select including a model switch with single-model lock on vs off
- ESC always clears
- Tool activation while elements selected → selection persists; clicks while tool active don't change selection
- Model removed while selected → selection auto-cleared, panel hides

---

## Risks & open questions

1. **Default value of "Single-model selection" toggle** — checked (safer, simpler intersection) or unchecked (more flexible)? Recommend checked by default.

2. **Memory ceiling on keeping web-ifc models open** — at what point does this become a problem? Worth profiling on a real ~500MB model after Phase 1.

3. **Performance of intersection at N = 1000+** — should be fine on modern hardware but worth profiling. If slow, the optimization is to index `Map<path, Map<elementKey, rawValue>>` per model lazily.

4. **Highlight color vs. type-colored elements** — emissive blue might clash visually with elements that are themselves blue. Mitigation: stronger emissive intensity or a different highlight strategy (e.g. additive outline) if user feedback indicates it. Defer fix until observed.

5. **Type properties from `getPropertySets(..., includeTypeProperties=true)`** — verify provenance tagging in the returned data. If web-ifc doesn't tag them, do two calls (with and without) and diff. Document in repository implementation.

6. **The 3-call-parallel pattern overlapping with parse queue** — `App.parseQueue` is serial. If user clicks during parse, repository calls might block. Mitigation: chain repository requests on the parse queue, the same way `App.handleFile` does. Document in `WebIfcPropertyRepository`.

7. **Inspector panel collision with model panel when both tall** — both anchor to the left rail. v1: independent positioning, may visually overlap on small viewports. v2: unify into a single resizable left rail.

8. **Selection survival across model reload (`resetView`)** — `resetView` re-parses from buffers; expressIds are stable across re-parse. Could survive, but recommend clearing for simplicity.

---

## Future extensibility hooks (already designed for)

| Future feature | Hook |
|----------------|------|
| Filter on similar elements | `PropertyFlatRow.path` is the predicate target. `repository.enumerateExpressIds` is the iteration source. |
| Aggregation (count/sum/avg) | Same predicate + iteration; aggregation reads `rawValue` (no string parsing needed because unit is in its own column). |
| Calculated fields | Formulas reference `path` strings; evaluator reads `rawValue` numerics. |
| Schema discovery | `repository.describeSchema` stubbed in v1. |
| Per-project serialization | `.ifcproject` manifest gets `inspections`, `filters`, `aggregations`, `calcFields` sections (version bump). Saved selections key on GUID with expressId fallback. |
| Cross-element comparison view | Reuse intersection logic; render N columns instead of intersection-only. |

---

## Definition of done (v1)

- User clicks an element → blue highlight + properties panel.
- Panel shows identity, psets, qtos, materials, type-inherited props (with "from type" badge).
- Tree and Flat views both render correctly, switchable via icon toggle.
- Flat view has a working substring filter.
- Unit shown in a separate column (Flat) / unit-pill (Tree).
- Multi-select with `ctrl+click` / `shift+click` shows intersection with *varies*.
- Single-model selection checkbox toggles scope.
- ESC clears.
- Selection persists across tool toggles.
- Model removal cleans up selection + panel.
- All vitest + lint + typecheck green.
- Manual test plan executed.
- PR opened, CI green, user-approved before merge.
