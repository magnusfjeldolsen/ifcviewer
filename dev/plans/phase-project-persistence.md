# Phase: Project Persistence & Export/Import

## TL;DR

### What's broken

| # | Bug | Root cause | Where |
|---|-----|-----------|-------|
| 1 | Removed models reappear on refresh | `onRemoveModel` never deletes from `loadedFiles`, IndexedDB, or saves updated session | App.ts:100-103 |
| 2 | Orphaned files in IndexedDB resurrect | `restoreSession()` loads ALL IndexedDB files, ignores `session.fileNames` | App.ts:262-288 |
| 3 | Remote model URLs are forgotten | Remote buffers stored identically to local files — no URL preserved | SessionStore.ts |
| 4 | Toggle persistence off → stale data returns | Scheduled save timer fires *after* `clearSession()`, re-writing wiped data | App.ts:251 + MemoryToggle.ts:42 |
| 5 | Concurrent file drops can corrupt parser | Shared `WebIFC.IfcAPI` instance, no queue, interleaved `OpenModel`/`CloseModel` | App.ts + IfcParser.ts |
| 6 | Callback errors break UI/scene sync | ModelTreePanel callbacks have no try-catch — one throw leaves state split | ModelTreePanel.ts:59,65,101,124 |

### How to fix it

| Phase | What | How |
|-------|------|-----|
| **1 — Bug fix** | Fix remove + restore | Add 3 lines to `onRemoveModel` (delete from loadedFiles, IndexedDB, save session). Filter restore against `session.fileNames`. Guard save timer with `isMemoryEnabled()` re-check. |
| **2 — Model registry** | Replace fragmented state with `ModelRecord` + UUID identity | New `ModelRecord` type tracks source (local/remote+URL). IndexedDB v2 migration. Single `modelRecords` Map replaces `loadedFiles`. Sequential parse queue prevents concurrency bugs. |
| **3 — Export/Import** | `.ifcproject` file format | Zip (via `fflate`) containing `manifest.json` + local IFC buffers. Remote models stored as URL-only. Import via drag-drop. |

### Ship order

```
Phase 1 (bug fix)       → standalone, no breaking changes
Phase 2 (registry)      → depends on Phase 1
Phase 3 (export/import) → depends on Phase 2
```

---

## Problem Statement

The viewer has a session persistence bug: when models are removed and the page is refreshed, the removed models reappear. The root cause is that `onRemoveModel` (App.ts:100-103) only cleans up the 3D scene and UI tree — it never removes the file from `loadedFiles`, IndexedDB, or updates the saved session.

Beyond this bug, the persistence system has deeper structural issues that should be addressed to support project-like workflows (export, import, reliable restore).

---

## Current Architecture

### State is fragmented across 4 independent stores

| Store | Location | Holds |
|-------|----------|-------|
| `ModelManager.models` | `src/viewer/ModelManager.ts:12` | `Map<string, ModelEntry>` — THREE.js Groups in the scene |
| `ModelTreePanel.rows` | `src/ui/ModelTreePanel.ts:31` | `Map<string, RowEntry>` — DOM elements for each model |
| `App.loadedFiles` | `src/core/App.ts:41` | `Map<string, ArrayBuffer>` — raw file buffers in memory |
| SessionStore (IndexedDB + localStorage) | `src/services/SessionStore.ts` | Persisted file buffers + camera + file name list |

There is no single source of truth. These stores are synchronized through ad-hoc callback chains in App.ts. If any step throws or is missed, the stores diverge.

### Model identity is filename-based

Models are identified by their filename string (e.g., `"building.ifc"`). This means:
- Two files with the same name collide silently
- Remote models lose their URL origin (stored as bare buffers identical to local files)
- No way to distinguish local vs remote on restore

UUIDs are used internally for stable identity, but **duplicate filenames are rejected** — if a model with the same display name is already loaded, show a status message (e.g., `"model.ifc is already loaded"`) and skip. The user must remove the existing model first if they want to replace it. This avoids confusion and matches standard project behavior.

---

## Audit Findings (robustness issues to fix alongside this feature)

### Critical

1. **Remove doesn't clean up persistence** — the core bug. `onRemoveModel` never calls `loadedFiles.delete()`, `sessionStore.removeFile()`, or `scheduleSave()`.

2. **Restore ignores session state** — `restoreSession()` loads ALL files from IndexedDB regardless of what `session.fileNames` says. Orphaned files in IndexedDB always come back.

3. **Race condition: memory toggle vs auto-save** — User disables persistence → `clearSession()` wipes IndexedDB → 500ms later the scheduled save timer fires and writes stale data back. No flag check before the write.

4. **No callback error handling** — `ModelTreePanel` callbacks (`onRemoveModel`, `onVisibilityToggle`, etc.) at lines 59, 65, 101, 124 have no try-catch. If a callback throws, the DOM is left in an inconsistent state.

5. **Concurrent file parsing** — User can drop multiple files simultaneously. `IfcParser` uses a shared `WebIFC.IfcAPI` instance with no mutex. Interleaved `OpenModel`/`CloseModel` calls could corrupt parser state.

### High

6. **Silent error swallowing** — Every `catch` block in `SessionStore.ts` is empty. IndexedDB quota exceeded, corruption, or permission errors are invisible to the user.

7. **No duplicate-load detection** — Dropping the same file twice calls `handleFile` twice. The second load silently replaces the first in `loadedFiles` (same key), but `ModelManager.addModel` creates a second THREE.Group (different internal model ID if parser generates one).

8. **Unhandled promise rejections** — `main.ts:9` (`app.start()` without `.catch()`), App.ts event callbacks that return promises without `await`.

### Medium

9. **No file content validation in FileLoader** — Only checks `.ifc` extension. Invalid files pass through to the parser which crashes. `RemoteLoader` does validate IFC header signatures, but `FileLoader` does not.

---

## Design

### Phase 1: Bug Fix (standalone, ship first)

Fix the immediate persistence bug without any structural changes.

**File: `src/core/App.ts`**

In `onRemoveModel` callback (lines 100-103), add cleanup:
```
onRemoveModel: (id) => {
  this.modelManager.removeModel(id);
  this.modelTreePanel.removeModel(id);
  this.loadedFiles.delete(id);                    // ← NEW
  this.sessionStore.removeFile(id);               // ← NEW (method exists, never called)
  this.scheduleSave();                            // ← NEW (persist updated fileNames)
},
```

In `restoreSession()` (lines 262-288), filter IndexedDB files against session state:
```
const validNames = new Set(session?.fileNames ?? []);
const filesToRestore = validNames.size > 0
  ? files.filter(f => validNames.has(f.name))
  : files;  // fallback for old sessions without fileNames
```

In `scheduleSave()` (line 251), add a guard so the timer callback re-checks the flag:
```
this.saveTimer = setTimeout(() => {
  this.saveTimer = null;
  if (!this.sessionStore.isMemoryEnabled()) return;  // ← NEW: re-check after delay
  this.sessionStore.saveSession({ ... });
}, 1000);
```

---

### Phase 2: Unified Model Registry (`ModelRecord` + UUID identity)

Replace the 4-way fragmented state with a single authoritative model registry.

#### New data model

```typescript
type ModelSource =
  | { type: 'local'; fileName: string }
  | { type: 'remote'; url: string; fileName: string };

interface ModelRecord {
  id: string;                // crypto.randomUUID(), stable across session
  name: string;              // display name (the filename)
  source: ModelSource;       // how this model was loaded
  addedAt: number;           // Date.now()
  sizeBytes: number;         // buffer size in bytes
  hasCachedBuffer: boolean;  // whether IndexedDB has the buffer
}

interface SessionState {
  camera?: CameraState;
  models: ModelRecord[];     // replaces fileNames: string[]
}
```

#### Why UUIDs

- Two files named `model.ifc` from different sources get different IDs
- Remote models carry their URL in `source.url`
- The filename becomes purely a display label, not an identity key

#### IndexedDB v1 → v2 migration (`SessionStore.ts`)

- Bump `DB_VERSION` to 2
- `onupgradeneeded`: read old `files` store records → create new `models` store with `keyPath: 'id'` → migrate records with generated UUIDs → delete old store
- Simultaneously migrate localStorage `fileNames[]` → `ModelRecord[]` by matching names to migrated IDs
- New methods: `saveModel(id, name, buffer)`, `getModel(id)`, `getAllModels()`, `removeModel(id)`

#### App.ts changes

- Replace `loadedFiles = Map<string, ArrayBuffer>` with `modelRecords = Map<string, ModelRecord>`
- `handleFile()` and `handleRemoteLoad()` generate UUID, create `ModelRecord`
- `onRemoveModel`: `modelRecords.delete(id)` + `sessionStore.removeModel(id)` + `scheduleSave()`
- `scheduleSave()` and `beforeunload` serialize `models: Array.from(modelRecords.values())`

#### Restore behavior (silent auto-restore)

- **Local model, buffer in IndexedDB**: auto-parse and render. Transparent to user.
- **Local model, buffer missing** (browser data cleared): show model row with `⚠ filename.ifc (missing)` and a **Re-upload** button.
- **Remote model**: re-fetch from stored URL. If URL unreachable, fall back to cached buffer. If both fail, show error state with **Retry** button.

#### File-parsing queue (fix concurrency)

Add a simple sequential queue to `App.ts` so file parsing never interleaves:

```typescript
private parseQueue = Promise.resolve();

private enqueueFile(file: LoadedFile): Promise<void> {
  this.parseQueue = this.parseQueue.then(() => this.handleFile(file));
  return this.parseQueue;
}
```

All load entry points (`fileLoader.onLoad`, `handleRemoteLoad`, `restoreSession`) go through the queue.

---

### Phase 3: Export/Import `.ifcproject` Files

#### Dependency

`fflate` — zero-dep zip library, ~8KB gzipped. Dynamically imported (`import('fflate')`) so it's only loaded when actually used.

#### New file: `src/services/ProjectExporter.ts`

**Export format:** `.ifcproject` file (a zip) containing:
```
manifest.json          — { version: 1, exportedAt, camera, models: ModelRecord[] }
buffers/<id>.ifc       — raw IFC data for each LOCAL model
```

Remote models: only the URL is stored in the manifest. No buffer in the zip (avoids bloat, respects source-of-truth).

IFC files are text-based STEP format — DEFLATE compresses them ~5-10x.

**Export flow:**
1. Build manifest from current `modelRecords` + camera state
2. For each local model, fetch buffer from IndexedDB (via `bufferCache` or `sessionStore.getModel`)
3. Zip with `fflate.zipSync` (or async for large files)
4. Show status message during compression for large projects
5. Trigger browser download as `project-<timestamp>.ifcproject`

**Import flow:**
1. Detect `.ifcproject` extension in FileLoader or App.ts
2. Unzip with `fflate.unzipSync`
3. Validate manifest: check `version` field, required fields, known source types
4. For each local model:
   - Extract buffer from `buffers/<id>.ifc`
   - Verify `buffer.byteLength` matches `sizeBytes` in manifest (detect truncation/corruption)
   - If buffer missing or corrupt: skip with warning, continue importing the rest
   - Parse and add to scene
5. For remote models: re-fetch from URL; if fetch fails, show warning state with retry button (same as session restore)
6. Restore camera state
7. Empty project (no models) is valid — clears scene, restores camera only

#### Robustness

| Concern | Handling |
|---------|----------|
| Manifest version | `version: 1` field enables future format changes without breaking old imports |
| Buffer integrity | Verify `buffer.byteLength === manifest.sizeBytes` on import; skip corrupt entries |
| Partial failure | If one model fails to extract/parse, skip it with a status warning and continue with the rest |
| Invalid zip | Catch `fflate.unzipSync` errors; show user-friendly error message, leave current scene intact |
| Corrupt manifest | Validate JSON parse + required fields before touching the scene |
| Empty project | Valid — exports camera state even with no models; import clears scene |
| Large projects | Show status message during export compression; `fflate` handles streaming internally |

#### UI placement

Project-level action bar **above the model tree panel**, visually separated from per-model controls. The `?` help button moves from top-left down to **bottom-left next to the cookie icon**, freeing space for Import/Export.

```
┌─────────────────────────┐
│  Import ↑    Export ↓    │  ← project actions bar (new, top-left)
├─────────────────────────┤
│  Models          + ☁ ◀  │  ← existing model tree header
│  ☑ building.ifc    ×    │
│  ☑ ☁ site.ifc      ×   │
│  ...                     │
└─────────────────────────┘

              ┌────┐
Bottom-left:  │ 🍪 ? │  ← cookie icon + help button (? moved here)
              └────┘
```

- **Import button (↑)**: opens file picker filtered to `.ifcproject`. Also supported via drag-drop on the existing drop zone (auto-detect by extension).
- **Export button (↓)**: downloads `.ifcproject` file. Disabled when no models are loaded.
- **? button**: relocates from top-left to bottom-left, next to the existing cookie/settings icon.
- Both project buttons are small, icon+label style, same visual treatment as the existing toolbar.

#### Files to modify (UI relocation)

| File | Change |
|------|--------|
| `src/ui/HelpOverlay.ts` | Move `?` button mount point from top-left to bottom-left (next to footer) |
| `src/styles.css` | Restyle `?` button position; add project action bar styles |

#### Files to modify

| File | Change |
|------|--------|
| `src/services/ProjectExporter.ts` | **New** — export/import logic with validation |
| `src/core/App.ts` | Wire up export/import methods, route `.ifcproject` from FileLoader |
| `src/ui/ModelTreePanel.ts` | Add project action bar above model list |
| `src/loader/FileLoader.ts` | Accept `.ifcproject` extension, emit separate event |
| `package.json` | Add `fflate` dependency |

---

### Phase 4: Robustness Improvements (alongside phases 1-3)

These are folded into the implementation, not separate tasks:

| Issue | Fix | Where |
|-------|-----|-------|
| Race: toggle vs auto-save | Re-check `isMemoryEnabled()` inside timer callback | App.ts `scheduleSave()` |
| No callback error handling | Wrap ModelTreePanel callback invocations in try-catch | ModelTreePanel.ts |
| Concurrent parsing | Sequential parse queue in App.ts | App.ts (new `enqueueFile`) |
| Silent error swallowing | Add `console.warn` in SessionStore catch blocks; show status bar message on persistent failures | SessionStore.ts |
| Duplicate file detection | Check `modelRecords` for matching name before adding; reject with status message "already loaded" | App.ts `handleFile()` |
| Missing content validation | Add IFC header signature check (`ISO-10303-21`) in FileLoader, same as RemoteLoader | FileLoader.ts |
| Unhandled rejections | Add `.catch()` on `start()` in main.ts; wrap async event callbacks | main.ts, App.ts |

---

### Phase 5: Tests

| Test file | Covers |
|-----------|--------|
| `tests/session-store.test.ts` | v1→v2 migration, saveModel/removeModel, orphan cleanup, toggle+save race |
| `tests/project-exporter.test.ts` (new) | Round-trip export/import, remote-only models have no buffer, corrupt zip handling |
| `tests/app-persistence.test.ts` (new) | Remove model cleans up all stores, restore filters against session, parse queue ordering |

---

## Browser Limitation

The File API does **not** expose local filesystem paths (security restriction). For local models, we store:
- The **filename** (e.g., `building.ifc`) as a display label
- The **raw file buffer** in IndexedDB (survives page reload, not browser data clear)

We cannot show "loaded from C:\Users\...\building.ifc" — the browser doesn't give us that information.

---

## Implementation Order

```
Phase 1 (bug fix)              → no dependencies, ship immediately
Phase 2 (ModelRecord + UUID)   → depends on Phase 1
Phase 3 (export/import)        → depends on Phase 2, adds fflate
Phase 4 (robustness)           → folded into phases 1-3
Phase 5 (tests)                → written alongside each phase
```

Each phase is independently shippable and testable.

---

## Files to Modify

| File | Phases | Change |
|------|--------|--------|
| `src/core/App.ts` | 1,2,3,4 | Fix remove, ModelRecord registry, parse queue, export/import wiring |
| `src/services/SessionStore.ts` | 1,2,4 | Filter restore, new types/methods, IndexedDB v2 migration, error logging |
| `src/ui/ModelTreePanel.ts` | 2,3,4 | Source badges, warning states, export button, callback error handling |
| `src/services/ProjectExporter.ts` | 3 | **New** — export/import logic |
| `src/loader/FileLoader.ts` | 3,4 | Detect `.ifcproject` extension, IFC header validation |
| `src/main.ts` | 4 | Add `.catch()` on `app.start()` |
| `package.json` | 3 | Add `fflate` dependency |

---

## Success Criteria

Each phase has its own pass/fail criteria. A phase is complete only when **all** its criteria pass.

### Phase 1 — Bug Fix

| # | Test | How to verify | Pass condition |
|---|------|--------------|----------------|
| 1.1 | Remove persists across refresh | Load 3 models → remove 1 → refresh page | Only 2 models restore. The removed model does not reappear. |
| 1.2 | IndexedDB is clean after remove | Load model → remove it → inspect IndexedDB in DevTools (Application → IndexedDB → ifcviewer → files) | No entry for the removed model. |
| 1.3 | Add after remove works | Load A → remove A → load B → refresh | Only B restores. A does not reappear. |
| 1.4 | Toggle off cancels pending saves | Load model → move camera → toggle persistence OFF immediately → toggle ON → refresh | No models restore (session was cleared and no stale save wrote data back). |
| 1.5 | Existing tests pass | `npx vitest run` | All green, no regressions. |

### Phase 2 — Model Registry

| # | Test | How to verify | Pass condition |
|---|------|--------------|----------------|
| 2.1 | Remote URL remembered | Load a remote model via URL → refresh | Model re-fetches from the same URL (visible in Network tab). No "upload file" prompt. |
| 2.2 | Local model auto-restores | Load a local .ifc file → refresh | Model renders immediately without user action. |
| 2.3 | Missing buffer shows warning | Load local model → clear IndexedDB manually in DevTools → refresh | Model row appears with warning icon and Re-upload button. No crash. |
| 2.4 | Duplicate name rejected | Drop `model.ifc` → drop a different `model.ifc` | Second load is rejected with status message "model.ifc is already loaded". Scene unchanged. |
| 2.5 | Concurrent drops don't corrupt | Select 5+ .ifc files and drop them all at once | All models load sequentially without parser errors. Model count in tree matches file count. |
| 2.6 | v1 → v2 migration | Load models with Phase 1 code → deploy Phase 2 code → refresh | Old models restore correctly. No data loss. IndexedDB shows v2 schema. |
| 2.7 | Callback error doesn't break UI | (Dev-only) Temporarily throw in a ModelTreePanel callback → trigger it | Error is caught, logged to console. UI remains functional. Other models unaffected. |
| 2.8 | Existing tests pass | `npx vitest run` | All green, no regressions. |

### Phase 3 — Export/Import

| # | Test | How to verify | Pass condition |
|---|------|--------------|----------------|
| 3.1 | Export produces valid file | Load 2 local + 1 remote model → click Export | Browser downloads a `.ifcproject` file. File is a valid zip containing `manifest.json` + `buffers/` directory. |
| 3.2 | Import restores full state | Export a project → close tab → open fresh tab → drag-drop the `.ifcproject` file | All local models render. Remote model re-fetches from URL. Camera position matches export state. |
| 3.3 | Remote models are URL-only in export | Export project with a remote model → unzip and inspect `manifest.json` | Remote model has `source.type === 'remote'` with URL. No buffer file in `buffers/` for it. |
| 3.4 | Import replaces current session | Load model A → import a project containing model B | Model A is gone. Only model B (and other project models) are present. |
| 3.5 | Corrupt zip handling | Drag-drop a renamed `.txt` file as `.ifcproject` | User sees an error message. No crash. Existing models unaffected. |
| 3.6 | Corrupt manifest handling | Zip with invalid JSON as `manifest.json` → import | User sees "Invalid project file" error. Current scene unchanged. |
| 3.7 | Partial buffer failure | Zip with valid manifest but one missing buffer file → import | Models with buffers load normally. Missing model shows warning row. No crash. |
| 3.8 | Buffer size mismatch | Zip with truncated buffer (size doesn't match manifest `sizeBytes`) → import | Truncated model is skipped with warning. Other models load fine. |
| 3.9 | Empty project round-trip | No models loaded → export → import in new tab | Scene is cleared. Camera restores. No errors. |
| 3.10 | Export button disabled when empty | No models loaded | Export button is visually disabled and non-clickable. |
| 3.11 | Import via file picker | Click Import button → select `.ifcproject` file | Same result as drag-drop import. |
| 3.12 | UI placement | Open the app | Export/Import buttons appear above the model tree. `?` help button is at bottom-left next to cookie icon. Top-left corner is clean. |
| 3.13 | Round-trip fidelity | Export → import → export again → compare manifests | Model records (names, sources, order) are identical. Camera state matches. |
| 3.14 | Existing tests pass | `npx vitest run` | All green, no regressions. |

### Cross-cutting (all phases)

| # | Test | Pass condition |
|---|------|----------------|
| X.1 | No unhandled promise rejections | Open browser console, exercise all load/remove/export/import flows → no `Unhandled Promise Rejection` errors. |
| X.2 | Memory toggle respects user choice | With persistence OFF: load models, refresh → blank slate. No models restore. |
| X.3 | Type checking | `npx tsc --noEmit` passes with no errors. |
| X.4 | Bundle size | `fflate` is dynamically imported — not in the initial bundle. Verify with `npx vite build` + check chunk sizes. |
