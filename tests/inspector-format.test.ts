import { describe, it, expect } from 'vitest';
import {
  IFCAREAMEASURE,
  IFCBOOLEAN,
  IFCFORCEMEASURE,
  IFCINTEGER,
  IFCLABEL,
  IFCLENGTHMEASURE,
  IFCLOGICAL,
  IFCRATIOMEASURE,
  IFCREAL,
  IFCVOLUMEMEASURE,
} from 'web-ifc';
import { formatNumber, formatRawValue, measureKindForType } from '../src/inspector/format';

describe('measureKindForType', () => {
  it('maps length measure codes to "length"', () => {
    expect(measureKindForType(IFCLENGTHMEASURE)).toBe('length');
  });

  it('maps area measure to "area"', () => {
    expect(measureKindForType(IFCAREAMEASURE)).toBe('area');
  });

  it('maps volume measure to "volume"', () => {
    expect(measureKindForType(IFCVOLUMEMEASURE)).toBe('volume');
  });

  it('maps force measure to "force"', () => {
    expect(measureKindForType(IFCFORCEMEASURE)).toBe('force');
  });

  it('maps ratio types to "ratio"', () => {
    expect(measureKindForType(IFCRATIOMEASURE)).toBe('ratio');
  });

  it('maps boolean to "boolean"', () => {
    expect(measureKindForType(IFCBOOLEAN)).toBe('boolean');
  });

  it('maps logical to "logical"', () => {
    expect(measureKindForType(IFCLOGICAL)).toBe('logical');
  });

  it('maps real to "real"', () => {
    expect(measureKindForType(IFCREAL)).toBe('real');
  });

  it('maps integer to "integer"', () => {
    expect(measureKindForType(IFCINTEGER)).toBe('integer');
  });

  it('maps label to "string"', () => {
    expect(measureKindForType(IFCLABEL)).toBe('string');
  });

  it('falls back to "string" for unknown type codes', () => {
    expect(measureKindForType(0xdeadbeef)).toBe('string');
  });
});

// Units (symbols, unit types, the project's assignment) are tested in units.test.ts.

describe('formatNumber', () => {
  it('renders integers without decimal point', () => {
    expect(formatNumber(200)).toBe('200');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-42)).toBe('-42');
  });

  it('trims trailing zeros from decimals', () => {
    expect(formatNumber(3.10000)).toBe('3.1');
    expect(formatNumber(1.5)).toBe('1.5');
  });

  it('limits to 6 significant digits', () => {
    expect(formatNumber(1.2345678)).toBe('1.23457');
  });

  it('passes through non-finite values as their string form', () => {
    expect(formatNumber(NaN)).toBe('NaN');
    expect(formatNumber(Infinity)).toBe('Infinity');
  });
});

describe('formatRawValue', () => {
  it('formats a length number to a plain numeric string (unit is separate)', () => {
    expect(formatRawValue(IFCLENGTHMEASURE, 200)).toBe('200');
    expect(formatRawValue(IFCAREAMEASURE, 4.5)).toBe('4.5');
  });

  it('renders booleans as true / false', () => {
    expect(formatRawValue(IFCBOOLEAN, 'T')).toBe('true');
    expect(formatRawValue(IFCBOOLEAN, 'F')).toBe('false');
    expect(formatRawValue(IFCBOOLEAN, true)).toBe('true');
  });

  it('renders logical "unknown" as a third state', () => {
    expect(formatRawValue(IFCLOGICAL, 'U')).toBe('unknown');
  });

  it('passes through label strings unchanged', () => {
    expect(formatRawValue(IFCLABEL, 'Exterior Wall')).toBe('Exterior Wall');
  });

  it('renders null/undefined as empty string', () => {
    expect(formatRawValue(IFCLENGTHMEASURE, null)).toBe('');
    expect(formatRawValue(IFCLENGTHMEASURE, undefined)).toBe('');
  });
});
