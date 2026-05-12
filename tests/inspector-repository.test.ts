import { describe, it, expect, vi } from 'vitest';
import {
  IFCCOMPLEXPROPERTY,
  IFCCONVERSIONBASEDUNIT,
  IFCELEMENTQUANTITY,
  IFCLABEL,
  IFCLENGTHMEASURE,
  IFCMATERIAL,
  IFCPROJECT,
  IFCPROPERTYSET,
  IFCPROPERTYSINGLEVALUE,
  IFCQUANTITYAREA,
  IFCQUANTITYLENGTH,
  IFCQUANTITYVOLUME,
  IFCSIUNIT,
} from 'web-ifc';
import {
  WebIfcPropertyRepository,
  type PropertyApi,
  buildFlatRows,
} from '../src/inspector/repository/WebIfcPropertyRepository';

/**
 * Test fixtures: a single "wall" element (expressId 100) in a model that
 * declares millimetre length, square-metre area, and cubic-metre volume
 * via IfcUnitAssignment.
 *
 * The fixture deliberately avoids spinning up the real web-ifc WASM
 * module — instead it constructs a `PropertyApi` fake that returns the
 * structures web-ifc emits, so we can pin down our normalization without
 * the cost (or flakiness) of WASM in CI.
 */

const MODEL_UUID = 'app-uuid-A';
const WEB_IFC_ID = 7;
const WALL_EXPRESS_ID = 100;

function mkFake(): PropertyApi {
  const wall = {
    type: 0x5111, // arbitrary non-zero — exact class code doesn't matter for these tests
    expressID: WALL_EXPRESS_ID,
    GlobalId: { type: IFCLABEL, value: '2O2Fr$t4X7Zf8NOew3FNr2' },
    Name: { type: IFCLABEL, value: 'Exterior Wall 200mm' },
    ObjectType: { type: IFCLABEL, value: 'Basic Wall:Exterior 200mm' },
    Tag: { type: IFCLABEL, value: 'W-12A' },
    PredefinedType: { type: IFCLABEL, value: 'SOLIDWALL' },
    Description: null,
  };

  const psetWallCommon = {
    type: IFCPROPERTYSET,
    Name: { type: IFCLABEL, value: 'Pset_WallCommon' },
    Description: null,
    HasProperties: [
      {
        type: IFCPROPERTYSINGLEVALUE,
        Name: { type: IFCLABEL, value: 'LoadBearing' },
        NominalValue: { type: 2735952531 /* IFCBOOLEAN */, value: 'T' },
      },
      {
        type: IFCPROPERTYSINGLEVALUE,
        Name: { type: IFCLABEL, value: 'FireRating' },
        NominalValue: { type: IFCLABEL, value: 'EI60' },
      },
      {
        type: IFCPROPERTYSINGLEVALUE,
        Name: { type: IFCLABEL, value: 'Thickness' },
        NominalValue: { type: IFCLENGTHMEASURE, value: 200 },
      },
      {
        // A complex property: should flatten to dotted flat rows.
        type: IFCCOMPLEXPROPERTY,
        Name: { type: IFCLABEL, value: 'AcousticRating' },
        HasProperties: [
          {
            type: IFCPROPERTYSINGLEVALUE,
            Name: { type: IFCLABEL, value: 'Rw' },
            NominalValue: { type: 200335297 /* IFCREAL */, value: 52 },
          },
        ],
      },
    ],
  };

  const qtoWallBaseQuantities = {
    type: IFCELEMENTQUANTITY,
    Name: { type: IFCLABEL, value: 'Qto_WallBaseQuantities' },
    Description: null,
    Quantities: [
      {
        type: IFCQUANTITYLENGTH,
        Name: { type: IFCLABEL, value: 'Length' },
        LengthValue: { type: IFCLENGTHMEASURE, value: 4000 },
      },
      {
        type: IFCQUANTITYAREA,
        Name: { type: IFCLABEL, value: 'NetSideArea' },
        AreaValue: { type: 2650437152 /* IFCAREAMEASURE */, value: 7.208 },
      },
      {
        type: IFCQUANTITYVOLUME,
        Name: { type: IFCLABEL, value: 'NetVolume' },
        VolumeValue: { type: 3458127941 /* IFCVOLUMEMEASURE */, value: 1.4416 },
      },
    ],
  };

  const material = {
    type: IFCMATERIAL,
    expressID: 200,
    Name: { type: IFCLABEL, value: 'Concrete C30/37' },
  };

  const project = {
    type: IFCPROJECT,
    expressID: 1,
    GlobalId: { type: IFCLABEL, value: 'project-guid' },
    Name: { type: IFCLABEL, value: 'My Project' },
    UnitsInContext: {
      Units: [
        // Millimetre length unit.
        {
          type: IFCSIUNIT,
          UnitType: { type: 3, value: 'LENGTHUNIT' },
          Prefix: { type: 3, value: 'MILLI' },
          Name: { type: 3, value: 'METRE' },
        },
        // Square-metre area unit (no prefix).
        {
          type: IFCSIUNIT,
          UnitType: { type: 3, value: 'AREAUNIT' },
          Prefix: null,
          Name: { type: 3, value: 'METRE' },
        },
        // Cubic-metre volume unit.
        {
          type: IFCSIUNIT,
          UnitType: { type: 3, value: 'VOLUMEUNIT' },
          Prefix: null,
          Name: { type: 3, value: 'METRE' },
        },
        // Plane angle in degrees (conversion-based).
        {
          type: IFCCONVERSIONBASEDUNIT,
          UnitType: { type: 3, value: 'PLANEANGLEUNIT' },
          Name: { type: IFCLABEL, value: 'DEGREE' },
        },
      ],
    },
  };

  return {
    GetLine: vi.fn(() => undefined),
    GetLineIDsWithType: vi.fn(() => ({
      size: () => 1,
      get: () => 1, // The project's expressId
    })),
    properties: {
      getItemProperties: vi.fn(async (modelID: number, id: number) => {
        if (modelID !== WEB_IFC_ID) throw new Error('unexpected modelID');
        if (id === WALL_EXPRESS_ID) return wall;
        if (id === 1) return project;
        return {};
      }),
      // New two-call flow:
      //  - getPropertySets(.., false) → instance-side IfcPropertySet + IfcElementQuantity
      //  - getTypeProperties(.., false) → IfcTypeObject(s); their HasPropertySets are walked
      //    by the repo and resolved via GetLine.
      // Our wall fixture has no type, so getTypeProperties returns [] here. Type-inherited
      // psets are exercised in a dedicated test below.
      getPropertySets: vi.fn(async (
        modelID: number,
        id: number,
        _recursive?: boolean,
        includeTypeProperties?: boolean,
      ) => {
        if (modelID !== WEB_IFC_ID || id !== WALL_EXPRESS_ID) return [];
        // The repository calls with includeTypeProperties=false. We return
        // [] if some legacy caller passes true so any regression to the old
        // single-call path would show up loudly as zero psets.
        if (includeTypeProperties) return [];
        return [psetWallCommon, qtoWallBaseQuantities];
      }),
      getTypeProperties: vi.fn(async () => []),
      getMaterialsProperties: vi.fn(async (modelID: number, id: number) => {
        if (modelID !== WEB_IFC_ID || id !== WALL_EXPRESS_ID) return [];
        return [material];
      }),
    },
  };
}

function makeRepo(api: PropertyApi): WebIfcPropertyRepository {
  return new WebIfcPropertyRepository(api, (id) => (id === MODEL_UUID ? WEB_IFC_ID : undefined));
}

describe('WebIfcPropertyRepository — identity', () => {
  it('extracts Name, GlobalId, ObjectType, Tag, PredefinedType from the element', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    expect(props.identity).toMatchObject({
      modelId: MODEL_UUID,
      expressId: WALL_EXPRESS_ID,
      name: 'Exterior Wall 200mm',
      globalId: '2O2Fr$t4X7Zf8NOew3FNr2',
      objectType: 'Basic Wall:Exterior 200mm',
      tag: 'W-12A',
      predefinedType: 'SOLIDWALL',
    });
  });

  it('populates the direct attribute rows from identity', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const keys = props.direct.map((d) => d.key);
    expect(keys).toContain('Name');
    expect(keys).toContain('GlobalId');
    expect(keys).toContain('Tag');
    expect(keys).toContain('PredefinedType');
  });
});

describe('WebIfcPropertyRepository — psets', () => {
  it('separates psets from qtos by IFC type code', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    expect(props.psets.map((p) => p.name)).toEqual(['Pset_WallCommon']);
    expect(props.qtos.map((q) => q.name)).toEqual(['Qto_WallBaseQuantities']);
  });

  it('normalizes a single-value boolean property', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const lb = props.psets[0].properties.find((p) => p.key === 'LoadBearing');
    expect(lb).toBeDefined();
    expect(lb!.value.kind).toBe('single');
    expect((lb!.value as { value: unknown }).value).toBe(true);
    expect(lb!.unit).toBeUndefined();
  });

  it('attaches the length unit to a length-typed property', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const thickness = props.psets[0].properties.find((p) => p.key === 'Thickness');
    expect(thickness).toBeDefined();
    expect(thickness!.unit).toBe('mm');
    expect(thickness!.value).toMatchObject({
      kind: 'single',
      value: 200,
      raw: { typeCode: IFCLENGTHMEASURE, value: 200 },
    });
  });

  it('renders complex properties as a nested `complex` value', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const ac = props.psets[0].properties.find((p) => p.key === 'AcousticRating');
    expect(ac).toBeDefined();
    expect(ac!.value.kind).toBe('complex');
  });
});

describe('WebIfcPropertyRepository — qtos', () => {
  it('renders length quantity with mm unit (from the unit table)', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const length = props.qtos[0].properties.find((p) => p.key === 'Length');
    expect(length).toBeDefined();
    expect(length!.unit).toBe('mm');
    expect(length!.value).toMatchObject({ kind: 'quantity', quantityKind: 'length', value: 4000 });
  });

  it('renders area quantity with m² unit', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const area = props.qtos[0].properties.find((p) => p.key === 'NetSideArea');
    expect(area).toBeDefined();
    expect(area!.unit).toBe('m²');
    expect(area!.value).toMatchObject({ kind: 'quantity', quantityKind: 'area', value: 7.208 });
  });

  it('renders volume quantity with m³ unit', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const vol = props.qtos[0].properties.find((p) => p.key === 'NetVolume');
    expect(vol).toBeDefined();
    expect(vol!.unit).toBe('m³');
    expect(vol!.value).toMatchObject({ kind: 'quantity', quantityKind: 'volume', value: 1.4416 });
  });
});

describe('WebIfcPropertyRepository — materials', () => {
  it('emits a material-ref for each associated material', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    expect(props.materials).toHaveLength(1);
    expect(props.materials[0]).toMatchObject({ kind: 'material-ref', materialName: 'Concrete C30/37' });
  });
});

describe('WebIfcPropertyRepository — flat rows', () => {
  it('flattens complex properties into dotted paths', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const paths = props.flat.map((r) => r.path);
    expect(paths).toContain('Pset_WallCommon.AcousticRating.Rw');
  });

  it('alphabetizes rows by path', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const paths = props.flat.map((r) => r.path);
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual(sorted);
  });

  it('keeps unit in a separate column (raw value column has no unit)', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const thickness = props.flat.find((r) => r.path === 'Pset_WallCommon.Thickness');
    expect(thickness).toBeDefined();
    expect(thickness!.displayValue).toBe('200');
    expect(thickness!.unit).toBe('mm');
  });

  it('renders booleans as `true`/`false` in the Value column', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const lb = props.flat.find((r) => r.path === 'Pset_WallCommon.LoadBearing');
    expect(lb).toBeDefined();
    expect(lb!.displayValue).toBe('true');
    expect(lb!.unit).toBeFalsy();
  });
});

describe('WebIfcPropertyRepository — type-inherited psets (merge of two API calls)', () => {
  // This test exercises the fix for the destructive-flag bug in web-ifc's
  // getPropertySets(..., includeTypeProperties=true). Our repository now
  // calls getPropertySets(..., false) AND getTypeProperties(...) and
  // merges. Same-named psets from both sides are kept (no dedupe); the
  // type-side rows are tagged `inheritedFromType: true`.
  function mkFakeWithType(): PropertyApi {
    const wall = {
      type: 0x5111,
      expressID: WALL_EXPRESS_ID,
      GlobalId: { type: IFCLABEL, value: 'wall-guid' },
      Name: { type: IFCLABEL, value: 'Wall' },
    };

    // Instance-side pset (overrides Pset_Common, plus has its own).
    const instancePsetCommon = {
      type: IFCPROPERTYSET,
      Name: { type: IFCLABEL, value: 'Pset_Common' },
      HasProperties: [
        {
          type: IFCPROPERTYSINGLEVALUE,
          Name: { type: IFCLABEL, value: 'Reference' },
          NominalValue: { type: IFCLABEL, value: 'instance-ref' },
        },
      ],
    };
    const instancePsetExtra = {
      type: IFCPROPERTYSET,
      Name: { type: IFCLABEL, value: 'Pset_Instance' },
      HasProperties: [
        {
          type: IFCPROPERTYSINGLEVALUE,
          Name: { type: IFCLABEL, value: 'OnlyOnInstance' },
          NominalValue: { type: IFCLABEL, value: 'yes' },
        },
      ],
    };

    // Type-side pset (same Pset_Common name; instance overrides it but we keep both).
    const typePsetCommon = {
      expressID: 9001,
      type: IFCPROPERTYSET,
      Name: { type: IFCLABEL, value: 'Pset_Common' },
      HasProperties: [
        {
          type: IFCPROPERTYSINGLEVALUE,
          Name: { type: IFCLABEL, value: 'Reference' },
          NominalValue: { type: IFCLABEL, value: 'type-ref' },
        },
      ],
    };
    // Type-side qto.
    const typeQto = {
      expressID: 9002,
      type: IFCELEMENTQUANTITY,
      Name: { type: IFCLABEL, value: 'Qto_FromType' },
      Quantities: [
        {
          type: IFCQUANTITYLENGTH,
          Name: { type: IFCLABEL, value: 'TypeLength' },
          LengthValue: { type: IFCLENGTHMEASURE, value: 1234 },
        },
      ],
    };

    // The type object itself, with HasPropertySets as refs (matching web-ifc's
    // recursive=false output shape).
    const typeObject = {
      expressID: 8001,
      Name: { type: IFCLABEL, value: 'WallType' },
      HasPropertySets: [
        { type: 5 /* arbitrary ref type */, value: 9001 },
        { type: 5, value: 9002 },
      ],
    };

    return {
      GetLine: vi.fn((_modelID: number, eid: number) => {
        if (eid === 9001) return typePsetCommon;
        if (eid === 9002) return typeQto;
        return undefined;
      }),
      GetLineIDsWithType: vi.fn(() => ({ size: () => 0, get: () => 0 })),
      properties: {
        getItemProperties: vi.fn(async (_m: number, id: number) => {
          if (id === WALL_EXPRESS_ID) return wall;
          return {};
        }),
        getPropertySets: vi.fn(async (
          _m: number,
          id: number,
          _r?: boolean,
          includeTypeProperties?: boolean,
        ) => {
          if (id !== WALL_EXPRESS_ID) return [];
          if (includeTypeProperties) return []; // Repo never calls this branch.
          return [instancePsetCommon, instancePsetExtra];
        }),
        getTypeProperties: vi.fn(async (_m: number, id: number) => {
          if (id !== WALL_EXPRESS_ID) return [];
          return [typeObject];
        }),
        getMaterialsProperties: vi.fn(async () => []),
      },
    };
  }

  it('merges instance and type psets (keeping same-named entries from both sides)', async () => {
    const api = mkFakeWithType();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);

    const psetNames = props.psets.map((p) => p.name);
    // Pset_Common appears TWICE: once from instance, once from type.
    expect(psetNames.filter((n) => n === 'Pset_Common').length).toBe(2);
    expect(psetNames).toContain('Pset_Instance');
  });

  it('tags type-inherited groups with inheritedFromType=true', async () => {
    const api = mkFakeWithType();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);

    const commons = props.psets.filter((p) => p.name === 'Pset_Common');
    expect(commons).toHaveLength(2);
    // Exactly one should be the type-inherited variant.
    const inherited = commons.filter((p) => p.inheritedFromType === true);
    const instance = commons.filter((p) => !p.inheritedFromType);
    expect(inherited).toHaveLength(1);
    expect(instance).toHaveLength(1);
    // Its inner property should also carry the flag (consumed by flat rows).
    expect(inherited[0].properties[0].inheritedFromType).toBe(true);
  });

  it('propagates inheritedFromType into flat rows', async () => {
    const api = mkFakeWithType();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);

    const referenceRows = props.flat.filter((r) => r.path === 'Pset_Common.Reference');
    // Two rows: instance + type.
    expect(referenceRows).toHaveLength(2);
    expect(referenceRows.some((r) => r.inheritedFromType === true)).toBe(true);
    expect(referenceRows.some((r) => !r.inheritedFromType)).toBe(true);
  });

  it('walks IfcTypeObject.HasPropertySets and resolves each ref via GetLine', async () => {
    const api = mkFakeWithType();
    const repo = makeRepo(api);
    await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    expect((api.GetLine as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual(
      expect.arrayContaining([9001, 9002]),
    );
  });

  it('separates type-inherited IfcElementQuantity into qtos[] (not psets[])', async () => {
    const api = mkFakeWithType();
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);

    expect(props.qtos.map((q) => q.name)).toContain('Qto_FromType');
    const qto = props.qtos.find((q) => q.name === 'Qto_FromType')!;
    expect(qto.inheritedFromType).toBe(true);
  });

  it('falls back gracefully when getTypeProperties throws', async () => {
    const api = mkFakeWithType();
    (api.properties.getTypeProperties as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error('schema not supported');
      },
    );
    const repo = makeRepo(api);
    const props = await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    // Still returns the instance-side psets.
    expect(props.psets.map((p) => p.name)).toEqual(['Pset_Common', 'Pset_Instance']);
  });
});

describe('WebIfcPropertyRepository — memoization & lifecycle', () => {
  it('memoizes per (modelId, expressId): concurrent gets share one fetch', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    const [a, b] = await Promise.all([
      repo.get(MODEL_UUID, WALL_EXPRESS_ID),
      repo.get(MODEL_UUID, WALL_EXPRESS_ID),
    ]);
    expect(a).toBe(b);
    expect(api.properties.getItemProperties).toHaveBeenCalledTimes(2);
    // ↑ One for the element itself, one for the IfcProject (unit table). Both fire ONCE.
  });

  it('serves cached results on subsequent gets without re-calling the API', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const callsBefore = (api.properties.getItemProperties as ReturnType<typeof vi.fn>).mock.calls.length;
    await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const callsAfter = (api.properties.getItemProperties as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBe(callsBefore);
  });

  it('disposeModel clears memoization for that model', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    repo.disposeModel(MODEL_UUID);
    const callsBefore = (api.properties.getItemProperties as ReturnType<typeof vi.fn>).mock.calls.length;
    await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    const callsAfter = (api.properties.getItemProperties as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBeGreaterThan(callsBefore);
  });

  it('throws when the modelId is unknown', async () => {
    const api = mkFake();
    const repo = makeRepo(api);
    await expect(repo.get('does-not-exist', 1)).rejects.toThrow(/unknown modelId/);
  });

  it('runs work through an optional enqueue function (serialization)', async () => {
    const api = mkFake();
    const order: string[] = [];
    const enqueue = async <T>(work: () => Promise<T>): Promise<T> => {
      order.push('before');
      const r = await work();
      order.push('after');
      return r;
    };
    const repo = new WebIfcPropertyRepository(api, () => WEB_IFC_ID, enqueue);
    await repo.get(MODEL_UUID, WALL_EXPRESS_ID);
    expect(order).toEqual(['before', 'after']);
  });
});

describe('buildFlatRows (pure)', () => {
  it('emits one row per direct / pset / qto leaf and sorts by path', () => {
    const rows = buildFlatRows(
      [
        {
          key: 'Name',
          value: { kind: 'single', value: 'foo', raw: { typeCode: IFCLABEL, value: 'foo' } },
          source: 'direct',
        },
      ],
      [
        {
          name: 'Pset_X',
          source: 'pset',
          properties: [
            {
              key: 'Bbb',
              value: { kind: 'single', value: 1, raw: { typeCode: 0, value: 1 } },
              source: 'pset',
            },
            {
              key: 'Aaa',
              value: { kind: 'single', value: 2, raw: { typeCode: 0, value: 2 } },
              source: 'pset',
            },
          ],
        },
      ],
      [],
    );
    expect(rows.map((r) => r.path)).toEqual([
      'Identity.Name',
      'Pset_X.Aaa',
      'Pset_X.Bbb',
    ]);
  });
});
