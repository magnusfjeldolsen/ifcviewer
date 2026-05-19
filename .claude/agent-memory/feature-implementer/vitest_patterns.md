---
name: Vitest patterns
description: Test idioms used in this IFC viewer project
type: project
---

- **DOM-dependent tests** use `// @vitest-environment jsdom` directive at the top of the file. Default env is `node`.
- **Mocking the IFC engine:** web-ifc is heavy (WASM) and slow to init. Don't instantiate `IfcAPI` in unit tests. Instead, define a minimal `PropertyApi`-style interface on the consumer and pass a `vi.fn()`-driven fake.
- **Source-text assertions:** For wiring invariants that are hard to exercise through behaviour (e.g. "this function calls X before Y"), use Vite raw imports — `import src from '../src/path/File.ts?raw'` gives you the file as a string. Then `expect(src).toMatch(/.../)` or substring index ordering. This avoids needing `@types/node` (not installed) for `node:fs` reads.
- **No fixture IFC files:** there's no `tests/fixtures/` directory and `public/` has no sample `.ifc`. Repository tests should mock the web-ifc API surface, not load real models.
- **Test commands:**
  - `npm test` — one-shot full suite (vitest run)
  - `npm run test:watch` — watch mode
  - `npm run lint` — ESLint
  - `npm run typecheck` — tsc --noEmit
  - `npm run build` — full build (tsc + vite build); good final check before handoff

Run all three (`test`, `lint`, `typecheck`) before any handoff. Build also reasonable but slower.
