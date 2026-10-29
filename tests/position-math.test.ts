import { describe, it, expect } from 'vitest';
import {
  coordinatesAsText,
  formatCoordinates,
  sceneToModel,
  unitsPerMetre,
} from '../src/tools/positionMath';

describe('sceneToModel', () => {
  it('reads the scene Y as height and the negated scene Z as northing', () => {
    // web-ifc stands the model up: IFC (x, y, z) arrives as scene (x, z, -y).
    expect(sceneToModel({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: -3, z: 2 });
  });

  it('undoes the web-ifc rotation exactly', () => {
    const ifc = { x: 598123.4, y: 6643210.9, z: 12.5 };
    const scene = { x: ifc.x, y: ifc.z, z: -ifc.y };
    expect(sceneToModel(scene)).toEqual(ifc);
  });

  it('reports 0, not -0, for a point on the axis', () => {
    expect(Object.is(sceneToModel({ x: 0, y: 0, z: 0 }).y, 0)).toBe(true);
  });
});

describe('unitsPerMetre', () => {
  it.each([
    ['m', 1],
    ['dm', 10],
    ['cm', 100],
    ['mm', 1000],
    ['km', 0.001],
  ])('%s → %d per metre', (symbol, factor) => {
    expect(unitsPerMetre(symbol)).toBe(factor);
  });

  it('refuses to guess a conversion-based unit', () => {
    expect(unitsPerMetre('FOOT')).toBeNull();
    expect(unitsPerMetre('')).toBeNull();
  });
});

describe('formatCoordinates', () => {
  const point = { x: 12.3456, y: -4.5, z: 0.0004 };

  it('shows metres to the millimetre', () => {
    expect(formatCoordinates(point, 'm').map((l) => l.text)).toEqual([
      '12.346 m',
      '-4.500 m',
      '0.000 m',
    ]);
  });

  it('converts to millimetres for a millimetre model', () => {
    expect(formatCoordinates(point, 'mm').map((l) => l.text)).toEqual([
      '12346 mm',
      '-4500 mm',
      '0 mm',
    ]);
  });

  it('falls back to metres, with the unit saying so, for an unknown unit', () => {
    expect(formatCoordinates(point, 'FOOT')[0].text).toBe('12.346 m');
  });

  it('never shows a negative zero', () => {
    expect(formatCoordinates({ x: -0.0001, y: 0, z: 0 }, 'm')[0].value).toBe('0.000');
  });

  it('labels the axes X, Y, Z in order', () => {
    expect(formatCoordinates(point, 'm').map((l) => l.axis)).toEqual(['X', 'Y', 'Z']);
  });
});

describe('coordinatesAsText', () => {
  it('is one "axis = value unit" line per axis, for pasting', () => {
    const text = coordinatesAsText(formatCoordinates({ x: 1, y: 2, z: 3 }, 'mm'));
    expect(text).toBe('X = 1000 mm\nY = 2000 mm\nZ = 3000 mm');
  });
});
