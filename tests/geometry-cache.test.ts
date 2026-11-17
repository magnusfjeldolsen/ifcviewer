import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CACHE_SCHEMA_VERSION,
  GeometryCache,
  MAX_CACHE_BYTES,
  MIN_CACHE_BYTES,
  ORPHAN_AGE_MS,
  capFromQuota,
  sha256Hex,
  type GeometryIndex,
} from '../src/services/GeometryCache';
import { packMeshes } from '../src/services/geometryPack';
import type { CacheWriteReport, PartFiles } from '../src/services/geometryParts';
import type { GeometryIndexRecord } from '../src/services/SessionStore';
import type { ParsedMesh } from '../src/parser/types';

afterEach(() => vi.restoreAllMocks());

function mesh(id: number): ParsedMesh {
  return {
    expressID: id,
    vertices: new Float32Array([id, 0, 0, 0, id, 0, 0, 0, id]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    color: { r: 1, g: 1, b: 1, a: 1 },
  };
}

class FakeIndex implements GeometryIndex {
  records = new Map<string, GeometryIndexRecord>();
  async putGeometryIndex(r: GeometryIndexRecord): Promise<void> {
    this.records.set(r.hash, r);
  }
  async getGeometryIndex(hash: string): Promise<GeometryIndexRecord | null> {
    return this.records.get(hash) ?? null;
  }
  async getAllGeometryIndex(): Promise<GeometryIndexRecord[]> {
    return [...this.records.values()];
  }
  async removeGeometryIndex(hash: string): Promise<void> {
    this.records.delete(hash);
  }
}

/** Part files in memory: key → worker → bytes. */
class FakeFiles implements PartFiles {
  dirs = new Map<string, Map<number, Uint8Array>>();
  async read(key: string, worker: number, offset: number, length: number): Promise<ArrayBuffer | null> {
    const f = this.dirs.get(key)?.get(worker);
    if (!f || offset + length > f.length) return null;
    return f.slice(offset, offset + length).buffer;
  }
  async remove(key: string): Promise<void> {
    this.dirs.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.dirs.keys()];
  }
}

const GB = 1024 ** 3;

function setup(cap = 10 * GB, now = 1_000_000) {
  const index = new FakeIndex();
  const files = new FakeFiles();
  let clock = now;
  const cache = new GeometryCache(index, files, async () => cap, () => clock);
  return { index, files, cache, advance: (ms: number) => (clock += ms) };
}

/** Write a load's parts as the workers would — batches spread over workers — and return their merged report. */
function writeLoad(files: FakeFiles, key: string, batchesByWorker: ParsedMesh[][][]): CacheWriteReport {
  const dir = new Map<number, Uint8Array>();
  const report: CacheWriteReport = { ok: true, parts: 0, bytes: 0, files: [] };
  batchesByWorker.forEach((batches, worker) => {
    const parts = batches.map((b) => new Uint8Array(packMeshes(b)));
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    dir.set(worker, all);
    report.files!.push({ worker, sizes: parts.map((p) => p.length) });
    report.parts += parts.length;
    report.bytes += all.length;
  });
  files.dirs.set(key, dir);
  return report;
}

const ids = (got: ParsedMesh[][]) => got.map((m) => m.map((x) => x.expressID));

describe('GeometryCache', () => {
  it('commits a load’s part files as the entry for the file and reads every part back', async () => {
    const { index, files, cache } = setup();
    const key = cache.newKey('model-1');
    const report = writeLoad(files, key, [[[mesh(1), mesh(2)], [mesh(3)]], [[mesh(4)]]]);
    await cache.commit('h1', key, report);
    expect(index.records.get('h1')).toMatchObject({ key, parts: 3, sizeBytes: report.bytes, schemaVersion: CACHE_SCHEMA_VERSION });

    const entry = await cache.open('h1');
    const got: ParsedMesh[][] = [];
    await expect(entry!.read((m) => got.push(m))).resolves.toBe(true);
    expect(ids(got)).toEqual([[1, 2], [3], [4]]);
  });

  it('misses on a file it has not seen', async () => {
    const { cache } = setup();
    await expect(cache.open('nope')).resolves.toBeNull();
  });

  it('drops the files of a failed write instead of making them an entry, and says why', async () => {
    const { index, files, cache } = setup();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const key = cache.newKey('m');
    writeLoad(files, key, [[[mesh(1)]]]);
    await cache.commit('h', key, { ok: false, parts: 1, bytes: 10, error: 'QuotaExceededError: full' });
    expect(index.records.size).toBe(0);
    expect(files.dirs.size).toBe(0);
    expect(info.mock.calls[0][0]).toMatch(/QuotaExceededError/);
  });

  it('drops a load bigger than the whole cache', async () => {
    const { index, files, cache } = setup(100);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const key = cache.newKey('m');
    const report = writeLoad(files, key, [[[mesh(1), mesh(2), mesh(3)]]]);
    expect(report.bytes).toBeGreaterThan(100);
    await cache.commit('h', key, report);
    expect(index.records.size).toBe(0);
    expect(files.dirs.size).toBe(0);
  });

  it('replaces an older entry for the same file and frees its files', async () => {
    const { index, files, cache, advance } = setup();
    const k1 = cache.newKey('a');
    await cache.commit('h', k1, writeLoad(files, k1, [[[mesh(1)]]]));
    advance(1);
    const k2 = cache.newKey('b');
    await cache.commit('h', k2, writeLoad(files, k2, [[[mesh(2)]]]));
    expect(index.records.get('h')?.key).toBe(k2);
    expect(files.dirs.has(k1)).toBe(false);
  });

  it('treats an entry of another schema version as a miss, and removes it', async () => {
    const { index, files, cache } = setup();
    const key = cache.newKey('m');
    const report = writeLoad(files, key, [[[mesh(1)]]]);
    index.records.set('h', {
      hash: 'h', key, files: report.files!, parts: 1, sizeBytes: 1, cachedAt: 0, schemaVersion: CACHE_SCHEMA_VERSION + 1,
    });
    await expect(cache.open('h')).resolves.toBeNull();
    expect(index.records.size).toBe(0);
    expect(files.dirs.size).toBe(0);
  });

  it('a missing, short or corrupt part fails the read and removes the entry, so the caller parses instead', async () => {
    const { index, files, cache } = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = cache.newKey('m');
    await cache.commit('h', key, writeLoad(files, key, [[[mesh(1)], [mesh(2)]]]));
    files.dirs.get(key)!.get(0)!.fill(7, 8); // garbage after the first header
    await expect((await cache.open('h'))!.read(() => {})).resolves.toBe(false);
    expect(index.records.size).toBe(0);
    expect(files.dirs.size).toBe(0);

    const k2 = cache.newKey('n');
    const r2 = writeLoad(files, k2, [[[mesh(1)]]]);
    await cache.commit('h2', k2, r2);
    files.dirs.get(k2)!.set(0, new Uint8Array(4)); // truncated file
    await expect((await cache.open('h2'))!.read(() => {})).resolves.toBe(false);
  });

  it('evicts the oldest entries until the total fits the cap', async () => {
    const { index, files, cache, advance } = setup();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const k = cache.newKey(`m${i}`);
      keys.push(k);
      await cache.commit(`h${i}`, k, writeLoad(files, k, [[[mesh(i)]]]));
      advance(10);
    }
    const one = index.records.get('h0')!.sizeBytes;
    const small = new GeometryCache(index, files, async () => one * 2, () => 0);
    await small.evict();
    expect([...index.records.keys()].sort()).toEqual(['h1', 'h2']);
    expect(files.dirs.has(keys[0])).toBe(false);
  });

  it('sweeps files no entry points at, once they are old enough not to be a load in progress', async () => {
    const { files, cache, advance } = setup();
    const live = cache.newKey('live');
    await cache.commit('h', live, writeLoad(files, live, [[[mesh(1)]]]));
    const orphan = cache.newKey('failed');
    writeLoad(files, orphan, [[[mesh(2)]]]);
    writeLoad(files, 'not-ours', [[[mesh(3)]]]);

    await cache.sweep();
    expect(files.dirs.has(orphan)).toBe(true); // could still be writing
    expect(files.dirs.has('not-ours')).toBe(false);

    advance(ORPHAN_AGE_MS + 1);
    await cache.sweep();
    expect(files.dirs.has(orphan)).toBe(false);
    expect(files.dirs.has(live)).toBe(true);
  });
});

describe('cache sizing', () => {
  it('sizes the cap from the storage quota, within bounds', () => {
    expect(capFromQuota(100 * GB)).toBe(MAX_CACHE_BYTES);
    expect(capFromQuota(1 * GB)).toBe(MIN_CACHE_BYTES);
    expect(capFromQuota(12 * GB)).toBe(3 * GB);
    expect(capFromQuota(undefined)).toBe(2 * GB);
  });
});

describe('sha256Hex', () => {
  it('hashes like the standard', async () => {
    const hex = await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer);
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
