/**
 * Issue #90: the built site showed `lg` / `_g` as an element's IfcClass,
 * because the name was read from the web-ifc line object's constructor and the
 * production build minifies web-ifc's classes. jsdom never minifies, so these
 * tests pin the mechanism instead: the name comes from the type code through
 * web-ifc's `GetNameFromTypeCode`, and a constructor with a wrong name is
 * ignored.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { IfcAPI, IfcLineObject, IFC2X3, IFC4, IFC4X3, IFCLABEL, IFCSLAB, IFCWALL } from 'web-ifc';

import { createIfcClassNamer } from '../src/parser/ifcClassNames';
import { buildIdentity, buildDirect } from '../src/inspector/repository/propertyNormalizer';
import {
  fetchElementProperties,
  type PropertyApi,
} from '../src/inspector/repository/fetchElementProperties';
import { buildUnitTable } from '../src/inspector/format';

/** What a minified build turns `class IfcSlab` into. */
class lg {
  type = IFCSLAB;
  GlobalId = { type: IFCLABEL, value: '0slab' };
}

/** A fake web-ifc that only knows two classes. */
const fakeApi = {
  GetNameFromTypeCode: (code: number): string =>
    code === IFCSLAB ? 'IfcSlab' : code === IFCWALL ? 'IfcWall' : '<web-ifc-type-unknown>',
};

describe('buildIdentity — IfcClass', () => {
  it('names the class from the type code, not from a minified constructor', () => {
    const identity = buildIdentity('m', 1, new lg(), createIfcClassNamer(fakeApi));
    expect(identity.ifcClass).toBe('IfcSlab');
    expect(identity.ifcTypeCode).toBe(IFCSLAB);
  });

  it('never falls back to the constructor name, even without a namer', () => {
    const identity = buildIdentity('m', 1, new lg());
    expect(identity.ifcClass).not.toBe('lg');
    expect(identity.ifcClass).toBe(`IfcType_${IFCSLAB}`);
  });

  it('shows the same name in the IfcClass row', () => {
    const item = new lg();
    const identity = buildIdentity('m', 1, item, createIfcClassNamer(fakeApi));
    const row = buildDirect(identity, item).find((r) => r.key === 'IfcClass');
    expect(row?.value).toMatchObject({ kind: 'single', value: 'IfcSlab' });
  });
});

describe('createIfcClassNamer', () => {
  const name = createIfcClassNamer(fakeApi);

  it('uses what web-ifc answers', () => {
    expect(name(IFCWALL)).toBe('IfcWall');
  });

  it('gives a recognisable placeholder for a code web-ifc does not know', () => {
    expect(name(12345)).toBe('IfcType_12345');
  });

  it('keeps the old placeholder for a missing type code', () => {
    expect(name(0)).toBe('IfcElement');
  });

  it('survives web-ifc throwing', () => {
    const throwing = createIfcClassNamer({
      GetNameFromTypeCode: () => {
        throw new Error('wasm not ready');
      },
    });
    expect(throwing(IFCWALL)).toBe(`IfcType_${IFCWALL}`);
  });
});

describe('fetchElementProperties — IfcClass', () => {
  it('passes the class name through to the identity the inspector shows', async () => {
    const item = new lg();
    const api: PropertyApi = {
      GetLine: () => item,
      GetLineIDsWithType: () => ({ size: () => 0, get: () => 0 }),
      properties: {
        getItemProperties: async () => item,
        getPropertySets: async () => [],
        getTypeProperties: async () => [],
        getMaterialsProperties: async () => [],
      },
    };
    const props = await fetchElementProperties(
      api, 0, 'm', 1, buildUnitTable([]), undefined, createIfcClassNamer(fakeApi),
    );
    expect(props.identity.ifcClass).toBe('IfcSlab');
  });
});

describe('createIfcClassNamer against real web-ifc', () => {
  let api: IfcAPI;
  beforeAll(async () => {
    api = new IfcAPI();
    await api.Init();
  }, 60_000);

  it('names every entity class of every schema exactly as the dev build did', () => {
    // Unminified (as here and on the dev server), each schema class's name
    // IS what the inspector used to show. Every one must come back the same,
    // casing included — not only the common ones.
    const name = createIfcClassNamer(api);
    const mismatches: string[] = [];
    let checked = 0;
    for (const ns of [IFC2X3, IFC4, IFC4X3] as Record<string, unknown>[]) {
      for (const [key, cls] of Object.entries(ns)) {
        if (typeof cls !== 'function' || !(cls.prototype instanceof IfcLineObject)) continue;
        checked++;
        const got = name(api.GetTypeCodeFromName(key.toUpperCase()));
        if (got !== key || got !== cls.name) mismatches.push(`${key} → ${got}`);
      }
    }
    expect(checked).toBeGreaterThan(2000);
    expect(mismatches).toEqual([]);
  });
});
