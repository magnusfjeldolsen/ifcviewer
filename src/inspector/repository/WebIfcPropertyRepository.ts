/**
 * Concrete `ElementPropertyRepository` backed by web-ifc.
 *
 * Calls `IfcAPI.properties.getItemProperties`, `getPropertySets`, and
 * `getMaterialsProperties` in parallel for each request, then normalizes
 * the raw typed wrappers into our `ElementProperties` shape. The `flat`
 * row array is built at fetch time so downstream views (and aggregation)
 * don't need to walk the tree.
 *
 * Memoization is per `(modelId, expressId)`. Concurrent requests for the
 * same key share a single in-flight promise. Per-model state (unit table,
 * memo map) is freed by `disposeModel`.
 *
 * Note: web-ifc is not thread-safe, but all its JS calls are synchronous
 * under the hood (they marshal into WASM and return immediately) — the
 * `async` signatures of `properties.*` are wrappers. The caller (App)
 * may still want to serialize repository calls behind the same
 * `parseQueue` it uses for `IfcParser.parse` to avoid issuing queries
 * during an active parse. The repository accepts an optional `enqueue`
 * function for this.
 */

import * as WebIFC from 'web-ifc';
import {
  IFCBOOLEAN,
  IFCCOMPLEXPROPERTY,
  IFCELEMENTQUANTITY,
  IFCLOGICAL,
  IFCMATERIAL,
  IFCPROJECT,
  IFCPROPERTYSET,
  IFCPROPERTYSINGLEVALUE,
  IFCQUANTITYAREA,
  IFCQUANTITYCOUNT,
  IFCQUANTITYLENGTH,
  IFCQUANTITYTIME,
  IFCQUANTITYVOLUME,
  IFCQUANTITYWEIGHT,
  IFCSIUNIT,
  IFCCONVERSIONBASEDUNIT,
} from 'web-ifc';

import {
  buildUnitTable,
  formatRawValue,
  measureKindForType,
  unitSuffixForType,
  type RawUnitEntry,
  type UnitTable,
} from '../format';
import type {
  ElementProperties,
  ElementIdentity,
  ModelSchema,
  PropertyFlatRow,
  PropertyGroup,
  PropertyNode,
  PropertySource,
  PropertyValue,
} from '../types';
import type { ElementPropertyRepository } from './ElementPropertyRepository';

/** Function the host (App) may pass to serialize repository work onto its parse queue. */
export type EnqueueFn = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * Subset of `IfcAPI` we depend on. Pulled out as a type so tests can
 * supply a minimal fake without instantiating the WASM module.
 */
export interface PropertyApi {
  GetLine(modelID: number, expressID: number, flatten?: boolean): unknown;
  GetLineType?(modelID: number, expressID: number): number;
  GetLineIDsWithType(modelID: number, type: number, includeInherited?: boolean): {
    get(index: number): number;
    size(): number;
  };
  properties: {
    getItemProperties(
      modelID: number,
      id: number,
      recursive?: boolean,
      inverse?: boolean,
    ): Promise<unknown>;
    /**
     * Get IfcPropertySetDefinition lines attached to an element.
     *
     * IMPORTANT: web-ifc's behavior when `includeTypeProperties=true` is
     * destructive — it returns ONLY the type-level psets (walking through
     * the type object's `HasPropertySets`) and SILENTLY SKIPS every
     * instance-level pset attached via `IfcRelDefinesByProperties`. To get
     * the full set we have to call this twice: once with `false` (instance)
     * and once via `getTypeProperties` (type), then merge. See the
     * `fetchPropertyGroups` method.
     */
    getPropertySets(
      modelID: number,
      elementID?: number,
      recursive?: boolean,
      includeTypeProperties?: boolean,
    ): Promise<unknown[]>;
    /**
     * Get the `IfcTypeObject`(s) associated with an element via
     * `IfcRelDefinesByType` (or `IsTypedBy` in IFC4+). Returned type
     * objects expose their psets via the `HasPropertySets` field; with
     * `recursive=false` each entry is a `{type, value: <expressId>}`
     * reference that we must resolve via `GetLine`.
     */
    getTypeProperties(
      modelID: number,
      elementID?: number,
      recursive?: boolean,
    ): Promise<unknown[]>;
    getMaterialsProperties(
      modelID: number,
      elementID?: number,
      recursive?: boolean,
      includeTypeMaterials?: boolean,
    ): Promise<unknown[]>;
  };
}

/**
 * Map an app UUID → web-ifc internal numeric modelID. The App owns this
 * mapping; the repository reads from it.
 */
export type ModelIdResolver = (modelId: string) => number | undefined;

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
interface TypedValue {
  type: number;
  value: unknown;
}

/** Map IFC measure class names → typecodes so the new-shape wrappers can
 *  feed `unitSuffixForType` / `measureKindForType`. */
const MEASURE_NAME_TO_TYPECODE: Readonly<Record<string, number>> = (() => {
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
function normalizeTypedValue(v: unknown): TypedValue | null {
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
function readString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const norm = normalizeTypedValue(v);
  if (norm) {
    return norm.value === null || norm.value === undefined ? undefined : String(norm.value);
  }
  return String(v);
}

function readNumber(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const norm = normalizeTypedValue(v);
  if (norm) {
    return typeof norm.value === 'number' ? norm.value : undefined;
  }
  return typeof v === 'number' ? v : undefined;
}

/**
 * One raw pset/qto line as returned by web-ifc, tagged with whether it
 * originated from the element's type rather than the element itself.
 */
interface RawPropertyGroup {
  raw: Record<string, unknown>;
  inheritedFromType: boolean;
}

/** Recursively tag a PropertyNode tree as type-inherited (for nested complex props). */
function markInheritedRecursively(node: PropertyNode): void {
  node.inheritedFromType = true;
  if (node.value.kind === 'complex') {
    for (const child of node.value.children) markInheritedRecursively(child);
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class WebIfcPropertyRepository implements ElementPropertyRepository {
  private memo = new Map<string, Map<number, Promise<ElementProperties>>>();
  private unitTables = new Map<string, UnitTable>();
  private unitTablePromises = new Map<string, Promise<UnitTable>>();

  constructor(
    private api: PropertyApi,
    private resolveModelId: ModelIdResolver,
    private enqueue: EnqueueFn | null = null,
  ) {}

  async get(modelId: string, expressId: number): Promise<ElementProperties> {
    let perModel = this.memo.get(modelId);
    if (!perModel) {
      perModel = new Map();
      this.memo.set(modelId, perModel);
    }
    const cached = perModel.get(expressId);
    if (cached) return cached;

    const work = this.fetch(modelId, expressId);
    const promise = this.enqueue ? this.enqueue(() => work) : work;
    perModel.set(expressId, promise);
    return promise;
  }

  cancel(modelId: string, expressId: number): void {
    // No-op: in-flight fetches are cheap and their results are useful next
    // time. A future variant could AbortController-thread cancellation
    // through, once `properties.*` supports it.
    void modelId;
    void expressId;
  }

  disposeModel(modelId: string): void {
    this.memo.delete(modelId);
    this.unitTables.delete(modelId);
    this.unitTablePromises.delete(modelId);
  }

  // eslint-disable-next-line require-yield
  async *enumerateExpressIds(modelId: string, ifcClass?: string): AsyncIterable<number> {
    void modelId;
    void ifcClass;
    throw new Error('enumerateExpressIds: not implemented in Phase 1');
  }

  async describeSchema(modelId: string): Promise<ModelSchema> {
    void modelId;
    throw new Error('describeSchema: not implemented in Phase 1');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async fetch(modelId: string, expressId: number): Promise<ElementProperties> {
    const webIfcId = this.resolveModelId(modelId);
    if (webIfcId === undefined) {
      throw new Error(`WebIfcPropertyRepository: unknown modelId "${modelId}"`);
    }

    const [item, rawGroups, materialsRaw, unitTable] = await Promise.all([
      this.api.properties.getItemProperties(webIfcId, expressId, false, false),
      this.fetchPropertyGroups(webIfcId, expressId),
      this.api.properties.getMaterialsProperties(webIfcId, expressId, true, true),
      this.getUnitTable(modelId),
    ]);

    const identity = this.buildIdentity(modelId, expressId, item);
    const direct = this.buildDirect(identity, item);

    const { psets, qtos } = this.buildPsetAndQtoGroups(rawGroups, unitTable);

    const materials = this.buildMaterials(materialsRaw);

    const flat = buildFlatRows(direct, psets, qtos);

    return {
      identity,
      direct,
      psets,
      qtos,
      materials,
      flat,
      fetchedAt: Date.now(),
    };
  }

  /**
   * Resolve the merged instance + type psets/qtos for one element.
   *
   * Background: web-ifc's `getPropertySets(modelID, eid, recursive, true)`
   * is destructive — when `includeTypeProperties=true` it returns ONLY
   * type-level psets and silently SKIPS the entire
   * `IfcRelDefinesByProperties` branch (every instance pset goes
   * missing, including any `IfcElementQuantity`). So we cannot rely on
   * a single call. We mirror the two-call merge pattern from
   * IfcOpenShell-python's `ifcopenshell.util.element.get_psets`:
   *
   *   1. `getPropertySets(.., false)` → instance-side IfcPropertySet AND
   *      IfcElementQuantity lines (both inherit from IfcPropertySetDefinition).
   *   2. `getTypeProperties(.., false)` → the element's IfcTypeObject(s);
   *      we then walk `HasPropertySets` and resolve each ref via
   *      `GetLine` (the helpers expose them as `{type, value: <eid>}`).
   *
   * The resulting list is tagged with `inheritedFromType`. We do NOT
   * dedupe: when an instance pset and a type pset share the same Name
   * the inspector UI shows a "from type" badge so the user can see
   * provenance.
   */
  private async fetchPropertyGroups(
    webIfcId: number,
    expressId: number,
  ): Promise<RawPropertyGroup[]> {
    // Branch 1: instance-level (walks IfcRelDefinesByProperties).
    const instanceRaw = await this.api.properties.getPropertySets(
      webIfcId,
      expressId,
      true,
      false,
    );

    // Branch 2: type-level. `recursive=false` returns IfcTypeObject(s) with
    // HasPropertySets as `{type, value: <expressId>}` refs that we resolve.
    // Some files / schemas may not expose `getTypeProperties` cleanly; on
    // failure we fall back to instance-only rather than aborting the fetch.
    let typeObjects: unknown[];
    try {
      typeObjects = await this.api.properties.getTypeProperties(
        webIfcId,
        expressId,
        false,
      );
    } catch {
      typeObjects = [];
    }

    const typeRaw: unknown[] = [];
    for (const t of typeObjects) {
      if (!isObj(t)) continue;
      const has = t.HasPropertySets;
      if (!Array.isArray(has)) continue;
      for (const ref of has) {
        if (isObj(ref) && typeof ref.value === 'number') {
          try {
            const resolved = await this.api.GetLine(webIfcId, ref.value, true);
            if (isObj(resolved)) typeRaw.push(resolved);
          } catch {
            /* skip — line not resolvable */
          }
        } else if (isObj(ref)) {
          // Already-resolved pset (e.g. from a future recursive=true call path).
          typeRaw.push(ref);
        }
      }
    }

    const out: RawPropertyGroup[] = [];
    for (const raw of instanceRaw) {
      if (isObj(raw)) out.push({ raw, inheritedFromType: false });
    }
    for (const raw of typeRaw) {
      if (isObj(raw)) out.push({ raw, inheritedFromType: true });
    }
    return out;
  }

  /** Split a merged list of raw psets/qtos into our typed groups, tagging type-inherited ones. */
  private buildPsetAndQtoGroups(
    rawGroups: RawPropertyGroup[],
    unitTable: UnitTable | null,
  ): { psets: PropertyGroup[]; qtos: PropertyGroup[] } {
    const psets: PropertyGroup[] = [];
    const qtos: PropertyGroup[] = [];
    for (const { raw, inheritedFromType } of rawGroups) {
      const typeCode = this.getRawTypeCode(raw);
      if (typeCode === IFCELEMENTQUANTITY) {
        const group = this.buildQuantityGroup(raw, unitTable);
        if (group) {
          if (inheritedFromType) {
            group.inheritedFromType = true;
            for (const p of group.properties) p.inheritedFromType = true;
          }
          qtos.push(group);
        }
      } else if (typeCode === IFCPROPERTYSET) {
        const group = this.buildPsetGroup(raw, unitTable);
        if (group) {
          if (inheritedFromType) {
            group.inheritedFromType = true;
            for (const p of group.properties) markInheritedRecursively(p);
          }
          psets.push(group);
        }
      }
    }
    // Note: we intentionally do NOT dedupe by Name. The inspector UI shows
    // a "from type" badge for type-inherited groups, so the user can see
    // when an instance pset overrides a same-named type pset.
    return { psets, qtos };
  }

  // ---- Identity ------------------------------------------------------------

  private buildIdentity(
    modelId: string,
    expressId: number,
    item: unknown,
  ): ElementIdentity {
    const o = isObj(item) ? item : {};
    const ifcTypeCode = this.getRawTypeCode(o) ?? 0;
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

  private buildDirect(identity: ElementIdentity, item: unknown): PropertyNode[] {
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

  // ---- PSet / Qto groups ---------------------------------------------------

  private buildPsetGroup(raw: unknown, unitTable: UnitTable | null): PropertyGroup | null {
    if (!isObj(raw)) return null;
    const name = readString(raw.Name) ?? '(unnamed Pset)';
    const description = readString(raw.Description);
    const propsRaw = raw.HasProperties;
    if (!Array.isArray(propsRaw)) return { name, source: 'pset', description, properties: [] };
    const properties: PropertyNode[] = [];
    for (const p of propsRaw) {
      const node = this.buildPropertyNode(p, 'pset', unitTable);
      if (node) properties.push(node);
    }
    return { name, source: 'pset', description, properties };
  }

  private buildQuantityGroup(raw: unknown, unitTable: UnitTable | null): PropertyGroup | null {
    if (!isObj(raw)) return null;
    const name = readString(raw.Name) ?? '(unnamed Qto)';
    const description = readString(raw.Description);
    const quantsRaw = raw.Quantities;
    if (!Array.isArray(quantsRaw)) return { name, source: 'qto', description, properties: [] };
    const properties: PropertyNode[] = [];
    for (const q of quantsRaw) {
      const node = this.buildQuantityNode(q, unitTable);
      if (node) properties.push(node);
    }
    return { name, source: 'qto', description, properties };
  }

  /** Build a property node from an IfcPropertySingleValue / ComplexProperty / etc. */
  private buildPropertyNode(
    raw: unknown,
    source: PropertySource,
    unitTable: UnitTable | null,
  ): PropertyNode | null {
    if (!isObj(raw)) return null;
    const typeCode = this.getRawTypeCode(raw);
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
          const node = this.buildPropertyNode(c, source, unitTable);
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
  private buildQuantityNode(raw: unknown, unitTable: UnitTable | null): PropertyNode | null {
    if (!isObj(raw)) return null;
    const typeCode = this.getRawTypeCode(raw);
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

  // ---- Materials -----------------------------------------------------------

  private buildMaterials(raw: unknown): PropertyValue[] {
    if (!Array.isArray(raw)) return [];
    const out: PropertyValue[] = [];
    for (const m of raw) {
      if (!isObj(m)) continue;
      const typeCode = this.getRawTypeCode(m);
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

  // ---- Type code helper (web-ifc may or may not stamp .type on every line) -

  private getRawTypeCode(obj: Record<string, unknown> | unknown): number | undefined {
    if (!isObj(obj)) return undefined;
    const t = obj.type;
    if (typeof t === 'number') return t;
    return undefined;
  }

  // ---- Unit table ---------------------------------------------------------

  private getUnitTable(modelId: string): Promise<UnitTable> {
    const cached = this.unitTables.get(modelId);
    if (cached) return Promise.resolve(cached);
    const pending = this.unitTablePromises.get(modelId);
    if (pending) return pending;

    const promise = this.computeUnitTable(modelId).then((table) => {
      this.unitTables.set(modelId, table);
      this.unitTablePromises.delete(modelId);
      return table;
    });
    this.unitTablePromises.set(modelId, promise);
    return promise;
  }

  private async computeUnitTable(modelId: string): Promise<UnitTable> {
    const webIfcId = this.resolveModelId(modelId);
    if (webIfcId === undefined) return buildUnitTable([]);

    // Find the project line. Models always have exactly one IfcProject.
    let projects: { get(i: number): number; size(): number };
    try {
      projects = this.api.GetLineIDsWithType(webIfcId, IFCPROJECT, false);
    } catch {
      return buildUnitTable([]);
    }
    if (!projects || projects.size() === 0) return buildUnitTable([]);
    const projectId = projects.get(0);

    let project: unknown;
    try {
      project = await this.api.properties.getItemProperties(webIfcId, projectId, true, false);
    } catch {
      return buildUnitTable([]);
    }

    // Recursive walk down `UnitsInContext.Units` to collect SI / conversion units.
    const entries: RawUnitEntry[] = [];
    if (isObj(project)) {
      const unitsInContext = project.UnitsInContext;
      if (isObj(unitsInContext) && Array.isArray(unitsInContext.Units)) {
        for (const u of unitsInContext.Units) {
          const entry = readUnitEntry(u);
          if (entry) entries.push(entry);
        }
      }
    }
    return buildUnitTable(entries);
  }
}

// ---------------------------------------------------------------------------
// Helpers shared with internals (kept module-private)
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
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

/** Read one entry of `IfcProject.UnitsInContext.Units`. */
function readUnitEntry(u: unknown): RawUnitEntry | null {
  if (!isObj(u)) return null;
  const typeCode = typeof u.type === 'number' ? u.type : undefined;
  const unitType = readString(u.UnitType);
  if (!unitType) return null;

  if (typeCode === IFCSIUNIT) {
    return {
      unitType,
      siPrefix: readString(u.Prefix) ?? null,
      siName: readString(u.Name) ?? null,
    };
  }
  if (typeCode === IFCCONVERSIONBASEDUNIT) {
    return {
      unitType,
      conversionLabel: readString(u.Name) ?? null,
    };
  }
  // Derived units and other variants — skip in Phase 1.
  return null;
}

/** Best-effort: derive an "IfcXxx" class name from a numeric type code. */
function ifcClassFromTypeCode(typeCode: number): string {
  if (!typeCode) return 'IfcElement';
  return `IfcType_${typeCode}`;
}

/**
 * Walk the structured property tree and emit flat rows. Complex
 * properties produce one row per leaf, with dotted paths.
 */
export function buildFlatRows(
  direct: PropertyNode[],
  psets: PropertyGroup[],
  qtos: PropertyGroup[],
): PropertyFlatRow[] {
  const rows: PropertyFlatRow[] = [];
  const pushNode = (groupName: string, node: PropertyNode, prefix?: string): void => {
    const path = prefix
      ? `${prefix}.${node.key}`
      : `${groupName}.${node.key}`;
    if (node.value.kind === 'complex') {
      for (const child of node.value.children) {
        pushNode(groupName, child, path);
      }
      return;
    }
    rows.push({
      path,
      name: node.key,
      rawValue: node.value,
      displayValue: displayStringForValue(node.value),
      unit: node.unit,
      source: node.source,
      inheritedFromType: node.inheritedFromType,
      description: node.description,
    });
  };

  for (const node of direct) {
    rows.push({
      path: `Identity.${node.key}`,
      name: node.key,
      rawValue: node.value,
      displayValue: displayStringForValue(node.value),
      unit: node.unit,
      source: 'direct',
      description: node.description,
    });
  }
  for (const g of psets) {
    for (const n of g.properties) pushNode(g.name, n);
  }
  for (const g of qtos) {
    for (const n of g.properties) pushNode(g.name, n);
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

export function displayStringForValue(v: PropertyValue): string {
  switch (v.kind) {
    case 'single':
      return formatRawValue(v.raw.typeCode, v.raw.value ?? v.value);
    case 'quantity':
      return formatRawValue(0, v.value);
    case 'enumerated':
      return v.values.join(', ');
    case 'list':
      return `(${v.values.length} items)`;
    case 'bounded':
      return `[${v.lower ?? '-∞'}, ${v.upper ?? '+∞'}]`;
    case 'table':
      return `(table, ${v.defining.length} rows)`;
    case 'complex':
      return `(${v.children.length} children)`;
    case 'material-ref':
      return v.materialName;
    case 'varies':
      return 'varies';
    default:
      return '';
  }
}
