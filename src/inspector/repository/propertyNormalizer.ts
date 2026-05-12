/**
 * Pure normalization of raw web-ifc property/quantity/material objects
 * into our typed `PropertyNode` / `PropertyGroup` / `PropertyValue` shape.
 *
 * This module contains NO orchestration — every function is synchronous
 * and takes plain JS objects (as produced by `IfcAPI.properties.*`) plus
 * an optional `UnitTable` for unit-suffix resolution. The async fetch
 * coordination lives in `WebIfcPropertyRepository`.
 *
 * Split out from `WebIfcPropertyRepository.ts` to keep the orchestration
 * file readable. No behavior change.
 */

import * as WebIFC from 'web-ifc';
import {
  IFCBOOLEAN,
  IFCCOMPLEXPROPERTY,
  IFCLOGICAL,
  IFCMATERIAL,
  IFCPROPERTYSINGLEVALUE,
  IFCQUANTITYAREA,
  IFCQUANTITYCOUNT,
  IFCQUANTITYLENGTH,
  IFCQUANTITYTIME,
  IFCQUANTITYVOLUME,
  IFCQUANTITYWEIGHT,
} from 'web-ifc';

import {
  measureKindForType,
  unitSuffixForType,
  type UnitTable,
} from '../format';
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
}

/** Map IFC measure class names → typecodes so the new-shape wrappers can
 *  feed `unitSuffixForType` / `measureKindForType`. */
export const MEASURE_NAME_TO_TYPECODE: Readonly<Record<string, number>> = (() => {
  const w = WebIFC as unknown as Record<string, number>;
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
  // New shape: prefer the IFC class typecode resolved from the `name` string.
  if ('_representationValue' in obj || '_internalValue' in obj) {
    const name = typeof obj.name === 'string' ? obj.name : null;
    const fromName = name ? MEASURE_NAME_TO_TYPECODE[name] : undefined;
    return {
      type: typeof fromName === 'number' ? fromName : obj.type,
      value: '_representationValue' in obj ? obj._representationValue : obj._internalValue,
    };
  }
  // Old shape: must have a `value` key.
  if ('value' in obj) {
    return { type: obj.type, value: obj.value };
  }
  return null;
}

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

/** Best-effort: derive an "IfcXxx" class name from a numeric type code. */
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

/**
 * Map IFC quantity type code to the closest IFC measure type code, so
 * `unitSuffixForType` can pick the right unit from the unit table.
 */
function quantityMeasureType(typeCode: number | undefined): number {
  switch (typeCode) {
    case IFCQUANTITYAREA:
      return 2650437152; // IFCAREAMEASURE
    case IFCQUANTITYVOLUME:
      return 3458127941; // IFCVOLUMEMEASURE
    case IFCQUANTITYWEIGHT:
      return 3124614049; // IFCMASSMEASURE
    case IFCQUANTITYTIME:
      return 2726807636; // IFCTIMEMEASURE
    case IFCQUANTITYCOUNT:
      return 1778710042; // IFCCOUNTMEASURE
    case IFCQUANTITYLENGTH:
    default:
      return 1243674935; // IFCLENGTHMEASURE
  }
}

// ---------------------------------------------------------------------------
// Identity + direct rows
// ---------------------------------------------------------------------------

export function buildIdentity(
  modelId: string,
  expressId: number,
  item: unknown,
): ElementIdentity {
  const o = isObj(item) ? item : {};
  const ifcTypeCode = getRawTypeCode(o) ?? 0;
  return {
    modelId,
    expressId,
    ifcClass: typeof o.constructor?.name === 'string' && o.constructor?.name !== 'Object'
      ? (o.constructor as { name: string }).name
      : ifcClassFromTypeCode(ifcTypeCode),
    ifcTypeCode,
    globalId: readString((o as Record<string, unknown>).GlobalId),
    name: readString((o as Record<string, unknown>).Name),
    objectType: readString((o as Record<string, unknown>).ObjectType),
    tag: readString((o as Record<string, unknown>).Tag),
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

export function buildPsetGroup(raw: unknown, unitTable: UnitTable | null): PropertyGroup | null {
  if (!isObj(raw)) return null;
  const name = readString(raw.Name) ?? '(unnamed Pset)';
  const description = readString(raw.Description);
  const propsRaw = raw.HasProperties;
  if (!Array.isArray(propsRaw)) return { name, source: 'pset', description, properties: [] };
  const properties: PropertyNode[] = [];
  for (const p of propsRaw) {
    const node = buildPropertyNode(p, 'pset', unitTable);
    if (node) properties.push(node);
  }
  return { name, source: 'pset', description, properties };
}

export function buildQuantityGroup(raw: unknown, unitTable: UnitTable | null): PropertyGroup | null {
  if (!isObj(raw)) return null;
  const name = readString(raw.Name) ?? '(unnamed Qto)';
  const description = readString(raw.Description);
  const quantsRaw = raw.Quantities;
  if (!Array.isArray(quantsRaw)) return { name, source: 'qto', description, properties: [] };
  const properties: PropertyNode[] = [];
  for (const q of quantsRaw) {
    const node = buildQuantityNode(q, unitTable);
    if (node) properties.push(node);
  }
  return { name, source: 'qto', description, properties };
}

/** Build a property node from an IfcPropertySingleValue / ComplexProperty / etc. */
export function buildPropertyNode(
  raw: unknown,
  source: PropertySource,
  unitTable: UnitTable | null,
): PropertyNode | null {
  if (!isObj(raw)) return null;
  const typeCode = getRawTypeCode(raw);
  const key = readString(raw.Name) ?? '(unnamed)';
  const description = readString(raw.Description);

  if (typeCode === IFCPROPERTYSINGLEVALUE) {
    const nv = raw.NominalValue;
    const norm = normalizeTypedValue(nv);
    if (norm) {
      const value: PropertyValue = {
        kind: 'single',
        value: coerceSingleValue(norm),
        raw: { typeCode: norm.type, value: norm.value },
      };
      return {
        key,
        value,
        unit: unitSuffixForType(norm.type, unitTable) || undefined,
        description,
        source,
      };
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
        const node = buildPropertyNode(c, source, unitTable);
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

  // Other property kinds (enumerated, list, bounded, table) — render a
  // sensible fallback. Full support lives in Phase 3.
  return {
    key,
    value: { kind: 'single', value: null, raw: { typeCode: typeCode ?? 0, value: null } },
    description,
    source,
  };
}

/** Build a property node from an IfcPhysicalQuantity (length/area/etc.). */
export function buildQuantityNode(raw: unknown, unitTable: UnitTable | null): PropertyNode | null {
  if (!isObj(raw)) return null;
  const typeCode = getRawTypeCode(raw);
  const key = readString(raw.Name) ?? '(unnamed)';
  const description = readString(raw.Description);

  const valueField = quantityValueField(typeCode);
  if (!valueField) return null;
  const num = readNumber(raw[valueField]);
  if (num === undefined) return null;

  const quantityKind = quantityKindForType(typeCode);

  const value: PropertyValue = {
    kind: 'quantity',
    quantityKind,
    value: num,
  };

  // Pick a unit suffix: prefer the model's unit assignment for the matching
  // measure kind; fall back to the default for that quantity kind.
  const unit = unitSuffixForType(quantityMeasureType(typeCode), unitTable) || undefined;

  return {
    key,
    value,
    unit,
    description,
    source: 'qto',
  };
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
