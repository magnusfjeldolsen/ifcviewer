# 2026-04-20 — Handoff: Project Persistence Phase 3 (Export/Import)

## Context

We're implementing a project persistence and export/import system across 3 phases. Phases 1 and 2 are committed and merged via PR. Phase 3 is code-complete but **uncommitted and untested by the user**.

**Branch:** `feature/project-persistence`  
**Base:** `main`  
**CLAUDE.md:** Follow the implementation procedure — tests must pass, user must manually test before PR.

## What's already done (committed)

| Commit | Phase | What |
|--------|-------|------|
| `656cd60` | Phase 1 | Fix removed models reappearing on refresh. `onRemoveModel` now cleans up `loadedFiles`, IndexedDB, and session state. |
| `0e28450` | Phase 2 | UUID-based `ModelRecord` registry replacing filename identity. Tracks source type (local/remote+URL). IndexedDB v2 migration. Sequential parse queue. Duplicate filename rejection. Cloud badge for remote models. Warning state for missing buffers. |

## What's in progress (uncommitted — Phase 3)

Phase 3 adds `.ifcproject` export/import. All code is written. Tests pass (104/104). `tsc --noEmit` is clean.

### Changed files

| File | Change |
|------|--------|
| `src/services/ProjectExporter.ts` | **New** — export (zip with manifest + local buffers) and import (unzip, validate, integrity checks) |
| `src/core/App.ts` | `exportProject()`, `triggerProjectImport()`, `importProject()` methods. `fileLoader.onProjectLoad` hook. Import via `ProjectExporter`. |
| `src/loader/FileLoader.ts` | Detects `.ifcproject` extension on drop, emits `onProjectLoad` event instead of `onLoad` |
| `src/ui/ModelTreePanel.ts` | Project action bar (Import/Export buttons) above model tree. Export disabled when no models. `onExportProject`/`onImportProject` callbacks. |
| `src/styles.css` | Project bar styles. `?` help button moved from `top:12px; left:12px` to `bottom:8px; left:46px` (next to cookie icon). Help overlay opens upward. |

### Export format (`.ifcproject`)

A zip file containing:
```
manifest.json          — { version: 1, exportedAt, camera, models: ModelRecord[] }
buffers/<uuid>.ifc     — raw IFC data for each LOCAL model only
```
Remote models: URL stored in manifest, no buffer in zip.

### Robustness built in

- Manifest version field for forward compat
- `sizeBytes` check on import (detect truncated buffers)
- Partial failure: if one model buffer is missing/corrupt, skip with warning, continue the rest
- Invalid zip or manifest: user-friendly error, current scene untouched
- `fflate` is already in `package.json` (was added earlier), dynamically imported

## What needs to happen next

### Step 1: Manual testing (user must do this)

Run the dev server (`npm run dev`) and test these scenarios:

| # | Test | Expected |
|---|------|----------|
| 1 | Load 1+ models, click Export | Downloads `.ifcproject` file |
| 2 | Click Import, pick the `.ifcproject` file | Scene clears, models restore, camera matches |
| 3 | Drag-drop `.ifcproject` onto drop zone | Same as #2 |
| 4 | Export → close tab → fresh tab → import | Full round-trip works |
| 5 | No models loaded | Export button is greyed out |
| 6 | Rename a `.txt` to `.ifcproject`, import it | Error message, scene untouched |
| 7 | Check UI layout | Import/Export above model tree. `?` at bottom-left next to cookie icon. |
| 8 | Remote model in export | Manifest has URL, no buffer in zip. On import, re-fetches from URL. |

### Step 2: Commit Phase 3

If manual testing passes:
```
git add src/services/ProjectExporter.ts src/core/App.ts src/loader/FileLoader.ts src/ui/ModelTreePanel.ts src/styles.css
git commit -m "Add project export/import with .ifcproject file format

Export creates a zip containing manifest + local IFC buffers. Import
validates manifest integrity, checks buffer sizes, and handles partial
failures gracefully. Remote models stored as URL-only. Import/Export
buttons added above model tree. Help button relocated to bottom-left.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

### Step 3: Push and PR

```
git push
```
Then update the existing PR or create a new one. The PR for Phases 1+2 was already created at `feature/project-persistence`.

### Step 4 (optional): Phase 4 robustness items not yet done

These were identified in the audit but deferred. They're nice-to-haves, not blockers:

| Item | Status |
|------|--------|
| IFC header validation in FileLoader | Not done — RemoteLoader validates, FileLoader does not |
| `.catch()` on `app.start()` in main.ts | Not done |
| Unhandled promise rejections in async event callbacks | Partially done (try-catch on ModelTreePanel callbacks) |

## Key files to read

- **Full plan:** `dev/plans/phase-project-persistence.md` — includes TL;DR, audit findings, all phases, success criteria
- **CLAUDE.md** — project conventions, implementation procedure, deferred state pattern
- **SessionStore types:** `src/services/SessionStore.ts` — `ModelRecord`, `ModelSource`, `SessionState`

## How to run

```bash
npm run dev          # dev server
npx tsc --noEmit     # type check
npx vitest run --config vitest.config.ts   # tests (note: --config flag required, vitest config resolution is flaky on this Windows machine)
```

## Vitest note

On this machine (Windows 11, Node v24.14.0, vitest 4.1.4), `npx vitest run` sometimes fails with `TypeError: Cannot read properties of undefined (reading 'config')`. This is a transient vitest config resolution issue. Fix: always pass `--config vitest.config.ts` explicitly.
