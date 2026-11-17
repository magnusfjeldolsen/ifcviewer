import { describe, it, expect } from 'vitest';
import * as WebIFC from 'web-ifc';
import { IFC_TYPE_CODES } from '../src/inspector/ifcTypeCodes';

describe('ifcTypeCodes', () => {
  it('has the same value as web-ifc for every constant', () => {
    const real = WebIFC as unknown as Record<string, number>;
    for (const [name, value] of Object.entries(IFC_TYPE_CODES)) {
      expect(value, name).toBe(real[name]);
    }
  });

  it('covers a non-trivial set of codes', () => {
    expect(Object.keys(IFC_TYPE_CODES).length).toBeGreaterThan(30);
  });
});
