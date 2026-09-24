# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-based IFC (Industry Foundation Classes) viewer that runs entirely client-side. No backend required. Users load .ifc files via upload/drag-drop, which are parsed and rendered in WebGL.

## Tech Stack

- **IFC parsing**: web-ifc (WASM-based, runs in browser)
- **Rendering**: Three.js
- **Bridge**: IFCLoader from IFC.js / That Open Engine
- **Frontend**: To be determined (vanilla JS or React)
- **Build**: Vite
- **Testing**: Vitest
- **Hosting**: GitHub Pages
- **CI/CD**: GitHub Actions

## Architecture Goals

- **Modular**: each feature (file loading, parsing, rendering, selection, metadata) is an independent module
- **Incremental**: start with minimal viewer, layer features on top
- **No backend**: everything runs in the browser
- **CI/CD first**: every push runs tests + lint; main branch auto-deploys to GitHub Pages

## CI/CD Pipeline

All feature work happens on feature branches. The pipeline enforces quality before anything reaches main:

1. **Feature branch** → push triggers: lint, type-check, test
2. **PR to main** → all checks must pass before merge
3. **Merge to main** → auto-build and deploy to GitHub Pages

This ensures main is always deployable and new features can't break the live site.

## Development Phases

1. **Green (basic viewer)**: Load IFC, render geometry, orbit controls
2. **Yellow (intermediate)**: Object selection, highlighting, tree view, property inspection
3. **Red (advanced)**: Large model performance, streaming, clash detection, section cuts, measurement

## Camera Ownership

Exactly one thing may drive the camera at a time, and `_controlsMode` in `src/viewer/Viewer.ts` says which:

- `'user'` — the render loop polls `controls.update()` every frame so OrbitControls can emit its `'change'` event.
- `'animating'` — a `CameraAnimator` tween owns the camera; the loop skips `controls.update()` so the two don't fight. Every exit path (complete **and** interrupt) must restore `'user'`, or the controls freeze.

`controls.target` is a **view anchor**, not a pivot. It is always a point on the camera's forward axis, which makes `camera.lookAt(target)` a permanent no-op and stops OrbitControls from re-orienting the camera behind your back. The orbit pivot is a separate field. See `src/viewer/orbitMath.ts`.

This section used to describe a "Deferred State Application" pattern: place a pivot, raise a flag to skip the render-loop update, and let the user's next gesture mask the resulting snap. It is gone, and the lesson is worth keeping — deferring a jarring visual consequence only moves it to the user's next gesture, where it still reads as the view lurching. Fix the state model that produces it instead. The pivot now lives outside `controls.target` precisely so there is nothing left to defer.

## Where work is tracked

**GitHub issues are the single source of truth for upcoming work.** There is no
roadmap file and no plan documents — both were retired on 2026-09-24 in favour
of issues, which are readable by humans who are not reading this repo's
markdown.

Issues are written in plain language: the title says what a user would notice
(*"Measurement labels get huge when you zoom in close"*), not what the code
does. Labels carry the rest — `performance`, `blocked`, `epic`, `measurement`,
`data-insight`, `sharing`, `mobile`.

### Reading a retired plan document

Around 30 source comments point at paths under `dev/plans/`. Those files no
longer exist on `main`; they were deleted at **`83c9c0f`** and every one of
them is still readable in history:

```
git show 83c9c0f:dev/plans/handoff-undo-redo.md
```

The comments are left pointing at the original paths on purpose — the path is
the archive key. Two plans never reached main and live on their own branches:
`plan/share-model-links` and `assess/mobile-tablet`.

## Branches

**One branch per issue, named `<issue-number>-<short-slug>`** — `58-share-button`.
The branch list is then a readable view of what is in flight, and a branch with
no issue behind it is a smell.

The repo has **"automatically delete head branches" enabled**. This is not
tidiness for its own sake: when a merged branch lingers, a PR stacked on top of
it has nothing to be retargeted to, so it silently merges into the stale branch
instead of `main`. That happened on 2026-09-24 — PR #54 merged into
`feature/provider-url-rules`, the hardening never reached `main`, and the live
site kept ignoring `#url=` links while every check looked green.

Work that is worth keeping but not worth merging gets an **`archive/*` tag**
rather than a branch that sits in the list forever:

```
git show archive/share-model-links:dev/plans/handoff-share-model-links.md
git show archive/mobile-tablet:dev/plans/assessment-mobile-tablet.md
git show archive/project-persistence:src/services/ProjectExporter.ts
```

## Implementation Procedure

Feature work runs through the `mattpocock-skills` pipeline, in this order:

1. **`/grill-with-docs`** — interrogate the idea against real documentation
   before committing to a shape.
2. **`/to-spec`** — turn the result into a spec.
3. **`/to-tickets`** — break the spec into issues.
4. **`/implement`** — build it, on a branch off `main` (`feature/<name>`).
5. **`/code-review`** — review before asking for a human.
6. **`/pr`** — open the PR.

Non-negotiables that sit on top of that pipeline:

- **Run the existing tests before writing any code**, so a pre-existing failure
  is never mistaken for one you caused.
- **Tests accompany the change**, not a follow-up PR.
- **CI must pass** before the PR is ready.
- **The user is the gate.** Ask for a manual test, and merge only after they
  approve. Never self-merge, and never bypass branch protection.

### Verify before you build on it

A claim about how the app behaves today gets checked **in the running app**
before anything is built on it. This rule was bought the hard way: in August
2026 a "unit bug" was diagnosed from two probes that agreed with each other
while both read the wrong data structure, a feature was built on it, and the
whole thing had to be reverted. Unit tests agreeing with each other is not
evidence about the running app.
