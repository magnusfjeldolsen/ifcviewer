---
name: Module boundaries
description: Where new feature code lands in src/ for this IFC viewer project
type: project
---

Source tree organized by feature concern, each module independent:

- `src/core/App.ts` — top-level wiring. Constructs and owns every other module. New feature wiring goes here. Modify cautiously.
- `src/viewer/` — Three.js scene + camera + ModelManager (THREE.Group per loaded model)
- `src/parser/` — web-ifc runs in a Web Worker as of `web-worker-parse`. `ifcWorker.ts` owns the `IfcAPI`; `WorkerIfcParser.ts` is the main-thread proxy `App` holds. See [[worker-architecture]] for the full layout. (`IfcParser.ts` was deleted.)
- `src/loader/` — file/URL ingestion (FileLoader for drag-drop + file input, RemoteLoader for URLs)
- `src/tools/` — registered tools (Clipping, Measurement). Each tool owns mouse events while active.
- `src/services/` — SessionStore (IndexedDB), Analytics, CookieConsent
- `src/ui/` — DOM-driven UI components (Toolbar, ModelTreePanel, HelpOverlay, etc.). No framework — vanilla DOM.
- `src/inspector/` — Element Properties Inspector (added Phase 1, 2026-05). Repository pattern (`ElementPropertyRepository` interface, `WebIfcPropertyRepository` impl), types in `types.ts`, formatting in `format.ts`. Phase 2 adds `SelectionManager`, Phase 3 adds `InspectorPanel`.
- `src/utils/raycast.ts` — `raycastVisible()` returns first hit mesh, exposes `expressID` via `mesh.userData.expressID` and modelId via `mesh.parent.name`.

**App owns lifecycle.** Tools, panels, repositories, parsers all get disposed by `App.dispose`. Order matters: web-ifc models must be closed BEFORE `parser.dispose()` (which tears down the WASM heap).

**Pattern:** features are constructor-injected. New module → instantiate in `App` constructor, store as `private` field, wire callbacks/events.
