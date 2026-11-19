/**
 * Value formatting for the Element Properties Inspector.
 *
 * Pure functions, no I/O. web-ifc returns IFC values as typed wrappers
 * `{ type: <numeric typecode>, value: <raw> }`. The job here is to decide
 * what kind of value a wrapper holds (a boolean, a number, text) and render
 * it as a display string, without its unit.
 *
 * Units are `units.ts`. The unit is kept in a separate column (Flat view) /
 * pill (Tree view) so downstream features (aggregation, filtering,
 * calculated fields) can read the raw numeric without re-parsing the display
 * string.
 */

import {
  IFCAREAMEASURE,
  IFCBOOLEAN,
  IFCCOUNTMEASURE,
  IFCFORCEMEASURE,
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
} from './ifcTypeCodes';

// ---------------------------------------------------------------------------
// Measure classification
// ---------------------------------------------------------------------------

/**
 * Logical measure categories, mapped from the IFC type code: what decides
 * how a value is coerced and formatted. (Which unit a measure is in is
 * `units.ts`, by the measure's name, and covers every measure.)
 */
export type MeasureKind =
  | 'length'
  | 'area'
  | 'volume'
  | 'mass'
  | 'force'
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
    case IFCFORCEMEASURE:
      return 'force';
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
      // Any other code: formatted by the JavaScript type of its value, so a
      // number in a measure not listed here still shows as a number.
      return 'string';
  }
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
