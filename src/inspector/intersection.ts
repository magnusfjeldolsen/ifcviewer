/**
 * Phase 4 of the Element Properties Inspector — refactored in Phase 1 of
 * the bulk-property-access work into an **incremental fold**.
 *
 * Pure module: take N `ElementProperties` snapshots and reduce them into a
 * single synthetic `ElementProperties` representing the **intersection** of
 * their leaf properties:
 *
 *   - For each `PropertyFlatRow.path` present in every input element:
 *       - If all `rawValue` instances are deep-equal → include with that value.
 *       - Otherwise → include with `{ kind: 'varies' }` (sentinel).
 *   - Tree groups (psets / qtos / Identity direct rows) are rebuilt by
 *     walking the common rows. A group only survives if its name appears
 *     across every input.
 *   - Synthetic identity:
 *       - `name` undefined, `expressId`/`globalId` absent.
 *       - `ifcClass` is the shared class if all elements share one, else `'(mixed)'`.
 *       - `modelId` is the shared model id if all elements share one, else `'(mixed)'`.
 *       - `ifcTypeCode` mirrors `ifcClass`: shared code if all match, else 0.
 *   - `fetchedAt` = `Date.now()`.
 *
 * The single result is consumed by the same Tree / Flat renderers used for
 * single selection — *no view-specific intersection logic exists*.
 *
 * Fold API:
 *   - `intersectSeed(props)` — start a running intersection with the first element.
 *   - `intersectStep(running, props)` — fold another element in.
 *   - `intersectFinalize(running)` — emit the synthetic `ElementProperties`.
 *
 * Constraints honoured by the fold:
 *   - **O(1) memory in N**: only the running intersection (a thin per-path
 *     index + distinct-value lookups) is kept. Per-element `ElementProperties`
 *     are NEVER retained between steps. Used by the IFC worker's
 *     `handleIntersect` so worker memory does not grow with selection size.
 *   - **Deep-equality semantics identical to the previous batch function**:
 *     guarded by the `fold ≡ batch` regression-lock test in
 *     `tests/inspector-intersection.test.ts`.
 *
 * The batch entry point `intersectProperties(elements)` is preserved as a
 * thin wrapper over the fold so existing main-thread callers continue to
 * work unchanged.
 *
 * Spec: dev/plans/handoff-bulk-property-access.md, "Incremental intersect"
 * section. Original spec: dev/plans/phase-element-inspector.md.
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

// ---------------------------------------------------------------------------
// Incremental fold API
// ---------------------------------------------------------------------------

/**
 * Per-path running entry in the fold.
 *
 * Tracks just enough state to:
 *  - decide whether the path still survives (`alive`);
 *  - decide whether values still agree (`varies`);
 *  - rebuild the synthetic flat row on finalize (`seedRow`);
 *  - keep `inheritedFromType: true` only while every input agreed (`allInherited`);
 *  - collect distinct display strings for the varies tooltip (`distinctDisplays`).
 *
 * The seedRow is a reference to the FIRST input's row; we never copy or
 * mutate it during the fold. On finalize we either emit the seedRow as-is
 * (all values agreed) or build a synthetic varies row from it.
 */
interface RunningPath {
  /** Seed row from the first element — source of name / source / unit / description. */
  seedRow: PropertyFlatRow;
  /** Whether the path still appears in every element seen so far. */
  alive: boolean;
  /** Whether every value seen so far deep-equals the seed's `rawValue`. */
  agrees: boolean;
  /** Whether every row seen so far had `inheritedFromType === true`. */
  allInherited: boolean;
  /**
   * Distinct display strings encountered, in first-seen order. Populated
   * lazily once `agrees` flips to false. Capped at a reasonable size by
   * downstream renderers; we collect all distinct entries here so the tooltip
   * cap is the only place that decides what to drop.
   */
  distinctDisplays: string[];
  /** Companion to `distinctDisplays` for O(1) duplicate detection. */
  distinctSeen: Set<string>;
}

/**
 * Running intersection state passed between fold steps.
 *
 * Holds only:
 *  - the per-path index (`paths`);
 *  - the running identity summary (collapses as we see disagreements);
 *  - the surviving pset/qto group-name sets (a group only survives if every
 *    input has it — same rule as the old batch implementation);
 *  - a sample group descriptor per surviving group (description /
 *    inheritedFromType, taken from the FIRST element to have that group);
 *  - the running material-name intersection.
 *
 * Memory is O(distinct-paths + distinct-groups + distinct-materials), which
 * is **independent of N**. Inputs are NOT retained.
 */
export interface RunningIntersection {
  /** Path → running entry. Insertion order matches the seed's flat-row order. */
  paths: Map<string, RunningPath>;
  /** Running identity collapse state. */
  identity: {
    modelId: string;
    sameModel: boolean;
    ifcClass: string;
    sameClass: boolean;
    ifcTypeCode: number;
    sameTypeCode: boolean;
  };
  /** Surviving pset group names. */
  psetNames: Set<string>;
  /** Surviving qto group names. */
  qtoNames: Set<string>;
  /** Sample pset descriptor per name (first occurrence). */
  psetSamples: Map<string, PropertyGroup>;
  /** Sample qto descriptor per name (first occurrence). */
  qtoSamples: Map<string, PropertyGroup>;
  /** Surviving material names. */
  materialNames: Set<string>;
  /** Sample material-ref value per name (first occurrence — for shape preservation). */
  materialSamples: Map<string, PropertyValue>;
  /** Number of elements folded so far. */
  count: number;
}

/**
 * Seed a running intersection with the first element.
 *
 * Critical invariant: after this call, `running.paths` mirrors the seed's
 * flat-row order so finalize can emit rows in their natural order before the
 * final alphabetical sort. The batch function used `.flat[0]` as the seed
 * with no smallest-flat optimization tradeoff for the incremental form (we
 * cannot know the smallest array up front).
 */
export function intersectSeed(seed: ElementProperties): RunningIntersection {
  const paths = new Map<string, RunningPath>();
  for (const row of seed.flat) {
    paths.set(row.path, {
      seedRow: row,
      alive: true,
      agrees: true,
      allInherited: row.inheritedFromType === true,
      distinctDisplays: [],
      distinctSeen: new Set<string>(),
    });
  }

  const psetNames = new Set<string>();
  const psetSamples = new Map<string, PropertyGroup>();
  for (const g of seed.psets) {
    psetNames.add(g.name);
    psetSamples.set(g.name, g);
  }
  const qtoNames = new Set<string>();
  const qtoSamples = new Map<string, PropertyGroup>();
  for (const g of seed.qtos) {
    qtoNames.add(g.name);
    qtoSamples.set(g.name, g);
  }

  const materialNames = new Set<string>();
  const materialSamples = new Map<string, PropertyValue>();
  for (const m of seed.materials) {
    if (m.kind === 'material-ref') {
      if (!materialNames.has(m.materialName)) {
        materialNames.add(m.materialName);
        materialSamples.set(m.materialName, m);
      }
    }
  }

  return {
    paths,
    identity: {
      modelId: seed.identity.modelId,
      sameModel: true,
      ifcClass: seed.identity.ifcClass,
      sameClass: true,
      ifcTypeCode: seed.identity.ifcTypeCode,
      sameTypeCode: true,
    },
    psetNames,
    qtoNames,
    psetSamples,
    qtoSamples,
    materialNames,
    materialSamples,
    count: 1,
  };
}

/**
 * Fold one more element into the running intersection.
 *
 * Drops:
 *  - paths that don't appear in `next` (mark `alive = false`);
 *  - groups that don't appear in `next` (remove from surviving sets);
 *  - materials that don't appear in `next` (remove from surviving names).
 *
 * For paths that DO appear in both, compares the value to the seed's value
 * via the same deep-equality predicate used by the previous batch function;
 * on disagreement flips `agrees = false` and seeds `distinctDisplays` with
 * the seed's and next's display strings.
 *
 * Returns the SAME `running` object (mutated in place). This is a deliberate
 * choice for the worker fold: no per-step allocation of a new state.
 */
export function intersectStep(
  running: RunningIntersection,
  next: ElementProperties,
): RunningIntersection {
  // ── Identity collapse ───────────────────────────────────────────
  const ni = next.identity;
  if (running.identity.sameModel && ni.modelId !== running.identity.modelId) {
    running.identity.sameModel = false;
  }
  if (running.identity.sameClass && ni.ifcClass !== running.identity.ifcClass) {
    running.identity.sameClass = false;
  }
  if (running.identity.sameTypeCode && ni.ifcTypeCode !== running.identity.ifcTypeCode) {
    running.identity.sameTypeCode = false;
  }

  // ── Path-set intersection + value agreement ─────────────────────
  // Build a quick lookup over `next.flat` so we can mark presence and
  // grab the matching row in one pass without an O(N*M) scan.
  const nextRows = new Map<string, PropertyFlatRow>();
  for (const row of next.flat) nextRows.set(row.path, row);

  for (const entry of running.paths.values()) {
    if (!entry.alive) continue;
    const match = nextRows.get(entry.seedRow.path);
    if (!match) {
      entry.alive = false;
      continue;
    }
    if (entry.allInherited && match.inheritedFromType !== true) {
      entry.allInherited = false;
    }
    if (!entry.agrees) {
      // Still need to collect the distinct display for the tooltip.
      const disp = match.displayValue ?? '';
      if (!entry.distinctSeen.has(disp)) {
        entry.distinctSeen.add(disp);
        entry.distinctDisplays.push(disp);
      }
      continue;
    }
    if (!deepEqualValue(match.rawValue, entry.seedRow.rawValue)) {
      // Values disagree → seed the distinct list with seed's display and
      // this element's display.
      entry.agrees = false;
      const seedDisp = entry.seedRow.displayValue ?? '';
      if (!entry.distinctSeen.has(seedDisp)) {
        entry.distinctSeen.add(seedDisp);
        entry.distinctDisplays.push(seedDisp);
      }
      const nextDisp = match.displayValue ?? '';
      if (!entry.distinctSeen.has(nextDisp)) {
        entry.distinctSeen.add(nextDisp);
        entry.distinctDisplays.push(nextDisp);
      }
    }
  }

  // ── Group survival ──────────────────────────────────────────────
  const nextPsetNames = new Set<string>();
  for (const g of next.psets) nextPsetNames.add(g.name);
  for (const name of [...running.psetNames]) {
    if (!nextPsetNames.has(name)) {
      running.psetNames.delete(name);
      running.psetSamples.delete(name);
    }
  }
  const nextQtoNames = new Set<string>();
  for (const g of next.qtos) nextQtoNames.add(g.name);
  for (const name of [...running.qtoNames]) {
    if (!nextQtoNames.has(name)) {
      running.qtoNames.delete(name);
      running.qtoSamples.delete(name);
    }
  }

  // ── Material survival ───────────────────────────────────────────
  const nextMaterialNames = new Set<string>();
  for (const m of next.materials) {
    if (m.kind === 'material-ref') nextMaterialNames.add(m.materialName);
  }
  for (const name of [...running.materialNames]) {
    if (!nextMaterialNames.has(name)) {
      running.materialNames.delete(name);
      running.materialSamples.delete(name);
    }
  }

  running.count += 1;
  return running;
}

/**
 * Finalize the fold into a synthetic `ElementProperties`.
 *
 * Builds flat rows from the surviving entries, rebuilds groups by walking
 * the surviving flat rows (so direct/pset/qto buckets remain stable), and
 * synthesizes the identity / materials / distinct-value tooltip map.
 */
export function intersectFinalize(running: RunningIntersection): ElementProperties {
  // ── Flat rows (alphabetically sorted, matching repository.buildFlatRows) ──
  const intersectedFlat: PropertyFlatRow[] = [];
  for (const entry of running.paths.values()) {
    if (!entry.alive) continue;
    if (entry.agrees) {
      intersectedFlat.push(entry.seedRow);
    } else {
      intersectedFlat.push({
        path: entry.seedRow.path,
        name: entry.seedRow.name,
        rawValue: { kind: 'varies' },
        displayValue: 'varies',
        // Preserve source so group rebuild knows which bucket the row belongs in.
        source: entry.seedRow.source,
        // Inherited-from-type only stays true if it stayed true everywhere.
        inheritedFromType: entry.allInherited ? true : undefined,
        description: entry.seedRow.description,
      });
    }
  }
  intersectedFlat.sort((a, b) => a.path.localeCompare(b.path));

  // ── Distinct-value tracking for varies tooltip ──
  const distinctMap = new Map<string, string[]>();
  for (const entry of running.paths.values()) {
    if (!entry.alive) continue;
    if (entry.agrees) continue;
    distinctMap.set(entry.seedRow.path, entry.distinctDisplays);
  }

  // ── Identity synthesis ──
  const ident = running.identity;
  const identity: ElementIdentity = {
    modelId: ident.sameModel ? ident.modelId : MIXED_SENTINEL,
    expressId: 0,
    ifcClass: ident.sameClass ? ident.ifcClass : MIXED_SENTINEL,
    ifcTypeCode: ident.sameClass && ident.sameTypeCode ? ident.ifcTypeCode : 0,
  };

  // ── Group rebuild (Tree view) ──
  const direct: PropertyNode[] = [];
  const psetsByName = new Map<string, PropertyNode[]>();
  const qtosByName = new Map<string, PropertyNode[]>();
  for (const row of intersectedFlat) {
    if (row.source === 'direct' && row.path.startsWith('Identity.')) {
      direct.push(flatRowToNode(row));
      continue;
    }
    const firstDot = row.path.indexOf('.');
    if (firstDot < 0) continue;
    const groupName = row.path.slice(0, firstDot);
    if (row.source === 'qto') {
      if (!running.qtoNames.has(groupName)) continue;
      let bucket = qtosByName.get(groupName);
      if (!bucket) {
        bucket = [];
        qtosByName.set(groupName, bucket);
      }
      bucket.push(flatRowToNode(row));
    } else {
      if (!running.psetNames.has(groupName)) continue;
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
    const rep = running.psetSamples.get(name);
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
    const rep = running.qtoSamples.get(name);
    qtos.push({
      name,
      source: rep?.source ?? 'qto',
      inheritedFromType: rep?.inheritedFromType,
      description: rep?.description,
      properties: props,
    });
  }

  // ── Materials ──
  // Materials survive iff their name appeared in every input. We preserve
  // the FIRST element's instance for shape (expressId etc.).
  const materials: PropertyValue[] = [];
  for (const name of running.materialNames) {
    const sample = running.materialSamples.get(name);
    if (sample) materials.push(sample);
  }

  const result: ElementProperties = {
    identity,
    direct,
    psets,
    qtos,
    materials,
    flat: intersectedFlat,
    fetchedAt: Date.now(),
  };

  Object.defineProperty(result, '__variesDistinct', {
    value: distinctMap,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Batch wrapper — preserves the existing main-thread API
// ---------------------------------------------------------------------------

/**
 * Compute the intersection of N property snapshots.
 *
 * Thin wrapper over the fold so existing main-thread callers (and any
 * tests that call `intersectProperties(...)` directly) keep working
 * unchanged. The fold is the source of truth; this function exists for
 * backwards compatibility and as a regression-lock target.
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
  let running = intersectSeed(elements[0]);
  for (let i = 1; i < elements.length; i++) {
    running = intersectStep(running, elements[i]);
  }
  return intersectFinalize(running);
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

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
 * Deep-equality on PropertyValue. We compare the discriminator first,
 * then recurse into structured kinds. Two `single` values are equal iff
 * their `value` (and rawValue) match. Numbers compare with strict equality
 * (no epsilon — IFC values stored as floats round-trip cleanly because we
 * don't re-derive them).
 *
 * Kept here (not extracted) because the fold owns the only call site.
 */
function deepEqualValue(a: PropertyValue, b: PropertyValue): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'single': {
      const bs = b as { kind: 'single'; value: unknown; raw: { typeCode: number; value: unknown } };
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
  return false;
}
