import { describe, it, expect } from 'vitest';
// Vite raw imports — get the source text as a string without parsing the file.
import workerSrc from '../src/parser/ifcWorker.ts?raw';
import appSrc from '../src/core/App.ts?raw';
import type { ParsedModel } from '../src/parser/types';

/**
 * Model-lifetime wiring tests, updated for `web-worker-parse`.
 *
 * Before: web-ifc lived on the main thread; `App` owned `CloseModel` and
 * a `modelIdMap`. Now the IFC worker owns ALL web-ifc state — every open
 * model, the numeric model ids, and the `CloseModel` call. The main
 * thread only ever sends/receives the app-UUID `id`.
 *
 * These tests guard the new invariants: the worker (not the main thread)
 * keeps models open and closes them; `App` routes teardown through the
 * worker; `ParsedModel` no longer carries a numeric `modelID`.
 */

describe('ifcWorker model lifetime (web-worker-parse)', () => {
  it('the worker keeps a model open after parse (CloseModel only on disposeModel)', () => {
    // The worker must NOT close a model inside the parse handler — the
    // STEP graph has to stay alive for later property queries. CloseModel
    // appears, but only in the disposeModel handler.
    expect(workerSrc).toMatch(/CloseModel/);
    const handleParse = workerSrc.match(/async function handleParse\([\s\S]*?\n\}/);
    expect(handleParse).not.toBeNull();
    expect(handleParse![0]).not.toMatch(/CloseModel/);
  });

  it('the worker owns the app-UUID -> numeric model id map', () => {
    expect(workerSrc).toMatch(/modelIds\s*=\s*new\s+Map<string,\s*number>/);
  });

  it('the worker disposes the whole IfcAPI on a dispose message', () => {
    const handleDispose = workerSrc.match(/function handleDispose\(\)[\s\S]*?\n\}/);
    expect(handleDispose).not.toBeNull();
    expect(handleDispose![0]).toMatch(/\.Dispose\(\)/);
  });
});

describe('App model lifetime wiring (web-worker-parse)', () => {
  it('no longer keeps a main-thread modelIdMap', () => {
    // The numeric model id moved into the worker — App must not track it.
    expect(appSrc).not.toMatch(/modelIdMap/);
  });

  it('routes onRemoveModel through the worker (disposeModel)', () => {
    const onRemove = appSrc.match(/onRemoveModel:\s*\(id\)\s*=>\s*\{[\s\S]*?\n {6}\},/);
    expect(onRemove).not.toBeNull();
    expect(onRemove![0]).toMatch(/disposeModel\(id\)/);
  });

  it('resetView closes every model in the worker before re-parsing', () => {
    const reset = appSrc.match(/private async resetView\(\)[\s\S]*?\n {2}\}/);
    expect(reset).not.toBeNull();
    expect(reset![0]).toMatch(/disposeModel\(id\)/);
  });

  it('dispose tears down the worker', () => {
    const dispose = appSrc.match(/dispose\(\): void \{[\s\S]*?\n {2}\}/);
    expect(dispose).not.toBeNull();
    expect(dispose![0]).toMatch(/this\.parser\.dispose\(\)/);
  });
});

describe('ParsedModel shape (web-worker-parse)', () => {
  it('carries id and meshes — the numeric modelID is gone (worker-owned)', () => {
    // Compile-time check: the shape is { id, meshes }. A numeric modelID
    // would be a type error here, since the worker owns numeric ids now.
    const sample: ParsedModel = {
      id: 'x',
      meshes: [],
    };
    expect(sample.id).toBe('x');
    expect(sample.meshes).toEqual([]);
  });
});

/**
 * Phase 1 of dev/plans/handoff-bulk-property-access.md — bulk intersect in
 * the worker. We can't black-box-execute the worker (web-ifc WASM is not
 * available in unit tests), but we CAN guard the invariants at the source
 * level: the handler exists, dispatches via the queue, uses the fold (not
 * the batch), chunks at 200, yields a macrotask between chunks, and
 * throttles progress. These are the architectural properties the rest of
 * the implementation rides on.
 */
describe('ifcWorker.handleIntersect (Phase 1 — bulk reduce)', () => {
  it('exists and is dispatched via the serial queue (like getProps)', () => {
    expect(workerSrc).toMatch(/async function handleIntersect\(/);
    // Dispatch case calls enqueue + handleIntersect with the standard
    // try/catch → error reply pattern.
    expect(workerSrc).toMatch(
      /case 'intersect':[\s\S]*?enqueue\([\s\S]*?handleIntersect\(/,
    );
  });

  it('uses the incremental fold, not the batch intersectProperties', () => {
    // The fold is what gives us O(1) memory in N. Importing the batch
    // would let an incremental call sneak in — guard against that.
    expect(workerSrc).toMatch(/intersectSeed/);
    expect(workerSrc).toMatch(/intersectStep/);
    expect(workerSrc).toMatch(/intersectFinalize/);
    // The batch wrapper is allowed to be imported nowhere in the worker
    // (it would materialize all inputs in memory).
    const importLines = workerSrc.match(/from\s+'[^']*intersection'/g) ?? [];
    for (const line of importLines) void line; // assertion below
    // Specifically: the symbol intersectProperties must not appear in
    // the worker source.
    expect(workerSrc).not.toMatch(/\bintersectProperties\b/);
  });

  it('chunks expressIds with a CHUNK constant (default 200)', () => {
    expect(workerSrc).toMatch(/INTERSECT_CHUNK\s*=\s*200/);
  });

  it('macrotask-yields between chunks (await setTimeout(0))', () => {
    // The fold body must yield a macrotask between chunks so progress
    // delivery (and, in Phase 2, cancel observation) can interleave.
    // We expect `await new Promise(... setTimeout(r, 0)`.
    expect(workerSrc).toMatch(/await\s+new\s+Promise[\s\S]*?setTimeout\(r,\s*0\)/);
  });

  it('throttles progress to ~10/sec via PROGRESS_MIN_INTERVAL_MS', () => {
    expect(workerSrc).toMatch(/PROGRESS_MIN_INTERVAL_MS\s*=\s*100/);
    expect(workerSrc).toMatch(/lastProgressAt/);
  });

  it('posts intersection (not props) on completion', () => {
    const fn = workerSrc.match(/async function handleIntersect\([\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/post\(\{\s*type:\s*'intersection'/);
  });

  it('reuses getOne — the single normalization path', () => {
    // getOne was extracted from handleGetProps; the bulk path reaches it
    // through readProps, so single and bulk reads normalize identically.
    expect(workerSrc).toMatch(/async function getOne\(/);
    const readPropsFn = workerSrc.match(/async function readProps\([\s\S]*?\n\}/);
    expect(readPropsFn).not.toBeNull();
    expect(readPropsFn![0]).toMatch(/getOne\(/);
    const intersectFn = workerSrc.match(/async function handleIntersect\([\s\S]*?\n\}/);
    expect(intersectFn![0]).toMatch(/readProps\(/);
  });

  it('handleGetProps still works — getOne extraction is behaviour-preserving', () => {
    // handleGetProps must still post `props` and must call getOne (the
    // shared extraction). Catches a regression where the extraction
    // accidentally changed handleGetProps semantics.
    const fn = workerSrc.match(/async function handleGetProps\([\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/getOne\(/);
    expect(fn![0]).toMatch(/post\(\{\s*type:\s*'props'/);
  });
});

/**
 * Phase 2 — cancellation, id enumeration and the value-match predicate.
 * Same constraint as above: web-ifc WASM can't run in unit tests, so the
 * invariants that would be expensive to get wrong are guarded at the source
 * level. The behaviour these protect is verified end-to-end in the proxy
 * tests (`worker-property-repository.test.ts`) and by manual smoke.
 */
describe('ifcWorker — Phase 2 bulk primitives', () => {
  /** The body of the `self.onmessage` dispatch switch. */
  const dispatch = (): string => {
    const m = workerSrc.match(/self\.onmessage[\s\S]*$/);
    expect(m).not.toBeNull();
    return m![0];
  };

  it('handles cancel OUTSIDE the queue', () => {
    // This is the crux: the job being cancelled sits at the head of the
    // serial queue, so an enqueued cancel could only run after that job
    // had already finished — i.e. never in time. If someone "tidies" this
    // case into an enqueue like its neighbours, cancellation silently
    // stops working with no test failure anywhere else.
    const caseBody = dispatch().match(/case 'cancel':[\s\S]*?break;/);
    expect(caseBody).not.toBeNull();
    expect(caseBody![0]).not.toMatch(/enqueue\(/);
    expect(caseBody![0]).toMatch(/markCancelled\(/);
  });

  it('registers bulk reqIds synchronously at dispatch, not when the job starts', () => {
    // A job queued behind a long-running one is exactly the case that most
    // needs cancelling, and it hasn't started yet — so `markPending` must
    // run in the switch, outside the enqueued callback.
    for (const type of ['intersect', 'findMatching']) {
      const caseBody = dispatch().match(new RegExp(`case '${type}':[\\s\\S]*?break;`));
      expect(caseBody).not.toBeNull();
      const beforeEnqueue = caseBody![0].split('enqueue(')[0];
      expect(beforeEnqueue).toMatch(/markPending\(/);
    }
  });

  it('readProps checks the cancel flag between chunks and reports incompletion', () => {
    const fn = workerSrc.match(/async function readProps\([\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/cancelled\.has\(reqId\)/);
    expect(fn![0]).toMatch(/return false/);
  });

  it('a cancelled bulk job posts no result', () => {
    // Committing a partial fold would be worse than silence: the panel
    // would render a "shared properties" result computed from a fraction
    // of the selection, indistinguishable from a real one.
    for (const name of ['handleIntersect', 'handleFindMatching']) {
      const fn = workerSrc.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`));
      expect(fn).not.toBeNull();
      expect(fn![0]).toMatch(/if\s*\(!completed\)\s*return;/);
    }
  });

  it('clears both bulk flags when a job settles, however it settles', () => {
    // Without the finally, a throwing job leaks its reqId into pendingBulk
    // and cancelled forever.
    const fn = workerSrc.match(/async function runBulk\([\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/finally\s*\{[\s\S]*?pendingBulk\.delete\(reqId\)/);
    expect(fn![0]).toMatch(/finally\s*\{[\s\S]*?cancelled\.delete\(reqId\)/);
  });

  it('enumerates all products via the IFCPRODUCT supertype, not a hand-listed set', () => {
    // A hand-maintained list of concrete product classes would rot as the
    // schema grows, and the rot would be invisible: fewer results, no error.
    const fn = workerSrc.match(/function candidateIds\([\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/WebIFC\.IFCPRODUCT/);
    expect(fn![0]).toMatch(/GetLineIDsWithType\(/);
  });

  it('never resolves a class NAME to a type code', () => {
    // web-ifc's GetTypeCodeFromName hashes its argument instead of looking
    // it up: 'IfcSlab' returns 200263316 while the real IFCSLAB is
    // 1529196076. It answers confidently for any string, including a
    // mis-cased or nonexistent class, so there is no error to catch — the
    // query just quietly targets the wrong type. Callers pass the numeric
    // ifcTypeCode read off the element instead.
    //
    // Matches the CALL form specifically — the source comments name the
    // function to explain why it must not come back.
    expect(workerSrc).not.toMatch(/\.GetTypeCodeFromName\(/);
  });

  it('findMatching runs the predicate in the worker and posts ids only', () => {
    const fn = workerSrc.match(/async function handleFindMatching\([\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/elementMatches\(/);
    expect(fn![0]).toMatch(/post\(\{\s*type:\s*'ids'/);
    // The whole point is that N property bags never cross the boundary.
    expect(fn![0]).not.toMatch(/type:\s*'props'/);
  });
});
