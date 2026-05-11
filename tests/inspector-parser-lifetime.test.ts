import { describe, it, expect } from 'vitest';
// Vite raw imports — get the source text as a string without parsing the file.
import parserSrc from '../src/parser/IfcParser.ts?raw';
import appSrc from '../src/core/App.ts?raw';
import type { ParsedModel } from '../src/parser/IfcParser';

describe('IfcParser model lifetime change (Phase 1 enabler)', () => {
  it('parser source does NOT close the model after parse', () => {
    // CloseModel is now owned by App. Confirming it isn't called from the
    // parser means property queries remain valid after parse().
    expect(parserSrc).not.toMatch(/this\.api\.CloseModel\(/);
  });

  it('parser exposes the IfcAPI so App can route the modelID through queries', () => {
    // The api is declared on the class (public) so the repository can call
    // `parser.api.CloseModel(...)` and the inspector repository can call
    // `parser.api.properties.*`. We assert the field exists in source.
    expect(parserSrc).toMatch(/api:\s*WebIFC\.IfcAPI\s*\|\s*null/);
  });

  it('ParsedModel type carries modelID alongside id and meshes', () => {
    // Compile-time check: the shape includes modelID. If this stops type-
    // checking, the export contract has regressed.
    const sample: ParsedModel = {
      id: 'x',
      modelID: 42,
      meshes: [],
    };
    expect(sample.modelID).toBe(42);
  });
});

describe('App model lifetime wiring (Phase 1 enabler)', () => {
  it('declares a modelIdMap keyed by App UUID', () => {
    expect(appSrc).toMatch(/modelIdMap\s*=\s*new\s+Map<string,\s*number>/);
  });

  it('populates modelIdMap on parse', () => {
    expect(appSrc).toMatch(/modelIdMap\.set\(/);
  });

  it('routes onRemoveModel through closeWebIfcModel', () => {
    // The remove callback calls closeWebIfcModel before tearing down anything else.
    const onRemove = appSrc.match(/onRemoveModel:\s*\(id\)\s*=>\s*\{[\s\S]*?\},/);
    expect(onRemove).not.toBeNull();
    expect(onRemove![0]).toMatch(/closeWebIfcModel\(id\)/);
  });

  it('resetView closes every model before re-parsing', () => {
    const reset = appSrc.match(/private async resetView\(\)[\s\S]*?\n\s{2}\}/);
    expect(reset).not.toBeNull();
    expect(reset![0]).toMatch(/closeWebIfcModel\(id\)/);
  });

  it('dispose closes any still-open models before parser.dispose()', () => {
    const dispose = appSrc.match(/dispose\(\): void \{[\s\S]*?\n\s{2}\}/);
    expect(dispose).not.toBeNull();
    expect(dispose![0]).toMatch(/closeWebIfcModel\(id\)/);
    // closeWebIfcModel must come BEFORE parser.dispose(), otherwise the
    // WASM heap is gone before we get a chance to clean up.
    const closeIdx = dispose![0].indexOf('closeWebIfcModel');
    const parserDisposeIdx = dispose![0].indexOf('this.parser.dispose()');
    expect(closeIdx).toBeGreaterThan(-1);
    expect(parserDisposeIdx).toBeGreaterThan(closeIdx);
  });
});
