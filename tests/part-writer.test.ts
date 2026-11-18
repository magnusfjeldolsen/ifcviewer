import { describe, it, expect } from 'vitest';
import { PartWriter, cacheKeyTime, newCacheKey, type SyncFile } from '../src/services/geometryParts';
import { unpackMeshes } from '../src/services/geometryPack';
import type { ParsedMesh } from '../src/parser/types';

function mesh(id: number, verts = 30): ParsedMesh {
  return {
    expressID: id,
    vertices: new Float32Array(verts * 3),
    normals: new Float32Array(verts * 3),
    indices: new Uint32Array(verts),
    transform: Array.from({ length: 16 }, () => 0),
    color: { r: 1, g: 1, b: 1, a: 1 },
  };
}

/** An in-memory sync access handle. */
class FakeFile implements SyncFile {
  bytes = new Uint8Array(0);
  flushed = false;
  closed = false;
  failAfter = Infinity;
  write(data: ArrayBuffer, { at }: { at: number }): number {
    if (this.failAfter-- <= 0) throw new DOMException('disk full', 'QuotaExceededError');
    const next = new Uint8Array(Math.max(this.bytes.length, at + data.byteLength));
    next.set(this.bytes);
    next.set(new Uint8Array(data), at);
    this.bytes = next;
    return data.byteLength;
  }
  flush(): void {
    this.flushed = true;
  }
  close(): void {
    this.closed = true;
  }
}

/** The parts in a file, as the index describes them. */
function partsOf(file: FakeFile, sizes: number[]): ParsedMesh[][] {
  const out: ParsedMesh[][] = [];
  let at = 0;
  for (const s of sizes) {
    out.push(unpackMeshes(file.bytes.slice(at, at + s).buffer));
    at += s;
  }
  return out;
}

describe('PartWriter', () => {
  it('appends batches as parts and reports where each one is', () => {
    const file = new FakeFile();
    const w = new PartWriter(file, 2);
    w.write([mesh(1), mesh(2)]);
    w.write([mesh(3)]);
    const report = w.finish();
    expect(report).toMatchObject({ ok: true, parts: 2, bytes: file.bytes.length });
    expect(report.files).toEqual([{ worker: 2, sizes: [expect.any(Number), expect.any(Number)] }]);
    expect(partsOf(file, report.files![0].sizes).map((p) => p.map((m) => m.expressID))).toEqual([[1, 2], [3]]);
    expect(file.flushed && file.closed).toBe(true);
  });

  it('splits a big batch into parts of at most the part size, keeping every mesh', () => {
    const file = new FakeFile();
    const w = new PartWriter(file, 0, 2000);
    w.write([mesh(1), mesh(2), mesh(3), mesh(4)]);
    const { files } = w.finish();
    const sizes = files![0].sizes;
    expect(sizes.length).toBeGreaterThan(1);
    for (const s of sizes) expect(s).toBeLessThanOrEqual(2000);
    expect(partsOf(file, sizes).flat().map((m) => m.expressID)).toEqual([1, 2, 3, 4]);
  });

  it('a failed write fails the load’s cache with the reason, and writes nothing more', () => {
    const file = new FakeFile();
    file.failAfter = 1;
    const w = new PartWriter(file, 0);
    w.write([mesh(1)]);
    w.write([mesh(2)]);
    w.write([mesh(3)]);
    const report = w.finish();
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/QuotaExceededError/);
    expect(report.parts).toBe(1);
    expect(file.flushed).toBe(false);
    expect(file.closed).toBe(true);
  });

  it('without a file it writes nothing and says so', () => {
    const w = new PartWriter(null, 0);
    w.write([mesh(1)]);
    expect(w.finish()).toEqual({ ok: false, parts: 0, bytes: 0, files: [{ worker: 0, sizes: [] }], error: 'no file system' });
  });
});

describe('cache keys', () => {
  it('are safe as file names and carry when their load started', () => {
    const key = newCacheKey('a:b/c', 12345);
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(cacheKeyTime(key)).toBe(12345);
    expect(cacheKeyTime('garbage')).toBeNaN();
  });
});
