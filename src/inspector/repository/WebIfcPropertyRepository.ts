/**
 * Concrete `ElementPropertyRepository` backed by web-ifc.
 *
 * Calls `IfcAPI.properties.getItemProperties`, `getPropertySets`, and
 * `getMaterialsProperties` in parallel for each request, then normalizes
 * the raw typed wrappers into our `ElementProperties` shape via the pure
 * helpers in `./propertyNormalizer`, `./unitTable`, and `./flatRows`.
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

import {
  IFCELEMENTQUANTITY,
  IFCPROPERTYSET,
} from 'web-ifc';

import { buildUnitTable, type UnitTable } from '../format';
import type {
  ElementProperties,
  ModelSchema,
  PropertyGroup,
} from '../types';
import type { ElementPropertyRepository } from './ElementPropertyRepository';
import {
  buildDirect,
  buildIdentity,
  buildMaterials,
  buildPsetGroup,
  buildQuantityGroup,
  getRawTypeCode,
  isObj,
  markInheritedRecursively,
  type RawPropertyGroup,
} from './propertyNormalizer';
import { computeUnitTable } from './unitTable';
import { buildFlatRows } from './flatRows';

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

    // Defer the fetch into the enqueue thunk so the synchronous prefix
    // of fetch (resolveModelId) runs AFTER any in-flight parse settles.
    // This matters for the geometry-cache restore path: the scene is up
    // before web-ifc has the model open, so modelIdMap is briefly empty.
    // The background re-parse runs through the same parseQueue, so by
    // the time this thunk fires modelIdMap is populated.
    const promise = this.enqueue
      ? this.enqueue(() => this.fetch(modelId, expressId))
      : this.fetch(modelId, expressId);
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

    const identity = buildIdentity(modelId, expressId, item);
    const direct = buildDirect(identity, item);

    const { psets, qtos } = this.buildPsetAndQtoGroups(rawGroups, unitTable);

    const materials = buildMaterials(materialsRaw);

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
      const typeCode = getRawTypeCode(raw);
      if (typeCode === IFCELEMENTQUANTITY) {
        const group = buildQuantityGroup(raw, unitTable);
        if (group) {
          if (inheritedFromType) {
            group.inheritedFromType = true;
            for (const p of group.properties) p.inheritedFromType = true;
          }
          qtos.push(group);
        }
      } else if (typeCode === IFCPROPERTYSET) {
        const group = buildPsetGroup(raw, unitTable);
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

  // ---- Unit table ---------------------------------------------------------

  private getUnitTable(modelId: string): Promise<UnitTable> {
    const cached = this.unitTables.get(modelId);
    if (cached) return Promise.resolve(cached);
    const pending = this.unitTablePromises.get(modelId);
    if (pending) return pending;

    const promise = this.resolveUnitTable(modelId).then((table) => {
      this.unitTables.set(modelId, table);
      this.unitTablePromises.delete(modelId);
      return table;
    });
    this.unitTablePromises.set(modelId, promise);
    return promise;
  }

  /**
   * Resolve the modelId to a numeric web-ifc id, then delegate to
   * `computeUnitTable`. Returns an empty table when the modelId is
   * unknown — matches the legacy in-class `computeUnitTable` behavior.
   */
  private async resolveUnitTable(modelId: string): Promise<UnitTable> {
    const webIfcId = this.resolveModelId(modelId);
    if (webIfcId === undefined) return buildUnitTable([]);
    return computeUnitTable(this.api, webIfcId);
  }
}
