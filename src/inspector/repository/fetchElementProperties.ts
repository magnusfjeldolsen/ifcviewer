/**
 * Extracted property fetch + normalize core.
 *
 * `fetchElementProperties` does, for one element: `getItemProperties` +
 * the destructive-`getPropertySets` two-call merge (`fetchPropertyGroups`)
 * + `getMaterialsProperties`, then normalizes the raw typed wrappers into
 * our `ElementProperties` shape via the pure helpers in
 * `./propertyNormalizer` / `./flatRows` / `../format`.
 *
 * This module is **worker-importable**: it depends only on a structural
 * `PropertyApi` interface and pure normalization code — no DOM, no
 * main-thread state. The IFC worker (`ifcWorker.ts`) imports it; so could
 * any future engine binding.
 *
 * Lifted out of the deleted `WebIfcPropertyRepository` by the
 * `web-worker-parse` change. The async orchestration that used to wrap
 * this (memoization, per-model serialization) now lives in the worker
 * queue + `WorkerPropertyRepository`'s main-thread memo. No behavior
 * change to the fetch itself.
 */

import { IFCELEMENTQUANTITY, IFCPROPERTYSET } from 'web-ifc';

import type { UnitTable } from '../format';
import type { ElementProperties, PropertyGroup } from '../types';
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
import { buildFlatRows } from './flatRows';

/**
 * Subset of `IfcAPI` the property fetch depends on. Pulled out as a type
 * so tests can supply a minimal fake without instantiating the WASM
 * module, and so the worker can pass its real `IfcAPI` structurally.
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
     * and once via `getTypeProperties` (type), then merge. See
     * `fetchPropertyGroups`.
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
 * Fetch + normalize the full property snapshot for one element.
 *
 * @param api        Structural web-ifc property surface.
 * @param webIfcId   Numeric web-ifc model id (resolved by the caller).
 * @param modelId    App UUID — embedded into the returned identity.
 * @param expressId  IFC line id of the element.
 * @param unitTable  The model's effective unit table (computed once by
 *                   the caller and reused across elements).
 */
export async function fetchElementProperties(
  api: PropertyApi,
  webIfcId: number,
  modelId: string,
  expressId: number,
  unitTable: UnitTable,
): Promise<ElementProperties> {
  const [item, rawGroups, materialsRaw] = await Promise.all([
    api.properties.getItemProperties(webIfcId, expressId, false, false),
    fetchPropertyGroups(api, webIfcId, expressId),
    api.properties.getMaterialsProperties(webIfcId, expressId, true, true),
  ]);

  const identity = buildIdentity(modelId, expressId, item);
  const direct = buildDirect(identity, item);

  const { psets, qtos } = buildPsetAndQtoGroups(rawGroups, unitTable);

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
 * `IfcRelDefinesByProperties` branch (every instance pset goes missing,
 * including any `IfcElementQuantity`). So we cannot rely on a single
 * call. We mirror the two-call merge pattern from IfcOpenShell-python's
 * `ifcopenshell.util.element.get_psets`:
 *
 *   1. `getPropertySets(.., false)` → instance-side IfcPropertySet AND
 *      IfcElementQuantity lines (both inherit from IfcPropertySetDefinition).
 *   2. `getTypeProperties(.., false)` → the element's IfcTypeObject(s);
 *      we then walk `HasPropertySets` and resolve each ref via `GetLine`.
 *
 * The resulting list is tagged with `inheritedFromType`. We do NOT
 * dedupe: when an instance pset and a type pset share the same Name the
 * inspector UI shows a "from type" badge so the user can see provenance.
 */
async function fetchPropertyGroups(
  api: PropertyApi,
  webIfcId: number,
  expressId: number,
): Promise<RawPropertyGroup[]> {
  // Branch 1: instance-level (walks IfcRelDefinesByProperties).
  const instanceRaw = await api.properties.getPropertySets(
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
    typeObjects = await api.properties.getTypeProperties(webIfcId, expressId, false);
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
          const resolved = await api.GetLine(webIfcId, ref.value, true);
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
function buildPsetAndQtoGroups(
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
