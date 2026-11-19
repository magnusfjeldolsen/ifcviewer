/**
 * Public data shapes for the Element Properties Inspector.
 *
 * The shapes here are the contract between the repository (which fetches
 * and normalizes properties from web-ifc) and downstream consumers (the
 * panel UI, intersection logic, future filter / aggregation features).
 *
 * No logic in this file — only types.
 *
 * Spec: dev/plans/phase-element-inspector.md, "Data model" section.
 */

import type { UnitCount } from './units';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface ElementIdentity {
  /** App UUID — matches ModelManager / SessionStore keys. */
  modelId: string;
  /** IFC line ID. Per-model, stable across re-parse of the same buffer. */
  expressId: number;
  /** Schema class name, e.g. "IfcWall". */
  ifcClass: string;
  /** Numeric type code (for fast type equality without string compare). */
  ifcTypeCode: number;
  /** 22-character IfcGloballyUniqueId, if the element exposes one. */
  globalId?: string;
  name?: string;
  objectType?: string;
  tag?: string;
  predefinedType?: string;
  /**
   * Name of the linked `IfcTypeObject` (`IfcRelDefinesByType` / `IsTypedBy`) —
   * the authoring-tool family type, e.g. "Concrete-Rectangular-Column:CC24x24".
   *
   * This is the discriminator for "select all of this type". `ObjectType`
   * carries the same string in some exports but is absent in others (0 of 54
   * columns in Snowdon Towers, 0 of 917 beams; present on all 121 RIB beams),
   * whereas the type object is present in every model measured.
   */
  typeName?: string;
}

// ---------------------------------------------------------------------------
// Selection state (Phase 2 will use this; declared here so type imports are stable)
// ---------------------------------------------------------------------------

export type SelectionMode = 'replace' | 'add' | 'remove';

/**
 * A `Scope` is a set of element identities — the substrate the Data Insight
 * features operate on. The Selection Basket is the first concrete producer
 * (`SelectionBasket.getContents()`). Kept minimal for now (a plain readonly
 * list); later sources (filter, model) will also expose a list and we'll
 * generalize then. See dev/plans/handoff-selection-basket.md.
 */
export type Scope = readonly ElementIdentity[];

export type SelectionState =
  | { kind: 'none' }
  | { kind: 'single'; identities: [ElementIdentity] }
  | { kind: 'multi'; identities: ElementIdentity[]; lockedModelId?: string };

// ---------------------------------------------------------------------------
// Property values
// ---------------------------------------------------------------------------

export type PropertySource =
  /** Identity attributes: Name, GlobalId, Tag, PredefinedType, etc. */
  | 'direct'
  /** IfcPropertySet */
  | 'pset'
  /** IfcElementQuantity */
  | 'qto'
  /** IfcRelDefinesByType → type's own psets/qsets (inherited). */
  | 'type'
  /** IfcRelAssociatesMaterial */
  | 'material';

/**
 * Discriminated union covering the IFC property-value kinds we care about.
 *
 * `raw` on the `single` variant preserves the original typed wrapper from
 * web-ifc — `{ type: <numeric typecode>, value: <raw> }` — so future
 * features (aggregation, filtering, calculated fields) can read the
 * untouched value without re-parsing display strings.
 */
export type PropertyValue =
  | {
      kind: 'single';
      value: string | number | boolean | null;
      raw: { typeCode: number; value: unknown };
    }
  | { kind: 'enumerated'; values: string[]; enumRef?: string }
  | { kind: 'list'; values: PropertyValue[] }
  | { kind: 'bounded'; lower?: number; upper?: number; setpoint?: number }
  | { kind: 'table'; defining: PropertyValue[]; defined: PropertyValue[] }
  | { kind: 'complex'; children: PropertyNode[] }
  | {
      kind: 'quantity';
      quantityKind: 'length' | 'area' | 'volume' | 'count' | 'weight' | 'time';
      value: number;
    }
  | { kind: 'material-ref'; materialName: string; expressId: number }
  /** Sentinel for multi-select intersection: property exists in all selected, but values differ. */
  | { kind: 'varies' };

export interface PropertyNode {
  /** Property name as it appears in the IFC pset (e.g. "LoadBearing"). */
  key: string;
  /** Optional human label, distinct from `key`. */
  label?: string;
  value: PropertyValue;
  /**
   * Unit symbol to show (e.g. "mm", "ft", "W/(m²·K)"). Kept separate from the
   * value so aggregation can operate on raw numerics. Absent when no unit
   * applies or the model does not state one.
   */
  unit?: string;
  /**
   * Which unit the value is in (see `units.ts`): equal keys, same unit.
   * Absent when no unit applies; `"?LENGTHUNIT"` and the like when the value
   * is a measure whose unit the model does not state.
   */
  unitKey?: string;
  description?: string;
  source: PropertySource;
  /** True if this row originated on the element's type (`IfcRelDefinesByType`). */
  inheritedFromType?: boolean;
  /** True if an instance value overrides a same-named type value. */
  overridesType?: boolean;
}

export interface PropertyGroup {
  /** Pset / Qto name, e.g. "Pset_WallCommon". */
  name: string;
  source: PropertySource;
  inheritedFromType?: boolean;
  description?: string;
  properties: PropertyNode[];
}

export interface ElementProperties {
  identity: ElementIdentity;
  /** Identity attributes flattened as rows (for the "Identity" section in Tree view). */
  direct: PropertyNode[];
  /** Property sets, instance + type-inherited (merged inline, type rows tagged). */
  psets: PropertyGroup[];
  qtos: PropertyGroup[];
  /**
   * Materials as a flat list. v1: simple material-ref entries.
   * v2 may extend with layered / profile children.
   */
  materials: PropertyValue[];
  /** Precomputed once at fetch time; consumed by Flat view and aggregation. */
  flat: PropertyFlatRow[];
  /** Epoch ms when this snapshot was assembled. Memoization key freshness. */
  fetchedAt: number;
}

export interface PropertyFlatRow {
  /** Dotted source path, e.g. "Pset_WallCommon.LoadBearing". */
  path: string;
  /** Last segment of `path`, for the Name column. */
  name: string;
  /** Untouched value (for aggregation / filtering). */
  rawValue: PropertyValue;
  /** Formatted string of the value only (without unit suffix). */
  displayValue: string;
  /** Unit symbol to show; see `PropertyNode.unit`. */
  unit?: string;
  /** Which unit the value is in; see `PropertyNode.unitKey`. */
  unitKey?: string;
  source: PropertySource;
  inheritedFromType?: boolean;
  description?: string;
}

// ---------------------------------------------------------------------------
// Parameter discovery: which parameters exist across a model (#67)
// ---------------------------------------------------------------------------

/**
 * What kind of values a parameter holds, decided from the normalised value's
 * JavaScript type. `mixed` when elements disagree (a number on some, text on
 * others) — rare, and worth showing rather than hiding.
 */
export type ParameterKind = 'numeric' | 'text' | 'boolean' | 'mixed';

/** One value as discovery counts it. Enumerations are joined, as the inspector shows them. */
export type ParameterValue = string | number | boolean;

export interface ParameterSummary {
  /** The flat-row path, e.g. "Pset_BeamCommon.LoadBearing" or "Identity.Name". */
  key: string;
  /** Elements in the scope that have a value at this path. */
  count: number;
  kind: ParameterKind;
  /**
   * Unit symbol of the numeric values, when they are all in one unit that the
   * model states. Absent for text, for plain numbers, for an unstated unit
   * and for mixed units: `units` says which.
   */
  unit?: string;
  /**
   * The units of the numeric values (see `units.ts`), most common first, with
   * how many values are in each. A single entry with key `""` is plain
   * numbers; a key starting with `?` means the model does not state the unit.
   * Absent when no value is a number.
   */
  units?: UnitCount[];
  /** True when the numeric values are in more than one unit: they are not added up. */
  unitsDiffer?: boolean;
  /** Over the numeric values only; absent when there are none. */
  numeric?: { min: number; max: number; sum: number };
  /** Number of distinct values, or null when there are more than the cap. */
  distinct: number | null;
  /** The distinct values with their counts, most common first. Absent over the cap. */
  values?: { value: ParameterValue; count: number }[];
  /** No value repeats across two or more elements (GlobalId, Tag, …). */
  uniquePerElement: boolean;
}

/** The parameters of one model over one scope of elements. */
export interface ModelParameters {
  modelId: string;
  /** Elements in the scope: those with geometry in the viewer. */
  scopeSize: number;
  /** Elements whose properties could not be read; absent when every one could. */
  unreadable?: number;
  /** Sorted by key. */
  parameters: ParameterSummary[];
}
