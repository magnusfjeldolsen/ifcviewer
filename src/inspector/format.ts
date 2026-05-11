/**
 * Value formatting and unit resolution for the Element Properties Inspector.
 *
 * Pure functions, no I/O. web-ifc returns IFC values as typed wrappers
 * `{ type: <numeric typecode>, value: <raw> }`. The job here is to:
 *   1. Decide whether the value carries an implicit measure (length, area, …).
 *   2. Resolve that measure to a unit suffix using the model's
 *      `IfcUnitAssignment`.
 *   3. Render the value as a display string (without the unit).
 *
 * The unit is kept in a separate column (Flat view) / pill (Tree view) so
 * downstream features (aggregation, filtering, calculated fields) can read
 * the raw numeric without re-parsing the display string.
 */

import {
  IFCAREAMEASURE,
  IFCBOOLEAN,
  IFCCOUNTMEASURE,
  IFCIDENTIFIER,
  IFCINTEGER,
  IFCLABEL,
  IFCLENGTHMEASURE,
  IFCLOGICAL,
  IFCMASSMEASURE,
  IFCNORMALISEDRATIOMEASURE,
  IFCNUMERICMEASURE,
  IFCPLANEANGLEMEASURE,
  IFCPOSITIVELENGTHMEASURE,
  IFCPOSITIVERATIOMEASURE,
  IFCRATIOMEASURE,
  IFCREAL,
  IFCTEXT,
  IFCTIMEMEASURE,
  IFCVOLUMEMEASURE,
} from 'web-ifc';

// ---------------------------------------------------------------------------
// Measure classification
// ---------------------------------------------------------------------------

/**
 * Logical measure categories. Mapped from the IFC type code so we can look
 * up a unit suffix in the model's IfcUnitAssignment without doing a giant
 * `switch` at every call site.
 */
export type MeasureKind =
  | 'length'
  | 'area'
  | 'volume'
  | 'mass'
  | 'time'
  | 'angle'
  | 'count'
  | 'ratio'
  | 'numeric'
  | 'real'
  | 'integer'
  | 'boolean'
  | 'logical'
  | 'string';

/** Map a web-ifc typed-wrapper `type` code to a logical measure kind. */
export function measureKindForType(typeCode: number): MeasureKind {
  switch (typeCode) {
    case IFCLENGTHMEASURE:
    case IFCPOSITIVELENGTHMEASURE:
      return 'length';
    case IFCAREAMEASURE:
      return 'area';
    case IFCVOLUMEMEASURE:
      return 'volume';
    case IFCMASSMEASURE:
      return 'mass';
    case IFCTIMEMEASURE:
      return 'time';
    case IFCPLANEANGLEMEASURE:
      return 'angle';
    case IFCCOUNTMEASURE:
      return 'count';
    case IFCRATIOMEASURE:
    case IFCPOSITIVERATIOMEASURE:
    case IFCNORMALISEDRATIOMEASURE:
      return 'ratio';
    case IFCNUMERICMEASURE:
      return 'numeric';
    case IFCREAL:
      return 'real';
    case IFCINTEGER:
      return 'integer';
    case IFCBOOLEAN:
      return 'boolean';
    case IFCLOGICAL:
      return 'logical';
    case IFCLABEL:
    case IFCIDENTIFIER:
    case IFCTEXT:
      return 'string';
    default:
      // Unknown typecode — treat as string so we still render something.
      return 'string';
  }
}

// ---------------------------------------------------------------------------
// Unit resolution
// ---------------------------------------------------------------------------

/**
 * Resolved per-model unit table, keyed by MeasureKind. Built once per model
 * from `IfcProject.UnitsInContext` and cached by the repository.
 */
export type UnitTable = ReadonlyMap<MeasureKind, string>;

/**
 * Default fallback unit suffixes when the model's IfcUnitAssignment doesn't
 * cover a particular measure. Bare empty string means "no unit suffix" —
 * e.g. ratios are dimensionless.
 */
export const DEFAULT_UNITS: Readonly<Record<MeasureKind, string>> = {
  length: 'm',
  area: 'm²',
  volume: 'm³',
  mass: 'kg',
  time: 's',
  angle: 'rad',
  count: '',
  ratio: '',
  numeric: '',
  real: '',
  integer: '',
  boolean: '',
  logical: '',
  string: '',
};

/**
 * Map an IFC `IfcUnitEnum` literal (web-ifc returns these as plain strings
 * like "LENGTHUNIT") to our MeasureKind.
 */
const UNIT_ENUM_TO_KIND: Readonly<Record<string, MeasureKind>> = {
  LENGTHUNIT: 'length',
  AREAUNIT: 'area',
  VOLUMEUNIT: 'volume',
  MASSUNIT: 'mass',
  TIMEUNIT: 'time',
  PLANEANGLEUNIT: 'angle',
};

/**
 * SI prefix → multiplier symbol. The IFC schema uses `IfcSIPrefix` enum
 * literals ("MILLI", "CENTI", …).
 */
const SI_PREFIX_SYMBOL: Readonly<Record<string, string>> = {
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

/**
 * SI unit name → base unit symbol.
 * (Only the ones IFC building data realistically uses.)
 */
const SI_UNIT_SYMBOL: Readonly<Record<string, string>> = {
  METRE: 'm',
  GRAM: 'g',
  SECOND: 's',
  RADIAN: 'rad',
  STERADIAN: 'sr',
  KELVIN: 'K',
  AMPERE: 'A',
  MOLE: 'mol',
  CANDELA: 'cd',
  HERTZ: 'Hz',
  NEWTON: 'N',
  PASCAL: 'Pa',
  JOULE: 'J',
  WATT: 'W',
  VOLT: 'V',
  OHM: 'Ω',
  // Derived "named" SI units we might see:
  SQUARE_METRE: 'm²',
  CUBIC_METRE: 'm³',
};

/**
 * Lightweight IfcUnitAssignment shape — the subset we care about. The
 * concrete fetcher (in WebIfcPropertyRepository) flattens web-ifc's
 * `getItemProperties(unitAssignmentId, recursive)` output into this.
 */
export interface RawUnitEntry {
  /** IfcUnitEnum literal, e.g. "LENGTHUNIT". */
  unitType: string;
  /** IfcSIUnit only: prefix literal (may be null). */
  siPrefix?: string | null;
  /** IfcSIUnit only: name literal, e.g. "METRE". */
  siName?: string | null;
  /** IfcConversionBasedUnit / user-defined: literal label, e.g. "INCH". */
  conversionLabel?: string | null;
}

/**
 * Resolve a single raw unit entry into a display suffix.
 * Returns empty string if nothing meaningful can be derived (caller can
 * then fall back to the default).
 */
export function resolveUnitSymbol(entry: RawUnitEntry): string {
  if (entry.conversionLabel) return entry.conversionLabel;

  const base = entry.siName ? SI_UNIT_SYMBOL[entry.siName] ?? '' : '';
  if (!base) return '';

  // Area / volume base units come in as METRE — apply exponent from the
  // unit type so we render m² / m³ instead of bare m.
  let baseWithExponent = base;
  if (entry.unitType === 'AREAUNIT' && base === 'm') baseWithExponent = 'm²';
  else if (entry.unitType === 'VOLUMEUNIT' && base === 'm') baseWithExponent = 'm³';

  const prefix = entry.siPrefix ? SI_PREFIX_SYMBOL[entry.siPrefix] ?? '' : '';

  // Apply prefix to the base symbol part (before the exponent). For
  // areas / volumes this gives "mm²" / "mm³" as conventional notation,
  // accepting that strictly "mm²" means "(mm)²" — which matches the
  // physical reality of an area unit on a millimetre length system.
  if (prefix && baseWithExponent.startsWith(base)) {
    return prefix + baseWithExponent;
  }
  return prefix + baseWithExponent;
}

/**
 * Build a per-MeasureKind unit lookup table from the raw entries read out
 * of `IfcProject.UnitsInContext.Units`.
 */
export function buildUnitTable(entries: readonly RawUnitEntry[]): UnitTable {
  const table = new Map<MeasureKind, string>();
  for (const entry of entries) {
    const kind = UNIT_ENUM_TO_KIND[entry.unitType];
    if (!kind) continue;
    const symbol = resolveUnitSymbol(entry);
    if (symbol) table.set(kind, symbol);
  }
  return table;
}

/** Look up the resolved unit suffix for a value, with sensible fallback. */
export function unitSuffixForType(typeCode: number, table: UnitTable | null): string {
  const kind = measureKindForType(typeCode);
  if (table) {
    const fromTable = table.get(kind);
    if (fromTable !== undefined) return fromTable;
  }
  return DEFAULT_UNITS[kind];
}

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

/**
 * Format the raw value portion of a typed wrapper as a display string.
 * Numeric values keep modest precision (up to 6 significant digits with
 * trailing-zero trim); booleans render as "true"/"false"; null / undefined
 * render as empty string (the panel decides whether to show "—").
 */
export function formatRawValue(typeCode: number, value: unknown): string {
  if (value === null || value === undefined) return '';
  const kind = measureKindForType(typeCode);

  if (kind === 'boolean' || kind === 'logical') {
    if (value === 'T' || value === 'TRUE' || value === true) return 'true';
    if (value === 'F' || value === 'FALSE' || value === false) return 'false';
    if (value === 'U' || value === 'UNKNOWN') return 'unknown';
    return String(value);
  }

  if (typeof value === 'number') return formatNumber(value);

  // Strings, identifiers, labels, enums fall through.
  return String(value);
}

/**
 * Format a number for display. Up to 6 significant digits; trailing zeros
 * trimmed; integers rendered without a decimal point.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toString();
  // toPrecision(6) covers typical building-data ranges without scientific
  // notation creep at human scales.
  const fixed = n.toPrecision(6);
  // toPrecision can emit scientific notation for very large / small;
  // in that case fall through; otherwise trim trailing zeros after the dot.
  if (fixed.includes('e') || fixed.includes('E')) return fixed;
  return fixed.replace(/\.?0+$/, '');
}
