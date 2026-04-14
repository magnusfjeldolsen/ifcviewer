# Phase 2 — Basic Viewer

## Goal

A user can open an IFC file and see the 3D geometry rendered in the browser with orbit/pan/zoom controls. This is the minimum viable viewer.

## Features

### 2a: File Loading Module
Load IFC files into the browser via two methods:
- File input button (click to browse)
- Drag-and-drop zone

The loader returns an `ArrayBuffer` to the parser. It does NOT parse or render — single responsibility.

**Module:** `src/loader/FileLoader.ts`

### 2b: IFC Parsing Module
Wrap `web-ifc` to parse an `ArrayBuffer` into geometry data (meshes, materials). Returns structured data the viewer can consume.

**Module:** `src/parser/IfcParser.ts`

### 2c: Model Rendering
Accept parsed geometry and add it to the Three.js scene. Handle material assignment and cleanup of previous models.

**Module:** `src/viewer/ModelLoader.ts`

### 2d: Integration
Wire loader → parser → viewer together through `App.ts`. User drops a file, sees the model.

## Checklist

### Preparation
- [ ] Create branch `feature/basic-viewer`
- [ ] Run all existing tests (must pass before writing code)

### 2a — File Loading
- [ ] Create `FileLoader` class with `loadFromInput()` and `loadFromDrop()` methods
- [ ] Add drag-drop zone + file input button to `index.html`
- [ ] Style the upload UI (minimal, non-blocking overlay)
- [ ] Write tests for FileLoader (mock file input, verify ArrayBuffer output)

### 2b — IFC Parsing
- [ ] Create `IfcParser` class wrapping web-ifc `IfcAPI`
- [ ] Implement `parse(buffer: ArrayBuffer)` → returns mesh data
- [ ] Handle WASM initialization (load web-ifc WASM once)
- [ ] Write tests for IfcParser (use a small test .ifc file)

### 2c — Model Rendering
- [ ] Create `ModelLoader` class that takes parsed geometry → Three.js meshes
- [ ] Add to scene, fit camera to model bounds
- [ ] Implement `clear()` to remove previous model before loading new one
- [ ] Write tests for ModelLoader (verify mesh creation from mock data)

### 2d — Integration
- [ ] Wire FileLoader → IfcParser → ModelLoader in App.ts
- [ ] Add loading indicator (simple text/spinner)
- [ ] Handle errors gracefully (show message if file fails to parse)
- [ ] Run all tests
- [ ] Ask for manual testing

## Architecture

```
User drops .ifc file
        │
        ▼
  FileLoader          ← src/loader/FileLoader.ts
  (returns ArrayBuffer)
        │
        ▼
  IfcParser            ← src/parser/IfcParser.ts
  (returns mesh data)
        │
        ▼
  ModelLoader          ← src/viewer/ModelLoader.ts
  (adds to Three.js scene)
        │
        ▼
  Viewer               ← src/viewer/Viewer.ts
  (renders frame loop)
```

Each module has a single responsibility and communicates through plain data — no module imports another module's internals.

## Test Strategy

- **FileLoader**: mock `File` objects, verify `ArrayBuffer` output
- **IfcParser**: use a minimal `.ifc` test fixture (~1KB), verify mesh data structure
- **ModelLoader**: pass mock geometry data, verify `THREE.Mesh` instances created
- **Integration**: not unit-tested — covered by manual testing

## Done When

- User can drag-drop or browse for an `.ifc` file
- 3D geometry renders in the viewport
- Camera auto-fits to the model
- Loading a new file replaces the previous model
- All tests pass
- Manual test approved
