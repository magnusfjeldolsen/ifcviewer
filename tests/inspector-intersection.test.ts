import { describe, it, expect } from 'vitest';
import {
  intersectProperties,
  intersectSeed,
  intersectStep,
  intersectFinalize,
  getDistinctValuesForPath,
  MIXED_SENTINEL,
} from '../src/inspector/intersection';
import type {
  ElementProperties,
  PropertyFlatRow,
  PropertyGroup,
  PropertyValue,
} from '../src/inspector/types';

/**
 * Tests cover the contract from the plan:
 *   - Identical elements → identical-shaped intersection (no varies).
 *   - Differing value at a path → that row goes to `kind: 'varies'`.
 *   - Path present in some but not all inputs → dropped.
 *   - Group present in some but not all inputs → dropped.
 *   - Mixed ifcClass / modelId → synthesized to '(mixed)'.
 *   - All-same modelId → identity.modelId is the shared value.
 *   - Empty input → explicit empty synthetic.
 *   - Distinct-value map exposed via getDistinctValuesForPath for varies rows.
 */

// ── Fixture helpers ────────────────────────────────────────────

function singleValue(value: string | number | boolean | null, typeCode = 0): PropertyValue {
  return { kind: 'single', value, raw: { typeCode, value } };
}

function flatRow(
  path: string,
  rawValue: PropertyValue,
  source: PropertyFlatRow['source'] = 'pset',
  extra: Partial<PropertyFlatRow> = {},
): PropertyFlatRow {
  return {
    path,
    name: path.split('.').pop() ?? path,
    rawValue,
    displayValue: displayFor(rawValue),
    source,
    ...extra,
  };
}

function displayFor(v: PropertyValue): string {
  if (v.kind === 'single') return v.value === null ? '' : String(v.value);
  if (v.kind === 'quantity') return String(v.value);
  return '';
}

function psetGroup(name: string, props: PropertyFlatRow[]): PropertyGroup {
  return {
    name,
    source: 'pset',
    properties: props.map((r) => ({
      key: r.name,
      value: r.rawValue,
      unit: r.unit,
      source: r.source,
    })),
  };
}

function makeElement(over: Partial<ElementProperties> & { id?: number; modelId?: string; ifcClass?: string } = {}): ElementProperties {
  const id = over.id ?? 1;
  const modelId = over.modelId ?? 'model-A';
  const ifcClass = over.ifcClass ?? 'IfcWall';
  const psets: PropertyGroup[] = over.psets ?? [
    psetGroup('Pset_WallCommon', [
      flatRow('Pset_WallCommon.LoadBearing', singleValue(true)),
      flatRow('Pset_WallCommon.IsExternal', singleValue(true)),
    ]),
  ];
  const qtos: PropertyGroup[] = over.qtos ?? [];
  // Build flat rows from groups (matches repository idiom).
  const flat: PropertyFlatRow[] = over.flat ?? [];
  if (over.flat === undefined) {
    for (const g of psets) {
      for (const p of g.properties) {
        flat.push(flatRow(`${g.name}.${p.key}`, p.value, 'pset', { unit: p.unit }));
      }
    }
    for (const g of qtos) {
      for (const p of g.properties) {
        flat.push(flatRow(`${g.name}.${p.key}`, p.value, 'qto', { unit: p.unit }));
      }
    }
    flat.sort((a, b) => a.path.localeCompare(b.path));
  }
  return {
    identity: { modelId, expressId: id, ifcClass, ifcTypeCode: 1 },
    direct: over.direct ?? [],
    psets,
    qtos,
    materials: over.materials ?? [],
    flat,
    fetchedAt: over.fetchedAt ?? Date.now(),
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe('intersectProperties', () => {
  it('returns empty synthetic for zero inputs', () => {
    const r = intersectProperties([]);
    expect(r.flat).toEqual([]);
    expect(r.psets).toEqual([]);
    expect(r.identity.modelId).toBe(MIXED_SENTINEL);
    expect(r.identity.ifcClass).toBe(MIXED_SENTINEL);
  });

  it('returns the single input verbatim when given one element', () => {
    const e = makeElement({ id: 7 });
    const r = intersectProperties([e]);
    expect(r).toBe(e); // identity — no copying
  });

  it('two identical elements → all common rows preserved, no varies', () => {
    const a = makeElement({ id: 1 });
    const b = makeElement({ id: 2 });
    const r = intersectProperties([a, b]);
    expect(r.flat.length).toBe(2);
    for (const row of r.flat) {
      expect(row.rawValue.kind).toBe('single');
    }
    expect(r.psets).toHaveLength(1);
    expect(r.psets[0].name).toBe('Pset_WallCommon');
    expect(r.psets[0].properties).toHaveLength(2);
  });

  it('one differing value at one path → that row goes to varies, others unchanged', () => {
    const a = makeElement({
      id: 1,
      psets: [
        psetGroup('Pset_WallCommon', [
          flatRow('Pset_WallCommon.LoadBearing', singleValue(true)),
          flatRow('Pset_WallCommon.IsExternal', singleValue(true)),
        ]),
      ],
    });
    const b = makeElement({
      id: 2,
      psets: [
        psetGroup('Pset_WallCommon', [
          flatRow('Pset_WallCommon.LoadBearing', singleValue(false)),
          flatRow('Pset_WallCommon.IsExternal', singleValue(true)),
        ]),
      ],
    });
    const r = intersectProperties([a, b]);
    const lb = r.flat.find((row) => row.path === 'Pset_WallCommon.LoadBearing');
    const ext = r.flat.find((row) => row.path === 'Pset_WallCommon.IsExternal');
    expect(lb).toBeDefined();
    expect(lb!.rawValue.kind).toBe('varies');
    expect(ext).toBeDefined();
    expect(ext!.rawValue.kind).toBe('single');
  });

  it('a path present in only some elements is not in the result', () => {
    const a = makeElement({
      id: 1,
      psets: [
        psetGroup('Pset_WallCommon', [
          flatRow('Pset_WallCommon.LoadBearing', singleValue(true)),
          flatRow('Pset_WallCommon.OnlyOnA', singleValue('x')),
        ]),
      ],
    });
    const b = makeElement({
      id: 2,
      psets: [
        psetGroup('Pset_WallCommon', [
          flatRow('Pset_WallCommon.LoadBearing', singleValue(true)),
        ]),
      ],
    });
    const r = intersectProperties([a, b]);
    const onlyOnA = r.flat.find((row) => row.path === 'Pset_WallCommon.OnlyOnA');
    expect(onlyOnA).toBeUndefined();
    const lb = r.flat.find((row) => row.path === 'Pset_WallCommon.LoadBearing');
    expect(lb).toBeDefined();
  });

  it('a group present in only some elements is dropped from psets', () => {
    const a = makeElement({
      id: 1,
      psets: [
        psetGroup('Pset_OnlyOnA', [
          flatRow('Pset_OnlyOnA.X', singleValue(1)),
        ]),
        psetGroup('Pset_Common', [
          flatRow('Pset_Common.Y', singleValue(2)),
        ]),
      ],
    });
    const b = makeElement({
      id: 2,
      psets: [
        psetGroup('Pset_Common', [
          flatRow('Pset_Common.Y', singleValue(2)),
        ]),
      ],
    });
    const r = intersectProperties([a, b]);
    expect(r.psets).toHaveLength(1);
    expect(r.psets[0].name).toBe('Pset_Common');
  });

  it('completely disjoint psets → empty psets[]', () => {
    const a = makeElement({
      id: 1,
      psets: [psetGroup('Pset_A', [flatRow('Pset_A.X', singleValue(1))])],
    });
    const b = makeElement({
      id: 2,
      psets: [psetGroup('Pset_B', [flatRow('Pset_B.Y', singleValue(2))])],
    });
    const r = intersectProperties([a, b]);
    expect(r.psets).toEqual([]);
    expect(r.flat).toEqual([]);
  });

  it('mixed ifcClass → synthetic identity has ifcClass "(mixed)"', () => {
    const a = makeElement({ id: 1, ifcClass: 'IfcWall' });
    const b = makeElement({ id: 2, ifcClass: 'IfcDoor' });
    const r = intersectProperties([a, b]);
    expect(r.identity.ifcClass).toBe(MIXED_SENTINEL);
    // ifcTypeCode degrades to 0 when classes differ.
    expect(r.identity.ifcTypeCode).toBe(0);
  });

  it('shared ifcClass → synthetic identity carries that class', () => {
    const a = makeElement({ id: 1, ifcClass: 'IfcWall' });
    const b = makeElement({ id: 2, ifcClass: 'IfcWall' });
    const r = intersectProperties([a, b]);
    expect(r.identity.ifcClass).toBe('IfcWall');
  });

  it('all-same modelId → identity.modelId is that model', () => {
    const a = makeElement({ id: 1, modelId: 'model-A' });
    const b = makeElement({ id: 2, modelId: 'model-A' });
    const r = intersectProperties([a, b]);
    expect(r.identity.modelId).toBe('model-A');
  });

  it('mixed modelIds → identity.modelId is "(mixed)"', () => {
    const a = makeElement({ id: 1, modelId: 'model-A' });
    const b = makeElement({ id: 2, modelId: 'model-B' });
    const r = intersectProperties([a, b]);
    expect(r.identity.modelId).toBe(MIXED_SENTINEL);
  });

  it('synthetic identity omits name and globalId', () => {
    const a = makeElement({ id: 1 });
    a.identity = { ...a.identity, name: 'Wall A', globalId: 'guid-1' };
    const b = makeElement({ id: 2 });
    b.identity = { ...b.identity, name: 'Wall B', globalId: 'guid-2' };
    const r = intersectProperties([a, b]);
    expect(r.identity.name).toBeUndefined();
    expect(r.identity.globalId).toBeUndefined();
  });

  it('three elements where one differs → varies on the differing path', () => {
    const a = makeElement({
      id: 1,
      psets: [
        psetGroup('Pset_WallCommon', [
          flatRow('Pset_WallCommon.LoadBearing', singleValue(true)),
        ]),
      ],
    });
    const b = makeElement({
      id: 2,
      psets: [
        psetGroup('Pset_WallCommon', [
          flatRow('Pset_WallCommon.LoadBearing', singleValue(true)),
        ]),
      ],
    });
    const c = makeElement({
      id: 3,
      psets: [
        psetGroup('Pset_WallCommon', [
          flatRow('Pset_WallCommon.LoadBearing', singleValue(false)),
        ]),
      ],
    });
    const r = intersectProperties([a, b, c]);
    expect(r.flat[0].rawValue.kind).toBe('varies');
  });

  it('exposes distinct display values for varies rows via getDistinctValuesForPath', () => {
    const a = makeElement({
      id: 1,
      psets: [
        psetGroup('Pset_WallCommon', [
          flatRow('Pset_WallCommon.Material', singleValue('Brick')),
        ]),
      ],
    });
    const b = makeElement({
      id: 2,
      psets: [
        psetGroup('Pset_WallCommon', [
          flatRow('Pset_WallCommon.Material', singleValue('Stone')),
        ]),
      ],
    });
    const r = intersectProperties([a, b]);
    const distinct = getDistinctValuesForPath(r, 'Pset_WallCommon.Material');
    expect(distinct).toContain('Brick');
    expect(distinct).toContain('Stone');
    expect(distinct).toHaveLength(2);
  });

  it('flat rows are alphabetically sorted (same as repository idiom)', () => {
    const a = makeElement({
      id: 1,
      psets: [
        psetGroup('Pset_Z', [flatRow('Pset_Z.B', singleValue(1))]),
        psetGroup('Pset_A', [flatRow('Pset_A.Q', singleValue(2))]),
      ],
    });
    const b = makeElement({
      id: 2,
      psets: [
        psetGroup('Pset_Z', [flatRow('Pset_Z.B', singleValue(1))]),
        psetGroup('Pset_A', [flatRow('Pset_A.Q', singleValue(2))]),
      ],
    });
    const r = intersectProperties([a, b]);
    const paths = r.flat.map((row) => row.path);
    expect(paths).toEqual([...paths].sort());
  });

  it('rebuilds groups so the Tree renderer sees the same shape as single-select', () => {
    const a = makeElement({
      id: 1,
      psets: [
        psetGroup('Pset_WallCommon', [
          flatRow('Pset_WallCommon.LoadBearing', singleValue(true)),
          flatRow('Pset_WallCommon.IsExternal', singleValue(true)),
        ]),
      ],
      qtos: [
        psetGroup('Qto_WallBaseQuantities', [
          flatRow('Qto_WallBaseQuantities.Length', singleValue(5000), 'qto'),
        ]),
      ],
    });
    const b = makeElement({
      id: 2,
      psets: [
        psetGroup('Pset_WallCommon', [
          flatRow('Pset_WallCommon.LoadBearing', singleValue(true)),
          flatRow('Pset_WallCommon.IsExternal', singleValue(true)),
        ]),
      ],
      qtos: [
        psetGroup('Qto_WallBaseQuantities', [
          flatRow('Qto_WallBaseQuantities.Length', singleValue(5000), 'qto'),
        ]),
      ],
    });
    const r = intersectProperties([a, b]);
    expect(r.psets).toHaveLength(1);
    expect(r.psets[0].name).toBe('Pset_WallCommon');
    expect(r.psets[0].properties.map((p) => p.key)).toEqual(
      expect.arrayContaining(['LoadBearing', 'IsExternal']),
    );
    expect(r.qtos).toHaveLength(1);
    expect(r.qtos[0].name).toBe('Qto_WallBaseQuantities');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Regression-lock — Phase 1 of dev/plans/handoff-bulk-property-access.md.
//
// The incremental fold (intersectSeed / intersectStep / intersectFinalize)
// MUST produce output that is deep-equal to the batch intersectProperties()
// on every representative fixture below. This test exists so the fold can
// be wired into the worker without the worker silently diverging from
// what the main thread shipped on every IFC release before this PR.
// ─────────────────────────────────────────────────────────────────────

/** Run the fold step-by-step and finalize — the path the worker takes. */
function foldIntersect(elements: ElementProperties[]): ElementProperties {
  if (elements.length === 0) return intersectProperties([]); // delegate empty path
  if (elements.length === 1) return elements[0];
  let running = intersectSeed(elements[0]);
  for (let i = 1; i < elements.length; i++) {
    running = intersectStep(running, elements[i]);
  }
  return intersectFinalize(running);
}

/**
 * Compare two ElementProperties values for deep equality of their public
 * shape. `fetchedAt` is forced to a constant beforehand because the fold
 * and the batch both timestamp with `Date.now()` and there is no value in
 * locking that down — we care about shape, not wall-clock.
 *
 * Also compares the non-enumerable `__variesDistinct` map so a divergence
 * in tooltip lookup cannot slip through.
 */
function expectDeepEqualResult(fold: ElementProperties, batch: ElementProperties): void {
  const f = { ...fold, fetchedAt: 0 };
  const b = { ...batch, fetchedAt: 0 };
  expect(f).toEqual(b);
  // Compare the non-enumerable distinct map across all paths in either.
  const allPaths = new Set<string>([
    ...fold.flat.map((r) => r.path),
    ...batch.flat.map((r) => r.path),
  ]);
  for (const path of allPaths) {
    const fd = getDistinctValuesForPath(fold, path);
    const bd = getDistinctValuesForPath(batch, path);
    expect(fd).toEqual(bd);
  }
}

describe('intersectProperties — fold ≡ batch regression-lock', () => {
  it('matches batch for 2 same-class elements with identical values', () => {
    const a = makeElement({ id: 1 });
    const b = makeElement({ id: 2 });
    expectDeepEqualResult(foldIntersect([a, b]), intersectProperties([a, b]));
  });

  it('matches batch for 50 same-class elements (all-same values, no varies)', () => {
    const elements: ElementProperties[] = [];
    for (let i = 0; i < 50; i++) elements.push(makeElement({ id: i }));
    expectDeepEqualResult(foldIntersect(elements), intersectProperties(elements));
  });

  it('matches batch for 10 mixed-class elements (cross-class drops everything but Identity if any)', () => {
    const elements: ElementProperties[] = [];
    for (let i = 0; i < 5; i++) elements.push(makeElement({ id: i, ifcClass: 'IfcWall' }));
    for (let i = 5; i < 10; i++) elements.push(makeElement({ id: i, ifcClass: 'IfcDoor' }));
    expectDeepEqualResult(foldIntersect(elements), intersectProperties(elements));
  });

  it('matches batch when every value is the same (no varies emitted)', () => {
    const elements: ElementProperties[] = [];
    for (let i = 0; i < 8; i++) {
      elements.push(
        makeElement({
          id: i,
          psets: [
            psetGroup('Pset_WallCommon', [
              flatRow('Pset_WallCommon.LoadBearing', singleValue(true)),
              flatRow('Pset_WallCommon.IsExternal', singleValue(false)),
            ]),
          ],
        }),
      );
    }
    const fold = foldIntersect(elements);
    const batch = intersectProperties(elements);
    expectDeepEqualResult(fold, batch);
    expect(fold.flat.every((r) => r.rawValue.kind === 'single')).toBe(true);
  });

  it('matches batch when every value is different (every row goes to varies)', () => {
    const elements: ElementProperties[] = [];
    for (let i = 0; i < 6; i++) {
      elements.push(
        makeElement({
          id: i,
          psets: [
            psetGroup('Pset_WallCommon', [
              flatRow('Pset_WallCommon.LoadBearing', singleValue(i % 2 === 0)),
              flatRow('Pset_WallCommon.IsExternal', singleValue(`tag-${i}`)),
            ]),
          ],
        }),
      );
    }
    const fold = foldIntersect(elements);
    const batch = intersectProperties(elements);
    expectDeepEqualResult(fold, batch);
    expect(fold.flat.every((r) => r.rawValue.kind === 'varies')).toBe(true);
  });

  it('matches batch with materials present (intersected by name)', () => {
    const mat = (name: string, expressId: number): PropertyValue => ({
      kind: 'material-ref',
      materialName: name,
      expressId,
    });
    const a = makeElement({ id: 1, materials: [mat('Brick', 100), mat('Steel', 101)] });
    const b = makeElement({ id: 2, materials: [mat('Brick', 200), mat('Stone', 202)] });
    const c = makeElement({ id: 3, materials: [mat('Brick', 300)] });
    expectDeepEqualResult(foldIntersect([a, b, c]), intersectProperties([a, b, c]));
  });

  it('matches batch with Identity. direct rows and pset rows mixed', () => {
    const buildWithDirect = (id: number, tag: string): ElementProperties => {
      const direct: PropertyFlatRow[] = [
        flatRow('Identity.Tag', singleValue(tag), 'direct'),
        flatRow('Identity.Name', singleValue('wall'), 'direct'),
      ];
      const psetRows: PropertyFlatRow[] = [
        flatRow('Pset_WallCommon.LoadBearing', singleValue(true)),
      ];
      const flat: PropertyFlatRow[] = [...direct, ...psetRows];
      flat.sort((a, b) => a.path.localeCompare(b.path));
      return {
        identity: { modelId: 'model-A', expressId: id, ifcClass: 'IfcWall', ifcTypeCode: 1 },
        direct: direct.map((r) => ({ key: r.name, value: r.rawValue, source: 'direct' })),
        psets: [
          psetGroup('Pset_WallCommon', [
            flatRow('Pset_WallCommon.LoadBearing', singleValue(true)),
          ]),
        ],
        qtos: [],
        materials: [],
        flat,
        fetchedAt: Date.now(),
      };
    };
    const a = buildWithDirect(1, 'T1');
    const b = buildWithDirect(2, 'T1');
    const c = buildWithDirect(3, 'T2');
    expectDeepEqualResult(foldIntersect([a, b, c]), intersectProperties([a, b, c]));
  });

  it('single-element fold returns the input verbatim (same as batch)', () => {
    const a = makeElement({ id: 7 });
    expectDeepEqualResult(foldIntersect([a]), intersectProperties([a]));
  });

  it('matches batch for cross-model selection (modelId collapses to (mixed))', () => {
    const a = makeElement({ id: 1, modelId: 'model-A' });
    const b = makeElement({ id: 2, modelId: 'model-A' });
    const c = makeElement({ id: 3, modelId: 'model-B' });
    expectDeepEqualResult(foldIntersect([a, b, c]), intersectProperties([a, b, c]));
  });

  it('matches batch when group exists in only some elements (dropped)', () => {
    const a = makeElement({
      id: 1,
      psets: [
        psetGroup('Pset_OnlyOnA', [flatRow('Pset_OnlyOnA.X', singleValue(1))]),
        psetGroup('Pset_Common', [flatRow('Pset_Common.Y', singleValue(2))]),
      ],
    });
    const b = makeElement({
      id: 2,
      psets: [psetGroup('Pset_Common', [flatRow('Pset_Common.Y', singleValue(2))])],
    });
    expectDeepEqualResult(foldIntersect([a, b]), intersectProperties([a, b]));
  });
});

describe('intersect fold — memory invariant (O(1) in N)', () => {
  it('intersectStep does NOT retain the input ElementProperties', () => {
    // Sanity test that the running state, once stepped, does not contain
    // any reference back to the per-element input. This is the
    // architectural property that lets the worker fold over thousands of
    // elements without growing memory.
    const elements: ElementProperties[] = [];
    for (let i = 0; i < 4; i++) elements.push(makeElement({ id: i }));
    let running = intersectSeed(elements[0]);
    for (let i = 1; i < elements.length; i++) {
      running = intersectStep(running, elements[i]);
    }
    // The running state's only references to "raw" element data are:
    //  - the seed's seedRow per path (intentionally kept for finalize),
    //  - the seed's psetSamples / qtoSamples / materialSamples values,
    //  - identity scalars.
    // None of the non-seed elements should be reachable from `running`.
    const nonSeedRefs = new Set<unknown>(elements.slice(1));
    nonSeedRefs.add(elements[1]);
    // Walk the running state and assert nothing in nonSeedRefs is present.
    // We can't deeply enumerate WeakRefs, but the public shape (paths,
    // samples, identity, count) is enumerable.
    for (const entry of running.paths.values()) {
      expect(nonSeedRefs.has(entry.seedRow)).toBe(false);
      // seedRow must be the FIRST element's row, not a later one.
      const firstFlat = new Set(elements[0].flat);
      expect(firstFlat.has(entry.seedRow)).toBe(true);
    }
    for (const sample of running.psetSamples.values()) {
      expect(nonSeedRefs.has(sample)).toBe(false);
    }
    for (const sample of running.qtoSamples.values()) {
      expect(nonSeedRefs.has(sample)).toBe(false);
    }
    expect(running.count).toBe(elements.length);
  });
});
