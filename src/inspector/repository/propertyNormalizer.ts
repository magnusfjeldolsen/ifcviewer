/**
 * Pure normalization of raw web-ifc property/quantity/material objects
 * into our typed `PropertyNode` / `PropertyGroup` / `PropertyValue` shape.
 *
 * This module contains NO orchestration — every function is synchronous
 * and takes plain JS objects (as produced by `IfcAPI.properties.*`) plus
 * the model's `ModelUnits` for units. The async fetch coordination lives in
 * the IFC worker.
 *
 * Split out from `WebIfcPropertyRepository.ts` to keep the orchestration
 * file readable. No behavior change.
 */

import { IFC_TYPE_CODES } from '../ifcTypeCodes';
import {
  IFCBOOLEAN,
  IFCCOMPLEXPROPERTY,
  IFCLOGICAL,
  IFCMATERIAL,
  IFCPROPERTYBOUNDEDVALUE,
  IFCPROPERTYENUMERATEDVALUE,
  IFCPROPERTYLISTVALUE,
  IFCPROPERTYSINGLEVALUE,
  IFCPROPERTYTABLEVALUE,
  IFCQUANTITYAREA,
  IFCQUANTITYCOUNT,
  IFCQUANTITYLENGTH,
  IFCQUANTITYTIME,
  IFCQUANTITYVOLUME,
  IFCQUANTITYWEIGHT,
} from '../ifcTypeCodes';

import { formatRawValue, measureKindForType } from '../format';
import { NO_UNIT, type ModelUnits, type UnitRef } from '../units';
import type {
  ElementIdentity,
  PropertyGroup,
  PropertyNode,
  PropertySource,
  PropertyValue,
} from '../types';

// ---------------------------------------------------------------------------
// Typed-wrapper normalization
// ---------------------------------------------------------------------------

/**
 * Shape of a typed-wrapper value as returned by web-ifc. Loose because
 * web-ifc declares these as `any` in its TypeScript output.
 *
 * Two shapes show up in practice:
 *   - Old: `{ type: <IFC class typecode>, value: <raw> }` for enums/labels.
 *   - New: `{ type: <internal primitive code>, _representationValue: <raw>,
 *           _internalValue: <STEP literal>, name: "IFCFORCEMEASURE" }`
 *     for measure-wrapped numerics.
 * `normalizeTypedValue` converts both into a canonical `{ type, value }`
 * where `type` is the IFC class typecode (resolved via `name` when
 * needed).
 */
export interface TypedValue {
  type: number;
  value: unknown;
  /**
   * The IFC type name, upper case (`"IFCLENGTHMEASURE"`, `"IFCLABEL"`), when
   * known. What decides the value's unit: web-ifc's numeric `type` on a
   * measure is only a primitive code, so the name is the measure's identity.
   */
  measure?: string;
}

/** Map IFC measure class names → typecodes so the new-shape wrappers can
 *  feed `measureKindForType`. */
export const MEASURE_NAME_TO_TYPECODE: Readonly<Record<string, number>> = (() => {
  const w = IFC_TYPE_CODES;
  const out: Record<string, number> = {};
  for (const k of [
    'IFCLENGTHMEASURE',
    'IFCPOSITIVELENGTHMEASURE',
    'IFCAREAMEASURE',
    'IFCVOLUMEMEASURE',
    'IFCMASSMEASURE',
    'IFCFORCEMEASURE',
    'IFCTIMEMEASURE',
    'IFCPLANEANGLEMEASURE',
    'IFCCOUNTMEASURE',
    'IFCRATIOMEASURE',
    'IFCPOSITIVERATIOMEASURE',
    'IFCNORMALISEDRATIOMEASURE',
    'IFCNUMERICMEASURE',
    'IFCREAL',
    'IFCINTEGER',
    'IFCBOOLEAN',
    'IFCLOGICAL',
    'IFCLABEL',
    'IFCIDENTIFIER',
    'IFCTEXT',
  ]) {
    const v = w[k];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
})();

/** Normalize old + new web-ifc typed-wrapper shapes into a canonical
 *  `{ type, value }`. Returns null if `v` isn't a typed wrapper. */
export function normalizeTypedValue(v: unknown): TypedValue | null {
  if (typeof v !== 'object' || v === null) return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.type !== 'number') return null;
  const name = typeof obj.name === 'string' ? obj.name.toUpperCase() : null;
  // New shape: prefer the IFC class typecode resolved from the `name` string.
  if ('_representationValue' in obj || '_internalValue' in obj) {
    const fromName = name ? MEASURE_NAME_TO_TYPECODE[name] : undefined;
    return {
      type: typeof fromName === 'number' ? fromName : obj.type,
      value: '_representationValue' in obj ? obj._representationValue : obj._internalValue,
      measure: name ?? TYPECODE_TO_MEASURE.get(obj.type),
    };
  }
  // Old shape: must have a `value` key.
  if ('value' in obj) {
    return { type: obj.type, value: obj.value, measure: name ?? TYPECODE_TO_MEASURE.get(obj.type) };
  }
  return null;
}

/** The reverse of `MEASURE_NAME_TO_TYPECODE`, for wrappers that carry a class typecode but no name. */
const TYPECODE_TO_MEASURE: ReadonlyMap<number, string> = new Map(
  Object.entries(MEASURE_NAME_TO_TYPECODE).map(([name, code]) => [code, name]),
);

/**
 * Helper: read a typed-wrapper field, returning the raw `value` cast to
 * the desired primitive, or undefined if absent.
 */
export function readString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const norm = normalizeTypedValue(v);
  if (norm) {
    return norm.value === null || norm.value === undefined ? undefined : String(norm.value);
  }
  return String(v);
}

export function readNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const norm = normalizeTypedValue(v);
  if (norm) {
    return typeof norm.value === 'number' ? norm.value : undefined;
  }
  return typeof v === 'number' ? v : undefined;
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Read the `type` typecode stamped on a raw web-ifc line (when present). */
export function getRawTypeCode(obj: Record<string, unknown> | unknown): number | undefined {
  if (!isObj(obj)) return undefined;
  const t = obj.type;
  if (typeof t === 'number') return t;
  return undefined;
}

/** Strip the typed wrapper down to its raw JS primitive. */
function coerceSingleValue(tv: TypedValue): string | number | boolean | null {
  if (tv.value === null || tv.value === undefined) return null;
  const kind = measureKindForType(tv.type);
  if (kind === 'boolean' || kind === 'logical') {
    if (tv.value === 'T' || tv.value === true || tv.value === 'TRUE') return true;
    if (tv.value === 'F' || tv.value === false || tv.value === 'FALSE') return false;
    if (tv.type === IFCBOOLEAN || tv.type === IFCLOGICAL) return String(tv.value);
  }
  if (typeof tv.value === 'number' || typeof tv.value === 'string' || typeof tv.value === 'boolean') {
    return tv.value;
  }
  return String(tv.value);
}

// ---------------------------------------------------------------------------
// Raw-group typing
// ---------------------------------------------------------------------------

/**
 * One raw pset/qto line as returned by web-ifc, tagged with whether it
 * originated from the element's type rather than the element itself.
 */
export interface RawPropertyGroup {
  raw: Record<string, unknown>;
  inheritedFromType: boolean;
}

/** Recursively tag a PropertyNode tree as type-inherited (for nested complex props). */
export function markInheritedRecursively(node: PropertyNode): void {
  node.inheritedFromType = true;
  if (node.value.kind === 'complex') {
    for (const child of node.value.children) markInheritedRecursively(child);
  }
}

/**
 * Placeholder class name for a type code nothing could name. The real name
 * comes from web-ifc — see `src/parser/ifcClassNames.ts`.
 */
export function ifcClassFromTypeCode(typeCode: number): string {
  if (!typeCode) return 'IfcElement';
  return `IfcType_${typeCode}`;
}

// ---------------------------------------------------------------------------
// Quantity helpers
// ---------------------------------------------------------------------------

/** Map IFC quantity type code → which `*Value` field holds the number. */
function quantityValueField(typeCode: number | undefined): string | null {
  switch (typeCode) {
    case IFCQUANTITYLENGTH:
      return 'LengthValue';
    case IFCQUANTITYAREA:
      return 'AreaValue';
    case IFCQUANTITYVOLUME:
      return 'VolumeValue';
    case IFCQUANTITYWEIGHT:
      return 'WeightValue';
    case IFCQUANTITYCOUNT:
      return 'CountValue';
    case IFCQUANTITYTIME:
      return 'TimeValue';
    default:
      return null;
  }
}

function quantityKindForType(
  typeCode: number | undefined,
): 'length' | 'area' | 'volume' | 'count' | 'weight' | 'time' {
  switch (typeCode) {
    case IFCQUANTITYAREA:
      return 'area';
    case IFCQUANTITYVOLUME:
      return 'volume';
    case IFCQUANTITYWEIGHT:
      return 'weight';
    case IFCQUANTITYCOUNT:
      return 'count';
    case IFCQUANTITYTIME:
      return 'time';
    case IFCQUANTITYLENGTH:
    default:
      return 'length';
  }
}

/** The IFC unit type a quantity is in; null for a count, which has none. */
function quantityUnitType(typeCode: number | undefined): string | null {
  switch (typeCode) {
    case IFCQUANTITYAREA:
      return 'AREAUNIT';
    case IFCQUANTITYVOLUME:
      return 'VOLUMEUNIT';
    case IFCQUANTITYWEIGHT:
      return 'MASSUNIT';
    case IFCQUANTITYTIME:
      return 'TIMEUNIT';
    case IFCQUANTITYCOUNT:
      return null;
    case IFCQUANTITYLENGTH:
    default:
      return 'LENGTHUNIT';
  }
}

/** Put a unit on a node: its symbol to show, and its key to compare. */
function applyUnit(node: PropertyNode, unit: UnitRef): PropertyNode {
  if (unit.symbol) node.unit = unit.symbol;
  if (unit.key) node.unitKey = unit.key;
  return node;
}

// ---------------------------------------------------------------------------
// Identity + direct rows
// ---------------------------------------------------------------------------

/**
 * Strip the authoring-tool element id that Revit's IFC exporter appends to
 * `Name`.
 *
 * Revit writes `Family:Type:<ElementId>` — e.g.
 * `Wall Foundation:Såle 1500x300:667171` — and puts that same id in `Tag`.
 * The consequence is that every element's Name is unique, so "select
 * everything with this Name" can only ever match the element you started
 * from, and the panel title carries a number nobody reads.
 *
 * The rule is deliberately narrow: strip the trailing `:<digits>` ONLY when
 * those digits are exactly the element's Tag. That makes the transform
 * self-verifying — a name that genuinely ends in a colon-number ("Grid:100")
 * is left alone unless the model itself confirms the number is the id — and
 * loses nothing, since Tag still carries the id as its own row.
 */
export function stripAuthoringIdSuffix(
  name: string | undefined,
  tag: string | undefined,
): string | undefined {
  if (!name || !tag) return name;
  const suffix = `:${tag}`;
  if (!name.endsWith(suffix)) return name;
  if (!/^\d+$/.test(tag)) return name;
  const stripped = name.slice(0, -suffix.length);
  // Never return an empty name — if the id was the whole thing, keep it.
  return stripped.length > 0 ? stripped : name;
}

/**
 * The element's identity. `ifcClass` comes from the line's numeric type code
 * through `className`, never from the line object's constructor: a production
 * build minifies web-ifc and renames its classes, so the constructor's name
 * reads `lg` there (issue #90). Without a `className` the placeholder from
 * `ifcClassFromTypeCode` is used.
 */
export function buildIdentity(
  modelId: string,
  expressId: number,
  item: unknown,
  className: (typeCode: number) => string = ifcClassFromTypeCode,
): ElementIdentity {
  const o = isObj(item) ? item : {};
  const ifcTypeCode = getRawTypeCode(o) ?? 0;
  const tag = readString((o as Record<string, unknown>).Tag);
  return {
    modelId,
    expressId,
    ifcClass: className(ifcTypeCode),
    ifcTypeCode,
    globalId: readString((o as Record<string, unknown>).GlobalId),
    name: stripAuthoringIdSuffix(readString((o as Record<string, unknown>).Name), tag),
    objectType: readString((o as Record<string, unknown>).ObjectType),
    tag,
    predefinedType: readString((o as Record<string, unknown>).PredefinedType),
  };
}

export function buildDirect(identity: ElementIdentity, item: unknown): PropertyNode[] {
  const rows: PropertyNode[] = [];
  const push = (key: string, val: string | number | undefined, typeCode = 0): void => {
    if (val === undefined || val === null || val === '') return;
    rows.push({
      key,
      value: {
        kind: 'single',
        value: val,
        raw: { typeCode, value: val },
      },
      source: 'direct',
    });
  };
  push('Name', identity.name);
  push('GlobalId', identity.globalId);
  // The family type. Shown as its own row so it can be read directly and so
  // "select similar" has a path to match on (`Identity.Type`).
  push('Type', identity.typeName);
  push('ObjectType', identity.objectType);
  push('Tag', identity.tag);
  push('PredefinedType', identity.predefinedType);
  push('IfcClass', identity.ifcClass);
  push('ExpressId', identity.expressId);

  // Description is sometimes present on IfcRoot subclasses.
  const desc = readString(
    (isObj(item) ? item : {}).Description as unknown,
  );
  push('Description', desc);

  return rows;
}

// ---------------------------------------------------------------------------
// PSet / Qto groups
// ---------------------------------------------------------------------------

export function buildPsetGroup(raw: unknown, units: ModelUnits | null): PropertyGroup | null {
  if (!isObj(raw)) return null;
  const name = readString(raw.Name) ?? '(unnamed Pset)';
  const description = readString(raw.Description);
  const propsRaw = raw.HasProperties;
  if (!Array.isArray(propsRaw)) return { name, source: 'pset', description, properties: [] };
  const properties: PropertyNode[] = [];
  for (const p of propsRaw) {
    const node = buildPropertyNode(p, 'pset', units);
    if (node) properties.push(node);
  }
  return { name, source: 'pset', description, properties };
}

export function buildQuantityGroup(raw: unknown, units: ModelUnits | null): PropertyGroup | null {
  if (!isObj(raw)) return null;
  const name = readString(raw.Name) ?? '(unnamed Qto)';
  const description = readString(raw.Description);
  const quantsRaw = raw.Quantities;
  if (!Array.isArray(quantsRaw)) return { name, source: 'qto', description, properties: [] };
  const properties: PropertyNode[] = [];
  for (const q of quantsRaw) {
    const node = buildQuantityNode(q, units);
    if (node) properties.push(node);
  }
  return { name, source: 'qto', description, properties };
}

/**
 * Build a property node from an IfcPropertySingleValue, -EnumeratedValue,
 * -ListValue, -BoundedValue, -TableValue or IfcComplexProperty.
 *
 * Units: a unit set on the property (`Unit`) wins over the project's unit for
 * the value's measure; with neither, a measure's unit is "not stated" (see
 * `units.ts`). What each kind shows (and the Parameters list counts as text):
 *  - enumerated: its chosen values, joined;
 *  - list: its items, joined, in the list's unit;
 *  - bounded: "lower – upper", with the set point when there is one;
 *  - table: its rows as "defining → defined" pairs.
 */
export function buildPropertyNode(
  raw: unknown,
  source: PropertySource,
  units: ModelUnits | null,
): PropertyNode | null {
  if (!isObj(raw)) return null;
  const typeCode = getRawTypeCode(raw);
  const key = readString(raw.Name) ?? '(unnamed)';
  const description = readString(raw.Description);
  const unitOf = (measure: string | undefined, own: unknown): UnitRef =>
    units ? units.forMeasure(measure, own) : NO_UNIT;

  if (typeCode === IFCPROPERTYSINGLEVALUE) {
    const nv = raw.NominalValue;
    const norm = normalizeTypedValue(nv);
    if (norm) {
      const value: PropertyValue = {
        kind: 'single',
        value: coerceSingleValue(norm),
        raw: { typeCode: norm.type, value: norm.value },
      };
      return applyUnit({ key, value, description, source }, unitOf(norm.measure, raw.Unit));
    }
    // Missing nominal value
    return {
      key,
      value: { kind: 'single', value: null, raw: { typeCode: 0, value: null } },
      description,
      source,
    };
  }

  if (typeCode === IFCCOMPLEXPROPERTY) {
    const childrenRaw = raw.HasProperties;
    const children: PropertyNode[] = [];
    if (Array.isArray(childrenRaw)) {
      for (const c of childrenRaw) {
        const node = buildPropertyNode(c, source, units);
        if (node) children.push(node);
      }
    }
    return {
      key,
      value: { kind: 'complex', children },
      description,
      source,
    };
  }

  if (typeCode === IFCPROPERTYENUMERATEDVALUE) {
    const values: string[] = [];
    for (const v of Array.isArray(raw.EnumerationValues) ? raw.EnumerationValues : []) {
      const norm = normalizeTypedValue(v);
      if (norm && norm.value !== null && norm.value !== undefined) values.push(formatRawValue(norm.type, norm.value));
    }
    return { key, value: { kind: 'enumerated', values }, description, source };
  }

  if (typeCode === IFCPROPERTYLISTVALUE) {
    const items = typedList(raw.ListValues);
    const value: PropertyValue = { kind: 'list', values: items.map(singleOf) };
    return applyUnit({ key, value, description, source }, unitOf(items[0]?.measure, raw.Unit));
  }

  if (typeCode === IFCPROPERTYBOUNDEDVALUE) {
    const lower = normalizeTypedValue(raw.LowerBoundValue);
    const upper = normalizeTypedValue(raw.UpperBoundValue);
    const setpoint = normalizeTypedValue(raw.SetPointValue);
    const value: PropertyValue = { kind: 'bounded' };
    if (typeof lower?.value === 'number') value.lower = lower.value;
    if (typeof upper?.value === 'number') value.upper = upper.value;
    if (typeof setpoint?.value === 'number') value.setpoint = setpoint.value;
    const measure = (lower ?? upper ?? setpoint)?.measure;
    return applyUnit({ key, value, description, source }, unitOf(measure, raw.Unit));
  }

  if (typeCode === IFCPROPERTYTABLEVALUE) {
    const value: PropertyValue = {
      kind: 'table',
      defining: typedList(raw.DefiningValues).map(singleOf),
      defined: typedList(raw.DefinedValues).map(singleOf),
    };
    return { key, value, description, source };
  }

  // Anything else (a reference value): present, without a value.
  return {
    key,
    value: { kind: 'single', value: null, raw: { typeCode: typeCode ?? 0, value: null } },
    description,
    source,
  };
}

/** The typed values of a list attribute, skipping anything that is not one. */
function typedList(v: unknown): TypedValue[] {
  if (!Array.isArray(v)) return [];
  const out: TypedValue[] = [];
  for (const x of v) {
    const n = normalizeTypedValue(x);
    if (n) out.push(n);
  }
  return out;
}

function singleOf(n: TypedValue): PropertyValue {
  return { kind: 'single', value: coerceSingleValue(n), raw: { typeCode: n.type, value: n.value } };
}

/**
 * Build a property node from an IfcPhysicalQuantity (length/area/etc.). A
 * unit set on the quantity wins over the project's unit for its kind.
 */
export function buildQuantityNode(raw: unknown, units: ModelUnits | null): PropertyNode | null {
  if (!isObj(raw)) return null;
  const typeCode = getRawTypeCode(raw);
  const key = readString(raw.Name) ?? '(unnamed)';
  const description = readString(raw.Description);

  const valueField = quantityValueField(typeCode);
  if (!valueField) return null;
  const num = readNumber(raw[valueField]);
  if (num === undefined) return null;

  const value: PropertyValue = {
    kind: 'quantity',
    quantityKind: quantityKindForType(typeCode),
    value: num,
  };
  const unit = units ? units.forUnitType(quantityUnitType(typeCode), raw.Unit) : NO_UNIT;
  return applyUnit({ key, value, description, source: 'qto' }, unit);
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export function buildMaterials(raw: unknown): PropertyValue[] {
  if (!Array.isArray(raw)) return [];
  const out: PropertyValue[] = [];
  for (const m of raw) {
    if (!isObj(m)) continue;
    const typeCode = getRawTypeCode(m);
    if (typeCode === IFCMATERIAL) {
      const name = readString(m.Name) ?? '(unnamed material)';
      const ridRaw = (m as Record<string, unknown>).expressID;
      const rid = typeof ridRaw === 'number' ? ridRaw : 0;
      out.push({ kind: 'material-ref', materialName: name, expressId: rid });
    }
    // Layer sets / constituents are flattened to references for Phase 1.
    // Phase 3 will render layered materials properly.
  }
  return out;
}
