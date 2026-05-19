---
name: ESLint quirks
description: Project-specific ESLint behaviours that bite when adding new code
type: project
---

The project uses `tseslint.configs.recommended` (default settings). Two things that catch new code:

1. **Underscore-prefixed args don't satisfy `no-unused-vars`.** The recommended config does NOT set `argsIgnorePattern: '^_'`. If you write `function foo(_modelId: string)`, ESLint will still flag it. Workaround: drop the underscore and add `void modelId;` in the body. This is the cleanest fix that doesn't change project-wide config.

2. **`async *` generators trip `require-yield`** when implemented as a stub that throws. Use `// eslint-disable-next-line require-yield` immediately above the function.

3. **Build runs `tsc --noEmit` first**, then `vite build`. So a type error blocks the bundle. The build command is the strictest gate.
