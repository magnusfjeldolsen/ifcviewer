/**
 * Units: what unit a value is in, as the model states it (#67).
 *
 * The one home for unit handling. Everything else asks this module and gets
 * back a {@link UnitRef}: a short symbol to show ("mm", "ft", "W/(m²·K)") and
 * a **unit key** that says which unit it is. Two values are in the same unit
 * exactly when their keys are equal; nothing compares symbols.
 *
 * The policy, from the owner (18 Nov 2026), and see docs/adr/0004:
 *
 *  - **Use the units the model states.** No conversion. A value is shown and
 *    added up in the unit its model gives it.
 *  - **A unit set on a property or quantity wins** over the project's unit
 *    assignment for that measure.
 *  - **Nothing is invented.** When a value is a measure (a length, a
 *    thermal transmittance) and the model names no unit for it, its unit is
 *    "not stated", not metres.
 *  - **Refuse to add up across units.** {@link canSum} says whether a
 *    parameter's values can be added up and, if not, why.
 *
 * Unit keys (stable strings, safe to compare across models):
 *
 *  - `""`                no unit applies: text, yes/no, counts, ratios, plain
 *                        numbers ({@link NO_UNIT})
 *  - `"?LENGTHUNIT"`     a measure whose unit the model does not state; the
 *                        IFC unit type follows the `?`
 *  - `"si:mm"`           an SI unit, by its symbol (SI symbols are unique)
 *  - `"conv:foot*0.3048 si:m"`  a conversion-based unit: its name, its factor
 *                        and the unit the factor is in. Two models that both
 *                        say "foot" with the same factor agree; a "foot" with
 *                        a different factor is a different unit.
 *  - `"der:si:kN^1 si:m^-2"`    a derived unit: its elements' keys and
 *                        exponents, sorted
 *  - `"ctx:<name>"`, `"cur:<currency>"`  context-dependent and monetary units
 *
 * Equal units written differently (millimetres as an SI unit and as a
 * conversion of the metre) get different keys, so they are refused rather
 * than added. A small converter could later map keys to SI and lift that.
 *
 * Pure and DOM-free: the worker imports it.
 */

import {
  IFCCONTEXTDEPENDENTUNIT,
  IFCCONVERSIONBASEDUNIT,
  IFCCONVERSIONBASEDUNITWITHOFFSET,
  IFCDERIVEDUNIT,
  IFCMONETARYUNIT,
  IFCSIUNIT,
} from './ifcTypeCodes';
import type { ParameterKind } from './types';

/** A unit as shown and compared. */
export interface UnitRef {
  /** Identifies the unit: equal keys, same unit. See the module comment. */
  key: string;
  /** Short symbol to show after a number; empty when there is none to show. */
  symbol: string;
}

/** A unit and how many values in a scope are in it. */
export interface UnitCount extends UnitRef {
  count: number;
}

/** No unit applies (text, yes/no, a count, a ratio, a plain number). */
export const NO_UNIT: UnitRef = Object.freeze({ key: '', symbol: '' });

/** The key for a measure of IFC unit type `unitType` whose unit the model does not state. */
export function notStatedKey(unitType: string): string {
  return `?${unitType}`;
}

/** True for a key that says the model did not state the unit. */
export function isNotStated(key: string): boolean {
  return key.startsWith('?');
}

/** Reads one STEP line with every reference resolved (`GetLine(id, true)`). */
export type ReadLine = (expressId: number) => unknown;

// ---------------------------------------------------------------------------
// Which unit type a measure is in
// ---------------------------------------------------------------------------

/** Measures whose name does not spell their unit type. */
const MEASURE_ALIASES: Readonly<Record<string, string>> = {
  POSITIVELENGTH: 'LENGTH',
  NONNEGATIVELENGTH: 'LENGTH',
  POSITIVEPLANEANGLE: 'PLANEANGLE',
  THERMALCONDUCTIVITY: 'THERMALCONDUCTANCE',
};

/** Measures that are pure numbers: no unit applies. */
const DIMENSIONLESS = new Set([
  'COUNT',
  'RATIO',
  'POSITIVERATIO',
  'NORMALISEDRATIO',
  'NUMERIC',
  'PARAMETERVALUE',
  'PH',
  'DESCRIPTIVE',
  'COMPOUNDPLANEANGLE',
]);

/**
 * The IFC unit type (`IfcUnitEnum` / `IfcDerivedUnitEnum` literal) a value of
 * measure `measure` (e.g. `"IFCLENGTHMEASURE"`) is in, or null when no unit
 * applies (labels, text, booleans, plain numbers, counts, ratios).
 *
 * IFC names its measures after their unit types (`IfcThermalTransmittance
 * Measure` ↔ `THERMALTRANSMITTANCEUNIT`), so any measure is covered, not just
 * a list of known ones; the few that differ are aliased.
 */
export function unitTypeOfMeasure(measure: string | undefined): string | null {
  if (!measure) return null;
  const m = measure.toUpperCase();
  if (!m.startsWith('IFC') || !m.endsWith('MEASURE')) return null;
  const base = m.slice(3, -'MEASURE'.length);
  if (base === '' || DIMENSIONLESS.has(base)) return null;
  return `${MEASURE_ALIASES[base] ?? base}UNIT`;
}

// ---------------------------------------------------------------------------
// Reading a unit line
// ---------------------------------------------------------------------------

const SI_PREFIX: Readonly<Record<string, string>> = {
  EXA: 'E',
  PETA: 'P',
  TERA: 'T',
  GIGA: 'G',
  MEGA: 'M',
  KILO: 'k',
  HECTO: 'h',
  DECA: 'da',
  DECI: 'd',
  CENTI: 'c',
  MILLI: 'm',
  MICRO: 'µ',
  NANO: 'n',
  PICO: 'p',
  FEMTO: 'f',
  ATTO: 'a',
};

const SI_NAME: Readonly<Record<string, string>> = {
  METRE: 'm',
  SQUARE_METRE: 'm²',
  CUBIC_METRE: 'm³',
  GRAM: 'g',
  SECOND: 's',
  AMPERE: 'A',
  KELVIN: 'K',
  DEGREE_CELSIUS: '°C',
  MOLE: 'mol',
  CANDELA: 'cd',
  RADIAN: 'rad',
  STERADIAN: 'sr',
  HERTZ: 'Hz',
  NEWTON: 'N',
  PASCAL: 'Pa',
  JOULE: 'J',
  WATT: 'W',
  COULOMB: 'C',
  VOLT: 'V',
  FARAD: 'F',
  OHM: 'Ω',
  SIEMENS: 'S',
  WEBER: 'Wb',
  TESLA: 'T',
  HENRY: 'H',
  LUMEN: 'lm',
  LUX: 'lx',
  BECQUEREL: 'Bq',
  GRAY: 'Gy',
  SIEVERT: 'Sv',
};

/**
 * Dimensions of the SI units, as exponents of
 * [length, mass, time, current, temperature, amount, luminous intensity],
 * with the gram counted as a thousandth of the coherent kilogram.
 */
type Dim = readonly [number, number, number, number, number, number, number];
const SI_DIM: Readonly<Record<string, Dim>> = {
  METRE: [1, 0, 0, 0, 0, 0, 0],
  SQUARE_METRE: [2, 0, 0, 0, 0, 0, 0],
  CUBIC_METRE: [3, 0, 0, 0, 0, 0, 0],
  GRAM: [0, 1, 0, 0, 0, 0, 0],
  SECOND: [0, 0, 1, 0, 0, 0, 0],
  AMPERE: [0, 0, 0, 1, 0, 0, 0],
  KELVIN: [0, 0, 0, 0, 1, 0, 0],
  MOLE: [0, 0, 0, 0, 0, 1, 0],
  CANDELA: [0, 0, 0, 0, 0, 0, 1],
  RADIAN: [0, 0, 0, 0, 0, 0, 0],
  HERTZ: [0, 0, -1, 0, 0, 0, 0],
  NEWTON: [1, 1, -2, 0, 0, 0, 0],
  PASCAL: [-1, 1, -2, 0, 0, 0, 0],
  JOULE: [2, 1, -2, 0, 0, 0, 0],
  WATT: [2, 1, -3, 0, 0, 0, 0],
};

/**
 * The conventional symbol of a derived unit type, when the model writes it
 * in coherent SI units (no prefixes but the kilogram's): `kg·K⁻¹·s⁻³` for a
 * thermal transmittance is shown as `W/(m²·K)`. Used only when the dimensions
 * check out; anything else is written out from its elements.
 */
const COHERENT_DERIVED: Readonly<Record<string, { symbol: string; dim: Dim }>> = {
  THERMALTRANSMITTANCEUNIT: { symbol: 'W/(m²·K)', dim: [0, 1, -3, 0, -1, 0, 0] },
  THERMALCONDUCTANCEUNIT: { symbol: 'W/(m·K)', dim: [1, 1, -3, 0, -1, 0, 0] },
  THERMALRESISTANCEUNIT: { symbol: 'm²·K/W', dim: [0, -1, 3, 0, 1, 0, 0] },
  HEATFLUXDENSITYUNIT: { symbol: 'W/m²', dim: [0, 1, -3, 0, 0, 0, 0] },
  SPECIFICHEATCAPACITYUNIT: { symbol: 'J/(kg·K)', dim: [2, 0, -2, 0, -1, 0, 0] },
  MASSDENSITYUNIT: { symbol: 'kg/m³', dim: [-3, 1, 0, 0, 0, 0, 0] },
  AREADENSITYUNIT: { symbol: 'kg/m²', dim: [-2, 1, 0, 0, 0, 0, 0] },
  MASSPERLENGTHUNIT: { symbol: 'kg/m', dim: [-1, 1, 0, 0, 0, 0, 0] },
  MASSFLOWRATEUNIT: { symbol: 'kg/s', dim: [0, 1, -1, 0, 0, 0, 0] },
  LINEARFORCEUNIT: { symbol: 'N/m', dim: [0, 1, -2, 0, 0, 0, 0] },
  LINEARSTIFFNESSUNIT: { symbol: 'N/m', dim: [0, 1, -2, 0, 0, 0, 0] },
  PLANARFORCEUNIT: { symbol: 'N/m²', dim: [-1, 1, -2, 0, 0, 0, 0] },
  MODULUSOFELASTICITYUNIT: { symbol: 'N/m²', dim: [-1, 1, -2, 0, 0, 0, 0] },
  SHEARMODULUSUNIT: { symbol: 'N/m²', dim: [-1, 1, -2, 0, 0, 0, 0] },
  TORQUEUNIT: { symbol: 'N·m', dim: [2, 1, -2, 0, 0, 0, 0] },
  LINEARMOMENTUNIT: { symbol: 'N·m/m', dim: [1, 1, -2, 0, 0, 0, 0] },
  LINEARVELOCITYUNIT: { symbol: 'm/s', dim: [1, 0, -1, 0, 0, 0, 0] },
  VOLUMETRICFLOWRATEUNIT: { symbol: 'm³/s', dim: [3, 0, -1, 0, 0, 0, 0] },
  MOMENTOFINERTIAUNIT: { symbol: 'm⁴', dim: [4, 0, 0, 0, 0, 0, 0] },
  SECTIONMODULUSUNIT: { symbol: 'm³', dim: [3, 0, 0, 0, 0, 0, 0] },
};

/** Symbols of conversion-based units, by lower-case name with single spaces. */
const CONVERSION_SYMBOL: Readonly<Record<string, string>> = {
  inch: 'in',
  foot: 'ft',
  feet: 'ft',
  yard: 'yd',
  mile: 'mi',
  'square inch': 'in²',
  'square foot': 'ft²',
  'square feet': 'ft²',
  'square yard': 'yd²',
  'square mile': 'mi²',
  acre: 'ac',
  'cubic inch': 'in³',
  'cubic foot': 'ft³',
  'cubic feet': 'ft³',
  'cubic yard': 'yd³',
  litre: 'L',
  liter: 'L',
  gallon: 'gal',
  'gallon us': 'gal',
  degree: '°',
  grad: 'gon',
  gon: 'gon',
  hour: 'h',
  day: 'd',
  week: 'wk',
  year: 'yr',
  pound: 'lb',
  'pound force': 'lbf',
  'pound-force': 'lbf',
  ounce: 'oz',
  kip: 'kip',
  ton: 'ton',
  tonne: 't',
  'metric ton': 't',
  psi: 'psi',
  fahrenheit: '°F',
  'degree fahrenheit': '°F',
  btu: 'Btu',
};

const SUPERSCRIPT: Readonly<Record<string, string>> = {
  '-': '⁻',
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
};

function superscript(n: number): string {
  return [...String(n)].map((c) => SUPERSCRIPT[c] ?? c).join('');
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** A web-ifc entity reference: `{ type: 5, value: <expressId> }`. */
function refId(v: unknown): number | undefined {
  return isObj(v) && v.type === 5 && typeof v.value === 'number' && v.value > 0 ? v.value : undefined;
}

/** A plain or wrapped (`{ value }` / `{ _representationValue }`) string. */
function text(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return undefined;
  const raw = '_representationValue' in v ? v._representationValue : v.value;
  return typeof raw === 'string' ? raw : undefined;
}

/** A plain or wrapped number. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (!isObj(v)) return undefined;
  const raw = '_representationValue' in v ? v._representationValue : v.value;
  return typeof raw === 'number' ? raw : undefined;
}

/** Lower case, single spaces: "SQUARE_FOOT" and "square  foot" are the same name. */
function normalName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

/** A factor written so that keys of the same factor agree: 12 significant digits. */
function factorText(n: number): string {
  return String(Number(n.toPrecision(12)));
}

/**
 * Read one line, or undefined when there is no reader or the line cannot be
 * read. Every read of a unit goes through here, so one broken line costs only
 * the unit it belongs to (which then reads as "not stated"), never the
 * model's other units or the element that uses it.
 */
function safeRead(readLine: ReadLine | undefined, id: number): unknown {
  if (!readLine) return undefined;
  try {
    return readLine(id);
  } catch {
    return undefined;
  }
}

/** A unit as read from its line, with the unit type it declares and its dimensions when SI. */
interface ReadUnit {
  ref: UnitRef;
  unitType: string | undefined;
  /** SI dimensions, when the unit is a plain or derived SI unit that is coherent. */
  coherentDim?: Dim;
}

/**
 * Read one unit line (IfcSIUnit, IfcConversionBasedUnit, IfcDerivedUnit,
 * IfcContextDependentUnit, IfcMonetaryUnit). `raw` is the line itself or a
 * reference to it; references are read with `readLine`. Null when it is not
 * a unit this understands, or cannot be read.
 */
function readUnitLine(raw: unknown, readLine: ReadLine | undefined, depth = 0): ReadUnit | null {
  if (depth > 4) return null;
  let line = raw;
  const id = refId(raw);
  if (id !== undefined) line = safeRead(readLine, id);
  if (!isObj(line)) return null;
  const unitType = text(line.UnitType);

  switch (line.type) {
    case IFCSIUNIT: {
      const name = text(line.Name);
      if (!name) return null;
      const prefix = text(line.Prefix);
      let base = SI_NAME[name] ?? name.toLowerCase();
      // A METRE declared as the area or volume unit means square / cubic metres.
      let dim = SI_DIM[name];
      if (name === 'METRE' && unitType === 'AREAUNIT') {
        base = 'm²';
        dim = SI_DIM.SQUARE_METRE;
      } else if (name === 'METRE' && unitType === 'VOLUMEUNIT') {
        base = 'm³';
        dim = SI_DIM.CUBIC_METRE;
      }
      const symbol = (prefix ? SI_PREFIX[prefix] ?? prefix.toLowerCase() : '') + base;
      const coherent = name === 'GRAM' ? prefix === 'KILO' : !prefix;
      return { ref: { key: `si:${symbol}`, symbol }, unitType, coherentDim: coherent ? dim : undefined };
    }

    case IFCCONVERSIONBASEDUNIT:
    case IFCCONVERSIONBASEDUNITWITHOFFSET: {
      const name = text(line.Name);
      if (!name) return null;
      const n = normalName(name);
      let symbol = CONVERSION_SYMBOL[n] ?? n;
      if (unitType === 'PLANEANGLEUNIT' && n === 'minute') symbol = '′';
      else if (unitType === 'PLANEANGLEUNIT' && n === 'second') symbol = '″';
      else if (n === 'minute') symbol = 'min';
      let key = `conv:${n}`;
      let factorLine: unknown = line.ConversionFactor;
      const factorId = refId(factorLine);
      if (factorId !== undefined) factorLine = safeRead(readLine, factorId);
      const factor = isObj(factorLine) ? factorLine : undefined;
      const value = factor ? num(factor.ValueComponent) : undefined;
      if (value !== undefined) {
        const of = factor ? readUnitLine(factor.UnitComponent, readLine, depth + 1) : null;
        key += `*${factorText(value)}${of ? ` ${of.ref.key}` : ''}`;
      }
      const offset = num(line.ConversionOffset);
      if (offset !== undefined && offset !== 0) key += `+${factorText(offset)}`;
      return { ref: { key, symbol }, unitType };
    }

    case IFCDERIVEDUNIT: {
      const elements = Array.isArray(line.Elements) ? line.Elements : [];
      const parts: { ref: UnitRef; exp: number; dim?: Dim }[] = [];
      for (const e of elements) {
        if (!isObj(e)) return null;
        let el: unknown = e;
        const eid = refId(e);
        if (eid !== undefined) el = safeRead(readLine, eid);
        if (!isObj(el)) return null;
        const exp = num(el.Exponent);
        const unit = readUnitLine(el.Unit, readLine, depth + 1);
        if (exp === undefined || !unit) return null;
        parts.push({ ref: unit.ref, exp, dim: unit.coherentDim });
      }
      if (parts.length === 0) return null;
      const derivedType = unitType === 'USERDEFINED' ? text(line.UserDefinedType) : unitType;
      const key = `der:${parts
        .map((p) => `${p.ref.key}^${p.exp}`)
        .sort()
        .join(' ')}`;
      return { ref: { key, symbol: derivedSymbol(derivedType, parts) }, unitType: derivedType };
    }

    case IFCCONTEXTDEPENDENTUNIT: {
      const name = text(line.Name);
      if (!name) return null;
      return { ref: { key: `ctx:${normalName(name)}`, symbol: name.trim() }, unitType };
    }

    case IFCMONETARYUNIT: {
      const currency = text(line.Currency);
      if (!currency) return null;
      return { ref: { key: `cur:${currency.trim().toUpperCase()}`, symbol: currency.trim() }, unitType: 'MONETARYUNIT' };
    }

    default:
      return null;
  }
}

/** The symbol of a derived unit: conventional when coherent SI, else written out (`kN/m²`). */
function derivedSymbol(unitType: string | undefined, parts: { ref: UnitRef; exp: number; dim?: Dim }[]): string {
  const known = unitType ? COHERENT_DERIVED[unitType] : undefined;
  if (known && parts.every((p) => p.dim)) {
    const dim = [0, 0, 0, 0, 0, 0, 0];
    for (const p of parts) for (let i = 0; i < 7; i++) dim[i] += p.dim![i] * p.exp;
    if (dim.every((d, i) => d === known.dim[i])) return known.symbol;
  }
  const factor = (p: { ref: UnitRef }, exp: number): string =>
    `${p.ref.symbol || '?'}${exp === 1 ? '' : superscript(exp)}`;
  const over = parts.filter((p) => p.exp > 0).map((p) => factor(p, p.exp));
  const under = parts.filter((p) => p.exp < 0).map((p) => factor(p, -p.exp));
  const top = over.length > 0 ? over.join('·') : '1';
  if (under.length === 0) return top;
  return `${top}/${under.length === 1 ? under[0] : `(${under.join('·')})`}`;
}

/** `readUnitLine` that never throws: a malformed line (a getter that throws, say) is no unit. */
function readUnitSafely(raw: unknown, readLine: ReadLine | undefined): ReadUnit | null {
  try {
    return readUnitLine(raw, readLine);
  } catch {
    return null;
  }
}

/** Read a unit line on its own, for tests and for whatever shows a single unit. */
export function readUnit(raw: unknown, readLine?: ReadLine): UnitRef | null {
  return readUnitSafely(raw, readLine)?.ref ?? null;
}

// ---------------------------------------------------------------------------
// A model's units
// ---------------------------------------------------------------------------

/**
 * One model's units: the project's unit assignment, plus the units set on
 * single properties and quantities, read once each. Built once per model in
 * the worker and passed to every property read.
 */
export class ModelUnits {
  /** Units set on properties, by the unit line's id: each is read once. */
  private own = new Map<number, UnitRef | null>();

  constructor(
    private readonly project: ReadonlyMap<string, UnitRef>,
    private readonly readLine?: ReadLine,
  ) {}

  /** A model that states no units at all. */
  static none(readLine?: ReadLine): ModelUnits {
    return new ModelUnits(new Map(), readLine);
  }

  /**
   * From `IfcProject.UnitsInContext.Units` (each a unit line or a reference
   * to one). A unit that cannot be read is left out, so its measures read
   * as "not stated".
   */
  static fromAssignment(units: readonly unknown[], readLine?: ReadLine): ModelUnits {
    const project = new Map<string, UnitRef>();
    for (const u of units) {
      const read = readUnitSafely(u, readLine);
      if (read?.unitType && !project.has(read.unitType)) project.set(read.unitType, read.ref);
    }
    return new ModelUnits(project, readLine);
  }

  /** The project's unit for an IFC unit type, e.g. `"LENGTHUNIT"`. */
  projectUnit(unitType: string): UnitRef | undefined {
    return this.project.get(unitType);
  }

  /**
   * The unit of a value of IFC measure `measure` (e.g. `"IFCLENGTHMEASURE"`),
   * given the property's own `Unit` attribute when it has one.
   */
  forMeasure(measure: string | undefined, own?: unknown): UnitRef {
    return this.forUnitType(unitTypeOfMeasure(measure), own);
  }

  /**
   * The unit of a value in IFC unit type `unitType` (null: no unit applies),
   * given the property's or quantity's own `Unit` attribute when it has one.
   * The property's own unit wins; then the project's; else "not stated".
   */
  forUnitType(unitType: string | null, own?: unknown): UnitRef {
    if (own !== undefined && own !== null) {
      const stated = this.ownUnit(own);
      if (stated) return stated;
      // A unit was set but cannot be read: say so rather than guess.
      return { key: notStatedKey(unitType ?? 'UNIT'), symbol: '' };
    }
    if (unitType === null) return NO_UNIT;
    return this.project.get(unitType) ?? { key: notStatedKey(unitType), symbol: '' };
  }

  private ownUnit(own: unknown): UnitRef | null {
    const id = refId(own) ?? (isObj(own) && typeof own.expressID === 'number' ? own.expressID : undefined);
    if (id !== undefined) {
      const cached = this.own.get(id);
      if (cached !== undefined) return cached;
    }
    const ref = readUnitSafely(own, this.readLine)?.ref ?? null;
    if (id !== undefined) this.own.set(id, ref);
    return ref;
  }
}

// ---------------------------------------------------------------------------
// Can it be added up?
// ---------------------------------------------------------------------------

/** Whether a parameter's values can be added up, and in what unit; or why not. */
export type SumVerdict =
  | {
      ok: true;
      /** The one unit every value is in (`NO_UNIT` for plain numbers). */
      unit: UnitRef;
      /** False when the model does not state the unit: the total is in an unnamed unit. */
      unitStated: boolean;
    }
  | {
      ok: false;
      reason: 'no-values' | 'not-numeric' | 'mixed-kinds' | 'mixed-units';
      /** For `mixed-units`: the units, most common first. */
      units?: UnitCount[];
    };

/**
 * Can the values of a parameter be added up? Yes when every value is a
 * number and all of them are in one unit. Numbers in different units are
 * refused, never converted (owner's decision, 18 Nov 2026).
 *
 * `units` are the units of the numeric values in the scope, as a
 * `ParameterSummary` carries them; pass the units of a sub-scope (from a
 * column) to ask about a selection.
 */
export function canSum(p: { kind: ParameterKind; units?: readonly UnitCount[] }): SumVerdict {
  if (p.kind === 'mixed') return { ok: false, reason: 'mixed-kinds' };
  if (p.kind !== 'numeric') return { ok: false, reason: 'not-numeric' };
  const units = (p.units ?? []).filter((u) => u.count > 0);
  if (units.length === 0) return { ok: false, reason: 'no-values' };
  if (units.length > 1) {
    return { ok: false, reason: 'mixed-units', units: [...units].sort((a, b) => b.count - a.count) };
  }
  const { key, symbol } = units[0];
  return { ok: true, unit: { key, symbol }, unitStated: !isNotStated(key) };
}

/** The symbol of a unit as a reader should see it: "unit not stated" when the model gives none. */
export function unitLabel(u: UnitRef): string {
  if (isNotStated(u.key)) return 'unit not stated';
  return u.symbol;
}

/** Why a parameter cannot be added up, in plain words; empty when it can. */
export function sumVerdictText(v: SumVerdict): string {
  if (v.ok) return '';
  switch (v.reason) {
    case 'no-values':
      return 'No values to add up';
    case 'not-numeric':
      return 'Not numbers, so they cannot be added up';
    case 'mixed-kinds':
      return 'Some values are numbers and some are not, so they cannot be added up';
    case 'mixed-units': {
      const list = (v.units ?? []).map((u) => `${unitLabel(u) || 'no unit'} on ${u.count}`).join(', ');
      return `Values are in different units (${list}), so they are not added up`;
    }
  }
}
