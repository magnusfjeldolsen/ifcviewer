/**
 * Units (#67): which unit a value is in, as the model states it, how it is
 * shown, and whether a parameter's values can be added up.
 *
 * Unit lines here are shaped as web-ifc returns them with references
 * resolved (`GetLine(id, true)`): wrapped attribute values and numeric type
 * codes. units-fixture.test.ts runs the same rules through real web-ifc.
 */

import { describe, it, expect } from 'vitest';
import {
  IFCCONTEXTDEPENDENTUNIT,
  IFCCONVERSIONBASEDUNIT,
  IFCDERIVEDUNIT,
  IFCMONETARYUNIT,
  IFCSIUNIT,
} from '../src/inspector/ifcTypeCodes';
import {
  canSum,
  isNotStated,
  ModelUnits,
  NO_UNIT,
  readUnit,
  sumVerdictText,
  unitLabel,
  unitTypeOfMeasure,
} from '../src/inspector/units';

const e = (value: string) => ({ type: 3, value });
const label = (value: string) => ({ type: 1, value, name: 'IFCLABEL' });
const real = (v: number, name = 'IFCREAL') => ({ type: 4, _representationValue: v, _internalValue: String(v), name });

function si(unitType: string, name: string, prefix?: string, expressID?: number) {
  return { expressID, type: IFCSIUNIT, UnitType: e(unitType), Prefix: prefix ? e(prefix) : null, Name: e(name) };
}

function conversion(unitType: string, name: string, factor: number, of: unknown) {
  return {
    type: IFCCONVERSIONBASEDUNIT,
    UnitType: e(unitType),
    Name: label(name),
    ConversionFactor: { ValueComponent: real(factor, 'IFCLENGTHMEASURE'), UnitComponent: of },
  };
}

function derived(unitType: string, elements: [unknown, number][]) {
  return {
    type: IFCDERIVEDUNIT,
    UnitType: e(unitType),
    Elements: elements.map(([unit, exp]) => ({ Unit: unit, Exponent: exp })),
  };
}

describe('unitTypeOfMeasure', () => {
  it('names the unit type after the measure', () => {
    expect(unitTypeOfMeasure('IFCLENGTHMEASURE')).toBe('LENGTHUNIT');
    expect(unitTypeOfMeasure('IFCTHERMALTRANSMITTANCEMEASURE')).toBe('THERMALTRANSMITTANCEUNIT');
    expect(unitTypeOfMeasure('IFCPLANARFORCEMEASURE')).toBe('PLANARFORCEUNIT');
  });

  it('knows the measures whose names differ from their unit types', () => {
    expect(unitTypeOfMeasure('IFCPOSITIVELENGTHMEASURE')).toBe('LENGTHUNIT');
    expect(unitTypeOfMeasure('IFCNONNEGATIVELENGTHMEASURE')).toBe('LENGTHUNIT');
    expect(unitTypeOfMeasure('IFCPOSITIVEPLANEANGLEMEASURE')).toBe('PLANEANGLEUNIT');
    expect(unitTypeOfMeasure('IFCTHERMALCONDUCTIVITYMEASURE')).toBe('THERMALCONDUCTANCEUNIT');
  });

  it('gives no unit to text, plain numbers, counts and ratios', () => {
    for (const m of ['IFCLABEL', 'IFCTEXT', 'IFCBOOLEAN', 'IFCREAL', 'IFCINTEGER', 'IFCCOUNTMEASURE', 'IFCRATIOMEASURE', 'IFCNORMALISEDRATIOMEASURE', undefined]) {
      expect(unitTypeOfMeasure(m), String(m)).toBeNull();
    }
  });
});

describe('readUnit: symbols', () => {
  it('writes SI units with their prefix', () => {
    expect(readUnit(si('LENGTHUNIT', 'METRE', 'MILLI'))).toEqual({ key: 'si:mm', symbol: 'mm' });
    expect(readUnit(si('AREAUNIT', 'SQUARE_METRE'))).toEqual({ key: 'si:m²', symbol: 'm²' });
    expect(readUnit(si('VOLUMEUNIT', 'CUBIC_METRE', 'DECI'))?.symbol).toBe('dm³');
    expect(readUnit(si('MASSUNIT', 'GRAM', 'KILO'))?.symbol).toBe('kg');
    expect(readUnit(si('FORCEUNIT', 'NEWTON', 'KILO'))?.symbol).toBe('kN');
    expect(readUnit(si('THERMODYNAMICTEMPERATUREUNIT', 'DEGREE_CELSIUS'))?.symbol).toBe('°C');
  });

  it('reads a METRE declared as the area or volume unit as square or cubic metres', () => {
    expect(readUnit(si('AREAUNIT', 'METRE'))?.symbol).toBe('m²');
    expect(readUnit(si('VOLUMEUNIT', 'METRE', 'MILLI'))?.symbol).toBe('mm³');
  });

  it('gives conversion-based units their usual symbols, whatever the case or spacing', () => {
    const m = si('LENGTHUNIT', 'METRE');
    expect(readUnit(conversion('LENGTHUNIT', 'FOOT', 0.3048, m))?.symbol).toBe('ft');
    expect(readUnit(conversion('AREAUNIT', 'SQUARE FOOT', 0.0929, m))?.symbol).toBe('ft²');
    expect(readUnit(conversion('VOLUMEUNIT', 'cubic_foot', 0.0283, m))?.symbol).toBe('ft³');
    expect(readUnit(conversion('PLANEANGLEUNIT', 'DEGREE', 0.01745, si('PLANEANGLEUNIT', 'RADIAN')))?.symbol).toBe('°');
    expect(readUnit(conversion('LENGTHUNIT', 'inch', 0.0254, m))?.symbol).toBe('in');
  });

  it('shows an unknown conversion-based unit by its name in lower case', () => {
    expect(readUnit(conversion('LENGTHUNIT', 'CUBIT', 0.45, si('LENGTHUNIT', 'METRE')))?.symbol).toBe('cubit');
  });

  it('writes a derived unit out from its elements', () => {
    const kN = si('FORCEUNIT', 'NEWTON', 'KILO');
    const m = si('LENGTHUNIT', 'METRE');
    expect(readUnit(derived('PLANARFORCEUNIT', [[kN, 1], [m, -2]]))?.symbol).toBe('kN/m²');
  });

  it('gives a derived unit in coherent SI units its conventional symbol', () => {
    // How one sample model writes thermal transmittance: kg·K⁻¹·s⁻³.
    const kg = si('MASSUNIT', 'GRAM', 'KILO');
    const K = si('THERMODYNAMICTEMPERATUREUNIT', 'KELVIN');
    const s = si('TIMEUNIT', 'SECOND');
    expect(readUnit(derived('THERMALTRANSMITTANCEUNIT', [[kg, 1], [K, -1], [s, -3]]))?.symbol).toBe('W/(m²·K)');
    expect(readUnit(derived('MASSDENSITYUNIT', [[kg, 1], [si('LENGTHUNIT', 'METRE'), -3]]))?.symbol).toBe('kg/m³');
  });

  it('does not give the conventional symbol when the dimensions do not match', () => {
    const kg = si('MASSUNIT', 'GRAM', 'KILO');
    const s = si('TIMEUNIT', 'SECOND');
    expect(readUnit(derived('THERMALTRANSMITTANCEUNIT', [[kg, 1], [s, -3]]))?.symbol).toBe('kg/s³');
  });

  it('reads context-dependent and monetary units', () => {
    expect(readUnit({ type: IFCCONTEXTDEPENDENTUNIT, UnitType: e('USERDEFINED'), Name: label('Bags') })).toEqual({ key: 'ctx:bags', symbol: 'Bags' });
    expect(readUnit({ type: IFCMONETARYUNIT, Currency: label('NOK') })).toEqual({ key: 'cur:NOK', symbol: 'NOK' });
  });

  it('reads a referenced unit line through readLine', () => {
    const lines = new Map<number, unknown>([[23, si('LENGTHUNIT', 'METRE')]]);
    expect(readUnit({ type: 5, value: 23 }, (id) => lines.get(id))?.symbol).toBe('m');
    expect(readUnit({ type: 5, value: 23 })).toBeNull();
  });

  it('returns null for something that is not a unit', () => {
    expect(readUnit({ type: 12345, Name: label('x') })).toBeNull();
    expect(readUnit(null)).toBeNull();
  });
});

describe('readUnit: keys', () => {
  const m = si('LENGTHUNIT', 'METRE');

  it('the same unit declared twice has the same key', () => {
    expect(readUnit(si('LENGTHUNIT', 'METRE', 'MILLI'))?.key).toBe(readUnit(si('LENGTHUNIT', 'METRE', 'MILLI', 99))?.key);
    expect(readUnit(conversion('LENGTHUNIT', 'FOOT', 0.3048, m))?.key).toBe(
      readUnit(conversion('LENGTHUNIT', 'foot', 0.30480000000000002, m))?.key,
    );
  });

  it('a conversion with a different factor is a different unit', () => {
    expect(readUnit(conversion('LENGTHUNIT', 'FOOT', 0.3048, m))?.key).not.toBe(
      readUnit(conversion('LENGTHUNIT', 'FOOT', 0.3048006, m))?.key,
    );
  });

  it('a derived unit has the same key whatever order its elements are in', () => {
    const kN = si('FORCEUNIT', 'NEWTON', 'KILO');
    expect(readUnit(derived('PLANARFORCEUNIT', [[kN, 1], [m, -2]]))?.key).toBe(
      readUnit(derived('PLANARFORCEUNIT', [[m, -2], [kN, 1]]))?.key,
    );
  });
});

describe('ModelUnits', () => {
  const lines = new Map<number, unknown>([
    [23, si('LENGTHUNIT', 'METRE', undefined, 23)],
    [40, conversion('LENGTHUNIT', 'inch', 0.0254, si('LENGTHUNIT', 'METRE'))],
  ]);
  const units = ModelUnits.fromAssignment(
    [si('LENGTHUNIT', 'METRE', 'MILLI'), si('AREAUNIT', 'SQUARE_METRE')],
    (id) => lines.get(id),
  );

  it('uses the project unit for a measure', () => {
    expect(units.forMeasure('IFCLENGTHMEASURE')).toEqual({ key: 'si:mm', symbol: 'mm' });
    expect(units.forMeasure('IFCPOSITIVELENGTHMEASURE').symbol).toBe('mm');
    expect(units.forUnitType('AREAUNIT').symbol).toBe('m²');
  });

  it('a unit set on the property wins, whether a reference or already read', () => {
    expect(units.forMeasure('IFCLENGTHMEASURE', { type: 5, value: 23 })).toEqual({ key: 'si:m', symbol: 'm' });
    expect(units.forMeasure('IFCLENGTHMEASURE', lines.get(23))).toEqual({ key: 'si:m', symbol: 'm' });
    expect(units.forMeasure('IFCPOSITIVELENGTHMEASURE', { type: 5, value: 40 }).symbol).toBe('in');
  });

  it('says "not stated" for a measure the model gives no unit, instead of inventing one', () => {
    const time = units.forMeasure('IFCTIMEMEASURE');
    expect(time.key).toBe('?TIMEUNIT');
    expect(time.symbol).toBe('');
    expect(isNotStated(time.key)).toBe(true);
    expect(unitLabel(time)).toBe('unit not stated');
    expect(ModelUnits.none().forMeasure('IFCLENGTHMEASURE').key).toBe('?LENGTHUNIT');
  });

  it('a measure it does not list by name still finds its unit', () => {
    const kg = si('MASSUNIT', 'GRAM', 'KILO');
    const withU = ModelUnits.fromAssignment([
      derived('THERMALTRANSMITTANCEUNIT', [[kg, 1], [si('THERMODYNAMICTEMPERATUREUNIT', 'KELVIN'), -1], [si('TIMEUNIT', 'SECOND'), -3]]),
    ]);
    expect(withU.forMeasure('IFCTHERMALTRANSMITTANCEMEASURE').symbol).toBe('W/(m²·K)');
  });

  it('gives no unit to text and plain numbers', () => {
    expect(units.forMeasure('IFCLABEL')).toBe(NO_UNIT);
    expect(units.forMeasure('IFCREAL')).toBe(NO_UNIT);
  });

  it('a property unit that cannot be read is "not stated", not the project unit', () => {
    expect(units.forMeasure('IFCLENGTHMEASURE', { type: 5, value: 999 }).key).toBe('?LENGTHUNIT');
  });

  it('reads each unit set on properties once', () => {
    let reads = 0;
    const counted = ModelUnits.none((id) => {
      reads++;
      return lines.get(id);
    });
    counted.forMeasure('IFCLENGTHMEASURE', { type: 5, value: 23 });
    counted.forMeasure('IFCLENGTHMEASURE', { type: 5, value: 23 });
    expect(reads).toBe(1);
  });

  it('the first declaration of a unit type wins', () => {
    const twice = ModelUnits.fromAssignment([si('LENGTHUNIT', 'METRE', 'MILLI'), si('LENGTHUNIT', 'METRE')]);
    expect(twice.projectUnit('LENGTHUNIT')?.symbol).toBe('mm');
  });
});

describe('canSum', () => {
  const mm = { key: 'si:mm', symbol: 'mm' };
  const m = { key: 'si:m', symbol: 'm' };

  it('adds up numbers that are all in one unit', () => {
    expect(canSum({ kind: 'numeric', units: [{ ...mm, count: 12 }] })).toEqual({ ok: true, unit: mm, unitStated: true });
  });

  it('adds up plain numbers', () => {
    expect(canSum({ kind: 'numeric', units: [{ key: '', symbol: '', count: 3 }] })).toEqual({
      ok: true,
      unit: NO_UNIT,
      unitStated: true,
    });
  });

  it('adds up numbers in one unit the model does not state, and says so', () => {
    const v = canSum({ kind: 'numeric', units: [{ key: '?TIMEUNIT', symbol: '', count: 3 }] });
    expect(v).toMatchObject({ ok: true, unitStated: false });
  });

  it('refuses numbers in different units, saying which', () => {
    const v = canSum({ kind: 'numeric', units: [{ ...m, count: 2 }, { ...mm, count: 40 }] });
    expect(v).toEqual({ ok: false, reason: 'mixed-units', units: [{ ...mm, count: 40 }, { ...m, count: 2 }] });
    expect(sumVerdictText(v)).toBe('Values are in different units (mm on 40, m on 2), so they are not added up');
  });

  it('a length with no stated unit and one in mm are different units', () => {
    const v = canSum({ kind: 'numeric', units: [{ ...mm, count: 4 }, { key: '?LENGTHUNIT', symbol: '', count: 1 }] });
    expect(v.ok).toBe(false);
    expect(sumVerdictText(v)).toContain('unit not stated on 1');
  });

  it('refuses text, yes/no and a mix of numbers and text', () => {
    expect(canSum({ kind: 'text' })).toEqual({ ok: false, reason: 'not-numeric' });
    expect(canSum({ kind: 'boolean' })).toEqual({ ok: false, reason: 'not-numeric' });
    expect(canSum({ kind: 'mixed', units: [{ ...mm, count: 1 }] })).toEqual({ ok: false, reason: 'mixed-kinds' });
  });

  it('has nothing to add up without values', () => {
    expect(canSum({ kind: 'numeric', units: [] })).toEqual({ ok: false, reason: 'no-values' });
    expect(canSum({ kind: 'numeric', units: [{ ...mm, count: 0 }] })).toEqual({ ok: false, reason: 'no-values' });
  });
});
