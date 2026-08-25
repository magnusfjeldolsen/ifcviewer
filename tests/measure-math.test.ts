/**
 * `formatDistance` — the D8 fragment carried into this step.
 *
 * The scene is already in metres (web-ifc bakes each file's length factor into
 * the mesh placement matrix), so there is no conversion to test — only the
 * display. The bug worth pinning: under a flat `toFixed(2)` a 3 mm gap
 * rendered as "0.00 m", and a measurement that confidently reports zero is
 * worse than one that refuses to answer.
 */
import { describe, it, expect } from 'vitest';
import { formatDistance } from '../src/tools/measureMath';

describe('formatDistance', () => {
  it('renders millimetres below one metre', () => {
    expect(formatDistance(0.003)).toBe('3 mm');
    expect(formatDistance(0.45)).toBe('450 mm');
    expect(formatDistance(0.999)).toBe('999 mm');
  });

  it('never renders a sub-metre gap as "0.00 m"', () => {
    for (const metres of [0.0005, 0.002, 0.019, 0.1]) {
      expect(formatDistance(metres)).not.toBe('0.00 m');
    }
  });

  it('renders metres at and above one metre, to two decimals', () => {
    expect(formatDistance(1)).toBe('1.00 m');
    expect(formatDistance(2.456)).toBe('2.46 m');
    expect(formatDistance(30.7)).toBe('30.70 m');
  });

  it('promotes a distance that rounds up to a whole metre', () => {
    // 0.9996 m is 999.6 mm; "1000 mm" reads as a unit mistake.
    expect(formatDistance(0.9996)).toBe('1.00 m');
  });

  it('renders zero as millimetres', () => {
    expect(formatDistance(0)).toBe('0 mm');
  });

  it('ignores sign — a distance has no direction', () => {
    expect(formatDistance(-2.5)).toBe('2.50 m');
  });
});
