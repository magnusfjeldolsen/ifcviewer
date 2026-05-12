/**
 * Phase 4 of the Element Properties Inspector.
 *
 * Pure function: take N `ElementProperties` snapshots and return a synthetic
 * `ElementProperties` representing the **intersection** of their leaf
 * properties:
 *
 *   - For each `PropertyFlatRow.path` present in every input element:
 *       - If all `rawValue` instances are deep-equal → include with that value.
 *       - Otherwise → include with `{ kind: 'varies' }` (sentinel).
 *   - Tree groups (psets / qtos / Identity direct rows) are rebuilt by
 *     walking the common rows. A group only survives if its name appears
 *     across every input; a property only survives if its path appears in
 *     every input. (Walking the common flat rows automatically achieves
 *     this, because the flat-row builder strips paths whose top segment is
 *     not present everywhere.)
 *   - The result identity is synthetic:
 *       - `name` undefined, `expressId`/`globalId` absent.
 *       - `ifcClass` is the shared class if all elements share one, else
 *         the literal `'(mixed)'`.
 *       - `modelId` is the shared model id if all elements share one, else
 *         `'(mixed)'`.
 *       - `ifcTypeCode` mirrors `ifcClass`: shared code if all match, else 0.
 *   - `fetchedAt` = `Date.now()`.
 *
 * The single result is consumed by the same Tree / Flat renderers used for
 * single selection — *no view-specific intersection logic exists*. This is
 * the centralization called out in the plan.
 *
 * Spec: dev/plans/phase-element-inspector.md, "Intersection logic" section.
 */

import type {
  ElementIdentity,
  ElementProperties,
  PropertyFlatRow,
  PropertyGroup,
  PropertyNode,
  PropertyValue,
} from './types';

/** Sentinel modelId / ifcClass used when inputs disagree. */
export const MIXED_SENTINEL = '(mixed)';

/**
 * Compute the intersection of N property snapshots.
 *
 * Edge cases:
 *   - 0 inputs → returns an empty synthetic `ElementProperties`. The caller
 *     should generally avoid this — the panel only invokes us on the
 *     multi-state path, which always has ≥ 2 identities.
 *   - 1 input → returns the input verbatim (no intersection needed).
 */
export function intersectProperties(elements: ElementProperties[]): ElementProperties {
  if (elements.length === 0) {
    return emptyResult();
  }
  if (elements.length === 1) {
    return elements[0];
  }

  // ── Identity synthesis ─────────────────────────────────────
  const identity = synthesizeIdentity(elements.map((e) => e.identity));

  // ── Flat-row intersection ──────────────────────────────────
  // Pick the smallest flat-row array as the seed; we only need to inspect
  // paths that appear in every input, so the smallest bounds the work.
  const seed = elements.reduce((acc, e) => (e.flat.length < acc.flat.length ? e : acc), elements[0]);
  const otherSets: Map<string, PropertyFlatRow>[] = elements
    .filter((e) => e !== seed)
    .map((e) => {
      const m = new Map<string, PropertyFlatRow>();
      for (const row of e.flat) m.set(row.path, row);
      return m;
    });

  const intersectedFlat: PropertyFlatRow[] = [];
  for (const seedRow of seed.flat) {
    // Path must appear in every other element.
    const matches: PropertyFlatRow[] = [seedRow];
    let missing = false;
    for (const other of otherSets) {
      const match = other.get(seedRow.path);
      if (!match) {
        missing = true;
        break;
      }
      matches.push(match);
    }
    if (missing) continue;

    // All present — check whether every rawValue deep-equals the seed.
    const allEqual = matches.every((r) => deepEqualValue(r.rawValue, seedRow.rawValue));
    if (allEqual) {
      // Include the seed row as-is — its displayValue / unit / source /
      // description carry over. (All inputs agreed on value, so any of
      // them would do; we deliberately keep them all if descriptions
      // differ, since we never surface conflicting metadata.)
      intersectedFlat.push(seedRow);
    } else {
      // Differing values → emit a varies row. Unit is intentionally
      // cleared: distinct values may carry distinct units, and Flat view
      // explicitly leaves the unit column empty for varies.
      intersectedFlat.push({
        path: seedRow.path,
        name: seedRow.name,
        rawValue: { kind: 'varies' },
        displayValue: 'varies',
        // Preserve source so group rebuild still knows which bucket
        // (pset / qto / direct) the row belongs in.
        source: seedRow.source,
        // Inherited-from-type only stays true if it stays true everywhere;
        // otherwise it's a meaningful mismatch and we drop it.
        inheritedFromType: matches.every((r) => r.inheritedFromType)
          ? true
          : undefined,
        description: seedRow.description,
      });
    }
  }

  // Keep alphabetical ordering, matching repository.buildFlatRows.
  intersectedFlat.sort((a, b) => a.path.localeCompare(b.path));

  // ── Distinct-value tracking (for tooltip on varies rows) ──
  // Attach the distinct display strings per varies path so the panel can
  // render a tooltip listing them. We expose this on the flat rows via a
  // separate parallel map so the PropertyFlatRow type stays unchanged.
  // (Stored on a non-enumerable property to avoid leaking into JSON dumps
  // or test snapshots that don't expect it.)
  const distinctMap = collectDistinctValues(elements, intersectedFlat);

  // ── Group rebuild (Tree view) ──────────────────────────────
  const { direct, psets, qtos } = rebuildGroups(elements, intersectedFlat);

  const result: ElementProperties = {
    identity,
    direct,
    psets,
    qtos,
    // Materials intersection is non-trivial (heterogeneous shapes:
    // material-ref vs layered children). v1: include only the materials
    // that appear by name in every input. Future work can do deeper
    // intersection of layer sets etc.
    materials: intersectMaterials(elements),
    flat: intersectedFlat,
    fetchedAt: Date.now(),
  };

  // Attach distinct-value lookup as a non-enumerable property so callers
  // who type-cast / inspect via dot access still see it. The InspectorPanel
  // reads this; tests that only check enumerable shape are unaffected.
  Object.defineProperty(result, '__variesDistinct', {
    value: distinctMap,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return result;
}

/**
 * Look up distinct display values for a varies path on an intersected
 * `ElementProperties`. Returns an empty array if the path isn't a varies
 * row or the lookup map is unavailable (single-select case).
 */
export function getDistinctValuesForPath(
  props: ElementProperties,
  path: string,
): string[] {
  const map = (props as unknown as { __variesDistinct?: Map<string, string[]> }).__variesDistinct;
  if (!map) return [];
  return map.get(path) ?? [];
}

// ── Internals ──────────────────────────────────────────────────

function emptyResult(): ElementProperties {
  return {
    identity: {
      modelId: MIXED_SENTINEL,
      expressId: 0,
      ifcClass: MIXED_SENTINEL,
      ifcTypeCode: 0,
    },
    direct: [],
    psets: [],
    qtos: [],
    materials: [],
    flat: [],
    fetchedAt: Date.now(),
  };
}

function synthesizeIdentity(ids: ElementIdentity[]): ElementIdentity {
  const firstClass = ids[0].ifcClass;
  const firstTypeCode = ids[0].ifcTypeCode;
  const firstModel = ids[0].modelId;
  const sameClass = ids.every((i) => i.ifcClass === firstClass);
  const sameModel = ids.every((i) => i.modelId === firstModel);
  const sameTypeCode = ids.every((i) => i.ifcTypeCode === firstTypeCode);
  return {
    modelId: sameModel ? firstModel : MIXED_SENTINEL,
    // expressId is required by the type but meaningless for a synthetic
    // multi-identity; choose 0 by convention.
    expressId: 0,
    ifcClass: sameClass ? firstClass : MIXED_SENTINEL,
    ifcTypeCode: sameClass && sameTypeCode ? firstTypeCode : 0,
    // name / globalId / tag / etc. intentionally omitted.
  };
}

/**
 * Deep-equality on PropertyValue. We compare the discriminator first,
 * then recurse into structured kinds. Two `single` values are equal iff
 * their `value` (and rawValue) match. Numbers compare with strict equality
 * (no epsilon — IFC values stored as floats round-trip cleanly because we
 * don't re-derive them).
 */
function deepEqualValue(a: PropertyValue, b: PropertyValue): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'single': {
      const bs = b as { kind: 'single'; value: unknown; raw: { typeCode: number; value: unknown } };
      // Compare normalized values; fall through to raw if normalized
      // values are loosely equivalent but distinguishable at the raw layer.
      if (!Object.is(a.value, bs.value)) return false;
      if (a.raw.typeCode !== bs.raw.typeCode) return false;
      return rawValuesEqual(a.raw.value, bs.raw.value);
    }
    case 'enumerated': {
      const be = b as { kind: 'enumerated'; values: string[]; enumRef?: string };
      if (a.enumRef !== be.enumRef) return false;
      if (a.values.length !== be.values.length) return false;
      for (let i = 0; i < a.values.length; i++) {
        if (a.values[i] !== be.values[i]) return false;
      }
      return true;
    }
    case 'list': {
      const bl = b as { kind: 'list'; values: PropertyValue[] };
      if (a.values.length !== bl.values.length) return false;
      for (let i = 0; i < a.values.length; i++) {
        if (!deepEqualValue(a.values[i], bl.values[i])) return false;
      }
      return true;
    }
    case 'bounded': {
      const bb = b as { kind: 'bounded'; lower?: number; upper?: number; setpoint?: number };
      return a.lower === bb.lower && a.upper === bb.upper && a.setpoint === bb.setpoint;
    }
    case 'table': {
      const bt = b as { kind: 'table'; defining: PropertyValue[]; defined: PropertyValue[] };
      if (a.defining.length !== bt.defining.length) return false;
      if (a.defined.length !== bt.defined.length) return false;
      for (let i = 0; i < a.defining.length; i++) {
        if (!deepEqualValue(a.defining[i], bt.defining[i])) return false;
      }
      for (let i = 0; i < a.defined.length; i++) {
        if (!deepEqualValue(a.defined[i], bt.defined[i])) return false;
      }
      return true;
    }
    case 'complex': {
      // Complex values shouldn't reach the flat rows (they're flattened
      // into children by buildFlatRows). Fall back to comparing node lists.
      const bc = b as { kind: 'complex'; children: PropertyNode[] };
      if (a.children.length !== bc.children.length) return false;
      for (let i = 0; i < a.children.length; i++) {
        if (a.children[i].key !== bc.children[i].key) return false;
        if (!deepEqualValue(a.children[i].value, bc.children[i].value)) return false;
      }
      return true;
    }
    case 'quantity': {
      const bq = b as {
        kind: 'quantity';
        quantityKind: 'length' | 'area' | 'volume' | 'count' | 'weight' | 'time';
        value: number;
      };
      return a.quantityKind === bq.quantityKind && Object.is(a.value, bq.value);
    }
    case 'material-ref': {
      const bm = b as { kind: 'material-ref'; materialName: string; expressId: number };
      return a.materialName === bm.materialName && a.expressId === bm.expressId;
    }
    case 'varies':
      // Two varies are vacuously equal.
      return true;
  }
}

/** Strict equality for raw value payloads, with array support. */
function rawValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!rawValuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  // Plain-object comparison stays shallow on purpose — IFC raw payloads
  // are primitives or small wrapper objects; we never reach here in
  // practice once normalizeTypedValue has flattened things.
  return false;
}

/**
 * Compute the distinct display strings per varies path. Used by the panel
 * to render a tooltip listing the (capped) set of distinct values.
 * Capping is the caller's job (the renderer trims at 5 + "+N more").
 */
function collectDistinctValues(
  elements: ElementProperties[],
  intersected: PropertyFlatRow[],
): Map<string, string[]> {
  const variesPaths = new Set<string>();
  for (const row of intersected) {
    if (row.rawValue.kind === 'varies') variesPaths.add(row.path);
  }
  const out = new Map<string, string[]>();
  if (variesPaths.size === 0) return out;

  for (const path of variesPaths) {
    const seen = new Set<string>();
    const distinct: string[] = [];
    for (const e of elements) {
      const row = e.flat.find((r) => r.path === path);
      if (!row) continue;
      const display = row.displayValue ?? '';
      if (!seen.has(display)) {
        seen.add(display);
        distinct.push(display);
      }
    }
    out.set(path, distinct);
  }
  return out;
}

/**
 * Walk the intersected flat rows and rebuild `direct` / `psets` / `qtos`.
 * The shape of each output mirrors the original repository idiom enough
 * for the existing renderers to consume without changes.
 */
function rebuildGroups(
  elements: ElementProperties[],
  intersectedFlat: PropertyFlatRow[],
): {
  direct: PropertyNode[];
  psets: PropertyGroup[];
  qtos: PropertyGroup[];
} {
  // Build helper indexes keyed by group name → PropertyGroup snapshot from
  // each input. We use these to decide whether a group survives (must
  // appear in every input) and to pick a representative for the group's
  // description / inheritedFromType flags.
  const groupNamesPerElement: Array<Set<string>> = elements.map((e) => {
    const s = new Set<string>();
    for (const g of e.psets) s.add(`pset:${g.name}`);
    for (const g of e.qtos) s.add(`qto:${g.name}`);
    return s;
  });

  // Survives := name present in every input set.
  function survives(key: string): boolean {
    return groupNamesPerElement.every((s) => s.has(key));
  }

  // Pick the first input's pset/qto with the matching name as the
  // representative for metadata (description / inheritedFromType).
  function findRep(
    elements: ElementProperties[],
    name: string,
    bucket: 'psets' | 'qtos',
  ): PropertyGroup | undefined {
    for (const e of elements) {
      const g = e[bucket].find((gg) => gg.name === name);
      if (g) return g;
    }
    return undefined;
  }

  const direct: PropertyNode[] = [];
  const psetsByName = new Map<string, PropertyNode[]>();
  const qtosByName = new Map<string, PropertyNode[]>();

  for (const row of intersectedFlat) {
    // Identity rows have path "Identity.<key>".
    if (row.source === 'direct' && row.path.startsWith('Identity.')) {
      direct.push(flatRowToNode(row));
      continue;
    }
    // Pset / Qto rows have path "<groupName>.<key>" — top segment is name.
    const firstDot = row.path.indexOf('.');
    if (firstDot < 0) continue;
    const groupName = row.path.slice(0, firstDot);

    if (row.source === 'qto') {
      if (!survives(`qto:${groupName}`)) continue;
      let bucket = qtosByName.get(groupName);
      if (!bucket) {
        bucket = [];
        qtosByName.set(groupName, bucket);
      }
      bucket.push(flatRowToNode(row));
    } else {
      // Default bucket for pset-shaped sources (pset / type).
      if (!survives(`pset:${groupName}`)) continue;
      let bucket = psetsByName.get(groupName);
      if (!bucket) {
        bucket = [];
        psetsByName.set(groupName, bucket);
      }
      bucket.push(flatRowToNode(row));
    }
  }

  const psets: PropertyGroup[] = [];
  for (const [name, props] of psetsByName) {
    const rep = findRep(elements, name, 'psets');
    psets.push({
      name,
      source: rep?.source ?? 'pset',
      inheritedFromType: rep?.inheritedFromType,
      description: rep?.description,
      properties: props,
    });
  }

  const qtos: PropertyGroup[] = [];
  for (const [name, props] of qtosByName) {
    const rep = findRep(elements, name, 'qtos');
    qtos.push({
      name,
      source: rep?.source ?? 'qto',
      inheritedFromType: rep?.inheritedFromType,
      description: rep?.description,
      properties: props,
    });
  }

  return { direct, psets, qtos };
}

/** Reconstruct a leaf PropertyNode from an intersected flat row. */
function flatRowToNode(row: PropertyFlatRow): PropertyNode {
  return {
    key: row.name,
    value: row.rawValue,
    unit: row.unit,
    description: row.description,
    source: row.source,
    inheritedFromType: row.inheritedFromType,
  };
}

/**
 * Intersect material references by `materialName`. A material survives
 * iff its name appears in every input element's materials list. v1 only
 * handles `material-ref`; other shapes are dropped (with a console.warn
 * for forward visibility — multi-select on layered materials is a v2
 * feature, see plan).
 */
function intersectMaterials(elements: ElementProperties[]): PropertyValue[] {
  if (elements.length === 0) return [];

  const namesPerElement: Array<Set<string>> = elements.map((e) => {
    const s = new Set<string>();
    for (const m of e.materials) {
      if (m.kind === 'material-ref') s.add(m.materialName);
    }
    return s;
  });

  const candidate = namesPerElement[0];
  const intersection: PropertyValue[] = [];
  for (const name of candidate) {
    if (namesPerElement.every((s) => s.has(name))) {
      // Pull the first instance with that name from element 0 to
      // preserve its expressId / shape.
      const ref = elements[0].materials.find(
        (m) => m.kind === 'material-ref' && m.materialName === name,
      );
      if (ref) intersection.push(ref);
    }
  }
  return intersection;
}
