/**
 * Per-model cache that makes bulk property reads scale with the number of
 * elements read rather than with elements × model size.
 *
 * Three costs dominate an uncached `fetchElementProperties` on a real model,
 * and this module removes all of them:
 *
 *  1. **Relationship lookups scan the whole model.** web-ifc answers
 *     "which IfcRelDefinesByProperties / IfcRelDefinesByType /
 *     IfcRelAssociates point at element X?" by walking every relationship
 *     line of that kind (`GetInversePropertyForItem`). The uncached fetch asks
 *     that three times per element (psets, types, and the types again inside
 *     `getMaterialsProperties`), so a bulk read is quadratic in model size.
 *     The {@link RelationIndex} walks each relationship kind once and answers
 *     every later question from a map.
 *
 *  2. **Type-side work is repeated per instance.** 2,000 walls sharing five
 *     types used to resolve those types' psets and materials 2,000 times.
 *     {@link ModelPropertyCache.typeSide} resolves each type once.
 *
 *  3. **Psets are read far deeper than needed.** See
 *     {@link readPropertyDefinition}.
 *
 * What is cached is always the RAW web-ifc lines, never built property
 * groups: the normalizer builds fresh objects from raw lines on every call
 * and never writes to them, so sharing raw lines between elements cannot
 * cross-contaminate their results, whereas sharing built groups would (the
 * fetch tags type-inherited groups in place).
 *
 * The cache must reproduce exactly what web-ifc's own `properties.*` helpers
 * return — same lines, same order — so that a cached read is
 * indistinguishable from an uncached one on well-formed files. (On malformed
 * files the cached path can return a result where the uncached path would
 * throw, e.g. a dangling RelatingType, or a broken reference in a pset field
 * the normalizer never reads such as OwnerHistory; that is accepted.) The index therefore scans the same
 * relationship supertypes, in the same order, that web-ifc's inverse lookup
 * scans (`InversePropertyDef` for `IsDefinedBy` / `IsTypedBy` /
 * `HasAssociations`).
 *
 * Lifetime: one instance per open model, owned by the IFC worker and dropped
 * with the model (`ModelPropertyCaches.drop`). web-ifc reuses numeric model
 * ids after `CloseModel`, so a cache must never outlive its model.
 */

import {
  IFCRELASSOCIATES,
  IFCRELDEFINES,
  IFCRELDEFINESBYPROPERTIES,
  IFCRELDEFINESBYTYPE,
} from 'web-ifc';

import type { PropertyApi } from './fetchElementProperties';
import { isObj } from './propertyNormalizer';

/** The web-ifc surface the cache needs on top of {@link PropertyApi}. */
export type CacheableApi = Pick<PropertyApi, 'GetLine' | 'GetLineIDsWithType'> & {
  GetModelSchema(modelID: number): string;
};

/** Everything an element inherits from its type object(s), as raw lines. */
export interface TypeSide {
  /** Name of the first type object that has one. */
  typeName: string | undefined;
  /** The types' `HasPropertySets`, resolved (flattened) — raw lines. */
  psetsRaw: unknown[];
  /** The types' associated material definitions, flattened — raw lines. */
  materialsRaw: unknown[];
}

/** One type object's contribution to {@link TypeSide}. */
interface TypeEntry {
  name: string | undefined;
  psetsRaw: unknown[];
  materialsRaw: unknown[];
}

/**
 * Element → the ids its relationships point at, in web-ifc's order.
 *
 * For each element we keep, per relationship kind, the flattened list of
 * relating ids in the order web-ifc's `getRelatedProperties` would visit
 * them: relationships in scan order, then each relationship's relating ids
 * in attribute order.
 */
interface RelationIndex {
  /** element → `RelatingPropertyDefinition` ids (instance psets / qtos). */
  psets: Map<number, number[]>;
  /** element → `RelatingType` ids. */
  types: Map<number, number[]>;
  /** object (here: type object) → `RelatingMaterial` ids. */
  materials: Map<number, number[]>;
}

/** One relationship supertype to scan, and which relating attributes to read off it. */
interface RelationScan {
  relType: number;
  attrs: { attr: string; into: keyof RelationIndex }[];
}

/**
 * The relationship scans that mirror web-ifc's inverse attributes.
 *
 * IFC2X3 hangs both psets and types off ONE inverse, `IsDefinedBy` →
 * `IfcRelDefines` (and its subtypes), which is why web-ifc's
 * `getTypeProperties` reuses the `IsDefinedBy` key there. IFC4 and later
 * split them into `IsDefinedBy` → `IfcRelDefinesByProperties` and
 * `IsTypedBy` → `IfcRelDefinesByType`. Materials come from
 * `HasAssociations` → `IfcRelAssociates` in every schema.
 */
function scansFor(schema: string): RelationScan[] {
  const materials: RelationScan = {
    relType: IFCRELASSOCIATES,
    attrs: [{ attr: 'RelatingMaterial', into: 'materials' }],
  };
  if (schema === 'IFC2X3') {
    return [
      {
        relType: IFCRELDEFINES,
        attrs: [
          { attr: 'RelatingPropertyDefinition', into: 'psets' },
          { attr: 'RelatingType', into: 'types' },
        ],
      },
      materials,
    ];
  }
  return [
    {
      relType: IFCRELDEFINESBYPROPERTIES,
      attrs: [{ attr: 'RelatingPropertyDefinition', into: 'psets' }],
    },
    { relType: IFCRELDEFINESBYTYPE, attrs: [{ attr: 'RelatingType', into: 'types' }] },
    materials,
  ];
}

/** Read a reference or a list of references as express ids, as web-ifc's `getRelatedProperties` does. */
function refIds(v: unknown): number[] | null {
  if (v === null || v === undefined) return null;
  const list = Array.isArray(v) ? v : [v];
  const out: number[] = [];
  for (const r of list) {
    if (isObj(r) && typeof r.value === 'number') out.push(r.value);
  }
  return out;
}

/** The type object's name, read the way the uncached fetch reads it. */
export function typeObjectName(t: unknown): string | undefined {
  if (!isObj(t)) return undefined;
  const n = t.Name;
  const resolved = isObj(n) ? (n as { value?: unknown }).value : n;
  return typeof resolved === 'string' && resolved !== '' ? resolved : undefined;
}

/**
 * The reference lists the normalizer reads below a property-set definition:
 * a pset's properties (and a complex property's children) and a quantity
 * set's quantities. Nothing else under a pset is ever read.
 */
const READ_REFERENCES = ['HasProperties', 'Quantities'] as const;

/** True for a web-ifc entity reference — `{ type: 5, value: <expressId> }`. */
function isRef(v: unknown): v is { type: 5; value: number } {
  return isObj(v) && v.type === 5;
}

/**
 * Read a property-set definition (IfcPropertySet / IfcElementQuantity) with
 * exactly the references the normalizer follows resolved — the property and
 * quantity lines, recursively through complex properties — and every other
 * reference left as a `{type: 5, value}` ref.
 *
 * The cached path's replacement for `GetLine(id, flatten = true)`, which
 * resolves EVERY reference recursively: for each pset that meant re-reading
 * its IfcOwnerHistory and the person, organisation and application hanging
 * off it — a dozen WASM round-trips per pset, for data nothing reads. That
 * was the largest cost left once relationship lookups were indexed.
 * Resolution of the lines that ARE read follows web-ifc's `FlattenLine`
 * rules (a ref with a falsy id is left alone; an array is resolved only when
 * its first entry is a ref), so the normalizer sees the same values either
 * way — the equivalence tests against the uncached (fully flattened) path
 * are what hold that true. A normalizer change that starts reading another
 * nested reference must add it to `READ_REFERENCES`, and those tests fail
 * until it does.
 */
export function readPropertyDefinition(
  api: Pick<PropertyApi, 'GetLine'>,
  webIfcId: number,
  expressId: number,
): unknown {
  const line = api.GetLine(webIfcId, expressId, false);
  if (!isObj(line)) return line;
  for (const key of READ_REFERENCES) {
    const list = line[key];
    if (!Array.isArray(list) || list.length === 0 || !isRef(list[0])) continue;
    for (let i = 0; i < list.length; i++) {
      const ref: unknown = list[i];
      if (isRef(ref) && ref.value) list[i] = readPropertyDefinition(api, webIfcId, ref.value);
    }
  }
  return line;
}

/**
 * Resolve a type object's `HasPropertySets` into raw pset lines, reading
 * each with `read`. Shared by the cached and uncached paths so their walk
 * cannot drift apart; they differ only in how a pset line is read.
 */
export function resolveTypePsets(t: unknown, read: (expressId: number) => unknown): unknown[] {
  const out: unknown[] = [];
  if (!isObj(t)) return out;
  const has = t.HasPropertySets;
  if (!Array.isArray(has)) return out;
  for (const ref of has) {
    if (isObj(ref) && typeof ref.value === 'number') {
      try {
        const resolved = read(ref.value);
        if (isObj(resolved)) out.push(resolved);
      } catch {
        /* skip — line not resolvable */
      }
    } else if (isObj(ref)) {
      // Already-resolved pset (e.g. from a future recursive=true call path).
      out.push(ref);
    }
  }
  return out;
}

export class ModelPropertyCache {
  /** `undefined` = not built yet; `null` = building failed, use the uncached path. */
  private index: RelationIndex | null | undefined;
  private typeEntries = new Map<number, TypeEntry>();

  constructor(
    private readonly api: CacheableApi,
    readonly webIfcId: number,
  ) {}

  /**
   * Whether this cache can serve reads. Builds the relationship index on
   * first call. A model whose relationships cannot all be read (a corrupt
   * line, a schema web-ifc does not know) disables the cache rather than
   * risk answering differently from web-ifc — the caller then falls back
   * to the uncached fetch.
   */
  usable(): boolean {
    if (this.index === undefined) this.index = this.buildIndex();
    return this.index !== null;
  }

  /**
   * The element's own property-set definitions — the lines
   * `properties.getPropertySets(id, recursive = true, includeTypeProperties = false)`
   * returns, read with {@link readPropertyDefinition}.
   */
  instancePropertySets(expressId: number): unknown[] {
    const ids = this.requireIndex().psets.get(expressId);
    if (!ids) return [];
    return ids.map((id) => readPropertyDefinition(this.api, this.webIfcId, id));
  }

  /**
   * Everything the element inherits from its type object(s). Equivalent to
   * the uncached path's `getTypeProperties` + `HasPropertySets` walk +
   * `getMaterialsProperties(id, recursive = true, includeTypeMaterials = true)`,
   * but each type object is resolved once per model.
   *
   * The returned arrays are fresh, but their elements are shared raw lines —
   * callers must treat them as read-only.
   */
  typeSide(expressId: number): TypeSide {
    const typeIds = this.requireIndex().types.get(expressId) ?? [];
    let typeName: string | undefined;
    const psetsRaw: unknown[] = [];
    const materialsRaw: unknown[] = [];
    for (const typeId of typeIds) {
      const entry = this.typeEntry(typeId);
      if (typeName === undefined) typeName = entry.name;
      psetsRaw.push(...entry.psetsRaw);
      materialsRaw.push(...entry.materialsRaw);
    }
    return { typeName, psetsRaw, materialsRaw };
  }

  /** Number of type objects resolved so far. Exposed for tests. */
  get resolvedTypeCount(): number {
    return this.typeEntries.size;
  }

  // --- internals -------------------------------------------------------------

  private requireIndex(): RelationIndex {
    if (!this.usable()) throw new Error('ModelPropertyCache: relation index unavailable');
    return this.index as RelationIndex;
  }

  private typeEntry(typeId: number): TypeEntry {
    const cached = this.typeEntries.get(typeId);
    if (cached) return cached;
    const t = this.api.GetLine(this.webIfcId, typeId, false);
    const materialIds = this.requireIndex().materials.get(typeId) ?? [];
    const entry: TypeEntry = {
      name: typeObjectName(t),
      psetsRaw: resolveTypePsets(t, (id) => readPropertyDefinition(this.api, this.webIfcId, id)),
      materialsRaw: materialIds.map((id) => this.api.GetLine(this.webIfcId, id, true)),
    };
    this.typeEntries.set(typeId, entry);
    return entry;
  }

  private buildIndex(): RelationIndex | null {
    const index: RelationIndex = { psets: new Map(), types: new Map(), materials: new Map() };
    try {
      const schema = this.api.GetModelSchema(this.webIfcId);
      for (const scan of scansFor(schema)) {
        // includeInherited: the same supertype + subtypes list web-ifc's
        // inverse lookup walks, in the same order.
        const rels = this.api.GetLineIDsWithType(this.webIfcId, scan.relType, true);
        for (let i = 0; i < rels.size(); i++) {
          const rel = this.api.GetLine(this.webIfcId, rels.get(i), false);
          if (!isObj(rel)) continue;
          const related = refIds(rel.RelatedObjects);
          if (!related || related.length === 0) continue;
          for (const { attr, into } of scan.attrs) {
            const relating = refIds(rel[attr]);
            if (relating === null) continue;
            const map = index[into];
            // No de-duplication: web-ifc's inverse lookup does not either, so
            // a relationship listing the same object twice yields its
            // relating object(s) twice there and must do so here.
            for (const obj of related) {
              const list = map.get(obj);
              if (list) list.push(...relating);
              else map.set(obj, [...relating]);
            }
          }
        }
      }
    } catch {
      return null;
    }
    return index;
  }
}

/**
 * The worker's per-model caches, keyed by the app's model UUID.
 *
 * Keyed by UUID rather than web-ifc's numeric id because web-ifc hands a
 * closed model's numeric id to the next model opened — a cache keyed by it
 * would serve the old model's types to the new one.
 */
export class ModelPropertyCaches {
  private caches = new Map<string, ModelPropertyCache>();

  /** The cache for `modelId`, created on first use. */
  for(modelId: string, api: CacheableApi, webIfcId: number): ModelPropertyCache {
    const existing = this.caches.get(modelId);
    // A cache bound to a different numeric id belongs to a model that has
    // since been closed and replaced under the same UUID — never reuse it.
    if (existing && existing.webIfcId === webIfcId) return existing;
    const created = new ModelPropertyCache(api, webIfcId);
    this.caches.set(modelId, created);
    return created;
  }

  /** The cache for `modelId` if one has been created, without creating one. */
  peek(modelId: string): ModelPropertyCache | undefined {
    return this.caches.get(modelId);
  }

  /** Forget one model's cache — call when the model is closed. */
  drop(modelId: string): void {
    this.caches.delete(modelId);
  }

  /** Forget every cache — call when web-ifc itself is torn down. */
  clear(): void {
    this.caches.clear();
  }

  get size(): number {
    return this.caches.size;
  }
}
