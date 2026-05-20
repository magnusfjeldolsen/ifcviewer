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
