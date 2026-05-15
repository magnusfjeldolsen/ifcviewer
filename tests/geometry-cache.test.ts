import { describe, it, expect } from 'vitest';
import {
  CACHE_SCHEMA_VERSION,
  GeometryCache,
  computeRecordSize,
  deserializeMeshes,
  serializeMeshes,
  sha256Hex,
  type CachedGeometryRecord,
  type CachedMesh,
} from '../src/services/GeometryCache';
import type { ParsedMesh } from '../src/parser/IfcParser';
import type { SessionStore, StoredCachedGeometry, CachedGeometryMeta } from '../src/services/SessionStore';

function makeMesh(seed: number, vertexCount = 3): ParsedMesh {
  const verts = new Float32Array(vertexCount * 3);
  const norms = new Float32Array(vertexCount * 3);
  const idx = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount * 3; i++) {
    verts[i] = seed + i * 0.1;
    norms[i] = (seed + i) % 2 === 0 ? 0 : 1;
  }
  for (let i = 0; i < vertexCount; i++) idx[i] = i;
  return {
    expressID: 100 + seed,
    vertices: verts,
    normals: norms,
    indices: idx,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, seed, 0, 0, 1],
    color: { r: 0.1 * seed, g: 0.2, b: 0.3, a: 1 },
  };
}

describe('GeometryCache pure helpers', () => {
  it('round-trips ParsedMesh through serialize/deserialize', () => {
    const parsed = [makeMesh(1), makeMesh(2, 5), makeMesh(3, 1)];
    const cached = serializeMeshes(parsed);
    const restored = deserializeMeshes(cached);

    expect(restored).toHaveLength(parsed.length);
    for (let i = 0; i < parsed.length; i++) {
      expect(restored[i].expressID).toBe(parsed[i].expressID);
      expect(Array.from(restored[i].vertices)).toEqual(Array.from(parsed[i].vertices));
      expect(Array.from(restored[i].normals)).toEqual(Array.from(parsed[i].normals));
      expect(Array.from(restored[i].indices)).toEqual(Array.from(parsed[i].indices));
      expect(restored[i].transform).toEqual(parsed[i].transform);
      expect(restored[i].color).toEqual(parsed[i].color);
    }
  });

  it('serialize copies buffers so the cached form is independent of the source', () => {
    const parsed = [makeMesh(1)];
    const cached = serializeMeshes(parsed);
    // Mutate the source after serialize — cached must not see the mutation.
    parsed[0].vertices[0] = 999;
    const restored = deserializeMeshes(cached);
    expect(restored[0].vertices[0]).not.toBe(999);
  });

  it('computeRecordSize counts typed-array bytes plus per-mesh overhead', () => {
    const meshes: CachedMesh[] = serializeMeshes([makeMesh(1, 4)]);
    // 4 verts * 3 floats * 4B = 48 verts + 48 normals + 4 indices * 4B = 16
    // = 48 + 48 + 16 = 112 bytes payload + 168 overhead = 280
    expect(computeRecordSize(meshes)).toBe(112 + 168);
  });

  it('sha256Hex produces a stable 64-char lowercase hex digest', async () => {
    const a = new TextEncoder().encode('hello').buffer as ArrayBuffer;
    const digest = await sha256Hex(a);
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Known SHA-256("hello")
    expect(digest).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('sha256Hex differs for different buffers', async () => {
    const a = new TextEncoder().encode('hello').buffer as ArrayBuffer;
    const b = new TextEncoder().encode('world').buffer as ArrayBuffer;
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });
});

// ---------------------------------------------------------------------------
// GeometryCache class — exercised against an in-memory fake of SessionStore's
// geometry-cache API so we don't need real IndexedDB in the test runner.
// ---------------------------------------------------------------------------

class FakeStore {
  records = new Map<string, StoredCachedGeometry>();

  async saveCachedGeometry(record: StoredCachedGeometry): Promise<void> {
    this.records.set(record.hash, record);
  }
  async loadCachedGeometry(hash: string): Promise<StoredCachedGeometry | null> {
    return this.records.get(hash) ?? null;
  }
  async getAllCachedGeometryMeta(): Promise<CachedGeometryMeta[]> {
    return Array.from(this.records.values()).map(r => ({
      hash: r.hash, cachedAt: r.cachedAt, sizeBytes: r.sizeBytes,
    }));
  }
  async removeCachedGeometry(hash: string): Promise<void> {
    this.records.delete(hash);
  }
}

function fakeStore(): SessionStore {
  return new FakeStore() as unknown as SessionStore;
}

describe('GeometryCache', () => {
  it('save then load returns equivalent ParsedMesh data', async () => {
    const store = fakeStore();
    const cache = new GeometryCache(store);
    const parsed = [makeMesh(1, 4), makeMesh(2, 2)];

    await cache.save('hash-A', parsed);
    const loaded = await cache.load('hash-A');

    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(parsed.length);
    expect(Array.from(loaded![0].vertices)).toEqual(Array.from(parsed[0].vertices));
  });

  it('load returns null on hash miss', async () => {
    const cache = new GeometryCache(fakeStore());
    expect(await cache.load('nope')).toBeNull();
  });

  it('load returns null when schema version does not match', async () => {
    const store = fakeStore();
    const cache = new GeometryCache(store);
    // Plant a record with a future schema version.
    const stale: CachedGeometryRecord = {
      hash: 'stale',
      cachedAt: 1000,
      schemaVersion: CACHE_SCHEMA_VERSION + 999,
      sizeBytes: 0,
      meshes: [],
    };
    await store.saveCachedGeometry(stale);
    expect(await cache.load('stale')).toBeNull();
  });

  it('eviction drops oldest records until total is under cap', async () => {
    const store = fakeStore() as unknown as FakeStore;
    // Cap so small that any single mesh forces an eviction once two are stored.
    // makeMesh(N, 100) → 100*3*4 = 1200 verts + 1200 normals + 100*4 = 400 idx
    // = 2800 bytes payload + 168 overhead = 2968 per record. Cap at 4000 → two
    // records (5936) overflows; one record (2968) fits.
    const cache = new GeometryCache(store as unknown as SessionStore, 4000);

    // Override Date.now to give monotonic timestamps.
    let t = 1000;
    const realNow = Date.now;
    Date.now = () => t;
    try {
      await cache.save('old', [makeMesh(1, 100)]); t += 10;
      await cache.save('mid', [makeMesh(2, 100)]); t += 10;
      await cache.save('new', [makeMesh(3, 100)]); // triggers eviction
    } finally {
      Date.now = realNow;
    }

    // Only the newest record should remain — both older ones evicted to fit.
    expect(store.records.has('new')).toBe(true);
    expect(store.records.has('mid')).toBe(false);
    expect(store.records.has('old')).toBe(false);
  });

  it('eviction is a no-op when total is under cap', async () => {
    const store = fakeStore() as unknown as FakeStore;
    const cache = new GeometryCache(store as unknown as SessionStore, 1_000_000);
    await cache.save('a', [makeMesh(1, 4)]);
    await cache.save('b', [makeMesh(2, 4)]);
    expect(store.records.size).toBe(2);
  });
});
