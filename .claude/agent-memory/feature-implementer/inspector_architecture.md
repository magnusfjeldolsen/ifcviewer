---
name: Inspector architecture
description: Element-properties inspector module layout, render pipeline, and intersection-rule centralization
type: project
---

The Element Properties Inspector lives under `src/inspector/`.

**Module boundaries**
- `types.ts` — pure data shapes (ElementProperties, SelectionState, PropertyFlatRow, …).
- `SelectionManager.ts` — selection state + highlight lifecycle; also owns the single-model lock flag and persists it to localStorage.
- `repository/fetchElementProperties.ts` — pure-ish fetch+normalize core: parallel getItemProperties + getPropertySets + getTypeProperties + getMaterialsProperties, instance/type pset merge. Worker-importable. (Extracted from the deleted `WebIfcPropertyRepository` by `web-worker-parse`.)
- `repository/WorkerPropertyRepository.ts` — `ElementPropertyRepository` impl: main-thread memoization + `getProps` round-trip to the IFC worker. See [[worker-architecture]].
- `repository/propertyNormalizer.ts` — pure normalization helpers (TypedValue normalization, MEASURE_NAME_TO_TYPECODE, isObj, readString/readNumber, buildIdentity/buildDirect, buildPsetGroup/buildQuantityGroup, buildPropertyNode/buildQuantityNode, buildMaterials, markInheritedRecursively, ifcClassFromTypeCode).
- `repository/unitTable.ts` — `computeUnitTable` + `readUnitEntry`. Takes a small `UnitTableApi` shape so unit-table tests don't need the full PropertyApi.
- `repository/flatRows.ts` — `buildFlatRows` + `displayStringForValue`. Single home for the flat-row materialization. Note: `displayStringForValue` is imported by BOTH the repository internals AND `InspectorPanel.ts`'s renderers — flatRows.ts owns it.
- `intersection.ts` — pure `intersectProperties(elements)` plus `getDistinctValuesForPath` for varies tooltips. Distinct-value map attached as a non-enumerable `__variesDistinct` on the result so the ElementProperties type stays unchanged.
- `InspectorPanel.ts` — class only: DOM construction, lifecycle, fetch/render state machine, lock-row, copy-with-flash, formatVariesTooltip, and ctx-builders bridging to the render modules. **The Tree and Flat renderers both consume the same `ElementProperties` object**, so multi-select rendering reuses single-select code paths via the synthetic intersection result.
- `panel/renderHeader.ts` — pure `renderHeader` (single) + `renderMultiHeader` (multi). Owns titleForIdentity, summarizeClassMix, totalPropertyCount, and GUID_TRUNCATE_AT.
- `panel/renderTree.ts` — pure `renderTree` + recursion (`buildSection`, `buildGroup`, `buildPropertyRow`, `buildValueElement`). Owns MAX_COMPLEX_DEPTH and groupLeafCount.
- `panel/renderFlat.ts` — pure `renderFlat` + buildFlatRow + filter-debounce wiring. Owns FILTER_DEBOUNCE_MS.

**Renderer contract:** each `render*` is pure — takes target DOM slots (via ctx for header, as a direct target param for tree/flat) + an `*RenderContext` object carrying callbacks (`copyWithFlash`, `formatVariesTooltip`, `getModelCount`, `refreshLockRow`, …) and shared constants (`valueTruncateAt`). Filter state lives on the panel and is read/written via ctx getters/setters so view-toggles preserve it.

**Why:** the plan explicitly mandates "Tree view also uses the intersection rule" — keeping ONE renderer path is the centralization that prevents view-specific bugs.

**How to apply:** when adding a new property-driven feature (filter, aggregation), build it against `PropertyFlatRow` (the substrate), not against the DOM. The plan's future-work hooks all rely on the flat-row shape.

**Path conventions on PropertyFlatRow**
- `Identity.<key>` — direct identity attrs
- `<PsetName>.<key>` — pset / type-inherited pset
- `<QtoName>.<key>` — quantity
- Deeper paths for `IfcComplexProperty` children via recursive prefix.

**RenderTag state machine** (`InspectorPanel.ts`):
- `hidden | fetching | loaded | multi-loaded | multi-cap | error`
- Stale-fetch guarding uses `inflightKey` per render kind; the multi-key is `__multi__:<modelId:expressId|...>`.

**Lock + persistence**
- SelectionManager owns `singleModelLock` (default true) and persists to `localStorage` under `ifcviewer:inspectorSingleModelLock`.
- `setSingleModelLock(true)` with a cross-model selection collapses to the last-clicked model (insertion-order Set preserves it).
- `apply('add', identity)` short-circuits to `replace` when the lock is on AND the new pick is in a different model.

**Soft cap**
- Exported as `MULTI_SELECT_SOFT_CAP = 1000` from InspectorPanel.
- Body shows "Too many selected for inspection — refine selection"; header summary still renders.
