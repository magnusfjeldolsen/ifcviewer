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
}

// ---------------------------------------------------------------------------
// Selection state (Phase 2 will use this; declared here so type imports are stable)
// ---------------------------------------------------------------------------

export type SelectionMode = 'replace' | 'add' | 'remove';

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
   * Resolved unit suffix (e.g. "mm", "m²"). Kept separate from the value
   * so aggregation can operate on raw numerics.
   */
  unit?: string;
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
  unit?: string;
  source: PropertySource;
  inheritedFromType?: boolean;
  description?: string;
}

// ---------------------------------------------------------------------------
// Schema discovery (stubbed in Phase 1; full impl deferred)
// ---------------------------------------------------------------------------

export interface ModelSchema {
  modelId: string;
  /** Map from IfcClass name → element count in the model. */
  classCounts: Map<string, number>;
}
