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

## Implementation Procedure

Every new feature follows this workflow:

1. Plan the implementation step
2. Create checklists to track progress
3. Branch off for feature development (`feature/<name>`)
4. Run existing tests before writing any code
5. Create/update tests as needed
6. Implement the feature
7. If all tests pass, ask the user to manually test
8. Create PR to main — CI must pass
9. Merge only after manual approval
