/**
 * Where the geometry cache keeps its geometry: files in the origin private
 * file system (OPFS), written by the workers while they stream.
 *
 * A model's cached geometry is many **parts**, each a `packMeshes` buffer.
 * Every worker taking part in a load appends its parts to one file of its
 * own, `geometry-cache/<key>/<worker>.bin`, through a synchronous access
 * handle — so the main thread never holds or copies the geometry for the
 * cache, and a write is a plain file append inside the worker's stream.
 *
 * An **index** record in IndexedDB (`GeometryCache`), written by the main
 * thread once every worker has flushed its file, maps the .ifc's SHA-256 to
 * the files and the size of each part in them. Without an index record the
 * files are not a cache entry: a load that fails or is closed mid-way leaves
 * a directory that `GeometryCache.sweep` removes later.
 *
 * Why files and not IndexedDB: IndexedDB took ~12 s to write and as long to
 * read back the 1.9 GB of a geometry-heavy 48 MB model, slower than parsing
 * it, and refused the writes outright ("Failed to write blobs (InvalidBlob)")
 * when four workers had a couple of gigabytes in flight. OPFS wrote the same
 * 1.9 GB in under half a second and read it back in under one.
 *
 * `key` is `<ms since epoch>:<load id>`: unique per load, and its time says
 * how old an orphan is.
 */

import type { ParsedMesh } from '../parser/types';
import { packMeshesInto, packedSize } from './geometryPack';

/** The OPFS directory holding one subdirectory per cached load. */
export const CACHE_DIR = 'geometry-cache';

/** Largest part: what the main thread reads and appends in one go on reopen. */
export const PART_MAX_BYTES = 32 * 1024 * 1024;

/** Key for a new load's parts. Safe as a file name. */
export function newCacheKey(id: string, now: number = Date.now()): string {
  return `${now}-${id}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** When the load with this key started; NaN for a key that is not ours. */
export function cacheKeyTime(key: string): number {
  const m = /^(\d+)-/.exec(key);
  return m ? Number(m[1]) : NaN;
}

export function fileName(worker: number): string {
  return `${worker}.bin`;
}

/** One worker's file of a load: the byte size of each part, in order. */
export interface PartFile {
  worker: number;
  sizes: number[];
}

/** What a worker reports once its parts are written (or failed to be). */
export interface CacheWriteReport {
  ok: boolean;
  parts: number;
  bytes: number;
  files?: PartFile[];
  /** Why it failed, when it did. */
  error?: string;
}

/** The synchronous access handle surface the writer uses (tests pass a fake). */
export interface SyncFile {
  write(data: ArrayBuffer | ArrayBufferView, options: { at: number }): number;
  flush(): void;
  close(): void;
}

/**
 * Open this worker's part file for a load. Worker-only (sync access handles
 * exist only there); resolves null where OPFS is missing, and the load then
 * simply goes uncached.
 */
export async function openPartFile(key: string, worker: number): Promise<SyncFile | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const cache = await root.getDirectoryHandle(CACHE_DIR, { create: true });
    const dir = await cache.getDirectoryHandle(key, { create: true });
    const file = await dir.getFileHandle(fileName(worker), { create: true });
    const open = (file as unknown as { createSyncAccessHandle?: () => Promise<SyncFile> }).createSyncAccessHandle;
    if (!open) return null;
    return await open.call(file);
  } catch {
    return null;
  }
}

/**
 * Writes one worker's parts of one load: each batch is packed (copied — the
 * caller may transfer the meshes after) and appended to the worker's file,
 * split into parts of at most `PART_MAX_BYTES`.
 */
export class PartWriter {
  private offset = 0;
  private sizes: number[] = [];
  private ok: boolean;
  private error: string | undefined;

  constructor(
    private readonly file: SyncFile | null,
    private readonly worker: number,
    private readonly partBytes: number = PART_MAX_BYTES,
  ) {
    this.ok = file !== null;
    if (!file) this.error = 'no file system';
  }

  write(meshes: readonly ParsedMesh[]): void {
    if (!this.ok || meshes.length === 0) return;
    try {
      let group: ParsedMesh[] = [];
      let groupBytes = 0;
      for (const m of meshes) {
        const size = packedSize([m]);
        if (group.length > 0 && groupBytes + size > this.partBytes) {
          this.append(this.pack(group));
          group = [];
          groupBytes = 0;
        }
        group.push(m);
        groupBytes += size;
      }
      this.append(this.pack(group));
    } catch (err) {
      // Disk full, quota, out of memory: this load goes uncached.
      this.fail(err);
    }
  }

  /** Flush and close the file; say what was written. */
  finish(): CacheWriteReport {
    try {
      if (this.file && this.ok) this.file.flush();
    } catch (err) {
      this.fail(err);
    }
    try {
      this.file?.close();
    } catch {
      // closing a broken handle: nothing to recover
    }
    const report: CacheWriteReport = {
      ok: this.ok,
      parts: this.sizes.length,
      bytes: this.offset,
      files: [{ worker: this.worker, sizes: this.sizes }],
    };
    if (this.error) report.error = this.error;
    return report;
  }

  /** One buffer reused for every part: written out at once, so free again by the next. */
  private scratch: ArrayBuffer | null = null;

  private pack(group: ParsedMesh[]): Uint8Array {
    const size = packedSize(group);
    if (!this.scratch || this.scratch.byteLength < size) this.scratch = new ArrayBuffer(size);
    return packMeshesInto(group, this.scratch);
  }

  private append(data: Uint8Array): void {
    const written = this.file!.write(data, { at: this.offset });
    if (written !== data.byteLength) throw new Error(`short write (${written} of ${data.byteLength} bytes)`);
    this.offset += written;
    this.sizes.push(written);
  }

  private fail(err: unknown): void {
    this.ok = false;
    this.error ??= err instanceof Error || err instanceof DOMException ? `${err.name}: ${err.message}` : String(err);
  }
}

// --- main-thread side --------------------------------------------------------

/** The part files' operations `GeometryCache` needs (tests pass a fake). */
export interface PartFiles {
  read(key: string, worker: number, offset: number, length: number): Promise<ArrayBuffer | null>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

async function cacheDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create });
  } catch {
    return null;
  }
}

/** Whether this browser can keep part files at all. */
export function partFilesSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

/** The part files in this origin's private file system. */
export const opfsPartFiles: PartFiles = {
  async read(key, worker, offset, length) {
    try {
      const dir = await (await cacheDir(false))?.getDirectoryHandle(key);
      if (!dir) return null;
      const file = await (await dir.getFileHandle(fileName(worker))).getFile();
      if (offset + length > file.size) return null;
      return await file.slice(offset, offset + length).arrayBuffer();
    } catch {
      return null;
    }
  },
  async remove(key) {
    const dir = await cacheDir(false);
    await dir?.removeEntry(key, { recursive: true }).catch(() => {});
  },
  async keys() {
    const dir = await cacheDir(false);
    if (!dir) return [];
    const out: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) out.push(name);
    return out;
  },
};
