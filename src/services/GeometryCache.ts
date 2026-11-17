/**
 * Cache parsed-IFC geometry in IndexedDB, keyed by the SHA-256 of the .ifc
 * file, so a model opens again without parsing it again.
 *
 * The workers write the geometry while they stream it, as part files (see
 * `geometryParts.ts`); this module is the main thread's side: it records a
 * finished set of files as a cache entry in IndexedDB (`commit`), reads an
 * entry back part by part (`open`), and keeps the cache within its cap
 * (`evict`, `sweep`).
 *
 * Reading back part by part is what lets a model of any size reopen: each
 * part is appended to the scene and let go before the next is read, so the
 * restore never holds more than one part beyond what the scene holds.
 */

import type { ParsedMesh } from '../parser/types';
import type { GeometryIndexRecord, SessionStore } from './SessionStore';
import { cacheKeyTime, newCacheKey, opfsPartFiles, type CacheWriteReport, type PartFiles } from './geometryParts';
import { unpackMeshes } from './geometryPack';

/**
 * Bump when the meaning of the stored parts changes. An index record of any
 * other version is a miss: its entry is removed and the model parsed again.
 *
 *   1 — one record per model (removed with the v4 database upgrade)
 *   2 — an index over part files the workers write to OPFS
 */
export const CACHE_SCHEMA_VERSION = 2;

/** The least the cache may hold, whatever the browser says about storage. */
export const MIN_CACHE_BYTES = 500 * 1024 * 1024;
/** The most it may hold. */
export const MAX_CACHE_BYTES = 8 * 1024 ** 3;
/** Share of the origin's storage quota the cache may use, between those two. */
export const CACHE_QUOTA_SHARE = 0.25;

/** Parts being read while the one before them is appended. */
const READ_AHEAD = 3;

/**
 * Part files with no index record, from a load that started this long ago
 * and is not running in this tab, are leftovers of a failed or abandoned
 * load. A load still writing in another tab holds its files open, and the
 * file system refuses to remove them; this margin covers the seconds between
 * its writers closing their files and its index record being written.
 */
export const ORPHAN_AGE_MS = 2 * 60 * 1000;

/** The index operations this module needs (SessionStore; tests pass a fake). */
export type GeometryIndex = Pick<
  SessionStore,
  'putGeometryIndex' | 'getGeometryIndex' | 'getAllGeometryIndex' | 'removeGeometryIndex'
>;
/** A cache entry ready to be read. */
export interface CachedModel {
  parts: number;
  sizeBytes: number;
  /**
   * Read the parts in order, handing each one's meshes to `onMeshes`.
   * Resolves true if every part was read, false if one was missing or
   * corrupt — the caller then drops what it got and parses instead (the
   * entry has been removed by then).
   */
  read(onMeshes: (meshes: ParsedMesh[]) => void, onTime?: (span: string, ms: number) => void): Promise<boolean>;
}

/** The cap the browser's storage estimate allows, between the min and the max. */
export function capFromQuota(quota: number | undefined): number {
  if (!quota || !Number.isFinite(quota)) return 2 * 1024 ** 3;
  return Math.max(MIN_CACHE_BYTES, Math.min(MAX_CACHE_BYTES, quota * CACHE_QUOTA_SHARE));
}

async function browserCap(): Promise<number> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return capFromQuota(estimate?.quota);
  } catch {
    return capFromQuota(undefined);
  }
}

/** SHA-256 of an ArrayBuffer, returned as lowercase hex. */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export class GeometryCache {
  constructor(
    private index: GeometryIndex,
    private files: PartFiles = opfsPartFiles,
    private capBytes: () => Promise<number> = browserCap,
    private now: () => number = Date.now,
  ) {}

  /** Keys of loads in this tab whose parts are not yet committed or discarded. */
  private active = new Set<string>();

  /** A key for the parts of a new load. Its files are never swept until `commit` or `discard`. */
  newKey(id: string): string {
    const key = newCacheKey(id, this.now());
    this.active.add(key);
    return key;
  }

  /**
   * The workers have stored a load's parts: make them the entry for `hash`.
   * A failed write (or an entry bigger than the whole cache) is discarded
   * instead. Never throws: a missed cache write is never user-visible.
   */
  async commit(hash: string, key: string, report: CacheWriteReport): Promise<void> {
    this.active.delete(key);
    try {
      const cap = await this.capBytes();
      if (!report.ok || report.parts === 0 || report.bytes > cap) {
        console.info(
          `GeometryCache: not cached (${!report.ok ? report.error ?? 'a write failed' : report.parts === 0 ? 'no geometry' : `${(report.bytes / 1e6).toFixed(0)} MB is over the ${(cap / 1e6).toFixed(0)} MB cap`})`,
        );
        await this.files.remove(key);
        return;
      }
      const previous = await this.index.getGeometryIndex(hash);
      await this.index.putGeometryIndex({
        hash,
        key,
        files: report.files ?? [],
        parts: report.parts,
        sizeBytes: report.bytes,
        cachedAt: this.now(),
        schemaVersion: CACHE_SCHEMA_VERSION,
      });
      if (previous && previous.key !== key) await this.files.remove(previous.key);
      await this.evict();
    } catch (err) {
      console.warn('GeometryCache: commit failed', err);
    }
  }

  /** Drop the parts of a load that will not become an entry. */
  async discard(key: string): Promise<void> {
    this.active.delete(key);
    try {
      await this.files.remove(key);
    } catch (err) {
      console.warn('GeometryCache: discard failed', err);
    }
  }

  /** The entry for `hash`, or null on a miss (including an entry of another version). */
  async open(hash: string): Promise<CachedModel | null> {
    let found: GeometryIndexRecord | null;
    try {
      found = await this.index.getGeometryIndex(hash);
    } catch (err) {
      console.warn('GeometryCache: lookup failed', err);
      return null;
    }
    if (!found) return null;
    if (found.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(found.files)) {
      await this.remove(found);
      return null;
    }
    const entry = found;
    return {
      parts: entry.parts,
      sizeBytes: entry.sizeBytes,
      read: async (onMeshes, onTime) => {
        try {
          // Every part's place: which file, where in it, how long.
          const places: Array<{ worker: number; offset: number; length: number }> = [];
          for (const f of entry.files) {
            let offset = 0;
            for (const length of f.sizes) {
              places.push({ worker: f.worker, offset, length });
              offset += length;
            }
          }
          if (places.length !== entry.parts) throw new Error(`expected ${entry.parts} parts, index lists ${places.length}`);
          // Keep the next parts' reads going while this one is appended:
          // reading is the disk's time, appending the main thread's.
          const ahead: Array<Promise<ArrayBuffer | null>> = [];
          let next = 0;
          const fill = (): void => {
            while (ahead.length < READ_AHEAD && next < places.length) {
              const p = places[next++];
              // A failed read counts as a missing part (and is never left unhandled).
              ahead.push(this.files.read(entry.key, p.worker, p.offset, p.length).catch(() => null));
            }
          };
          for (let i = 0; i < places.length; i++) {
            fill();
            const t0 = performance.now();
            const data = await ahead.shift()!;
            fill();
            const t1 = performance.now();
            if (!data) throw new Error(`part ${i} missing`);
            const meshes = unpackMeshes(data);
            onTime?.('main.cacheGet', t1 - t0);
            onTime?.('main.cacheUnpack', performance.now() - t1);
            onMeshes(meshes);
          }
          return true;        } catch (err) {
          console.warn('GeometryCache: entry unreadable, removing it', err);
          await this.remove(entry);
          return false;
        }
      },
    };
  }

  /**
   * Remove the oldest entries until the total is under the cap. Approximate
   * LRU by `cachedAt` — adequate for a handful of large entries.
   */
  async evict(): Promise<void> {
    const all = await this.index.getAllGeometryIndex();
    const cap = await this.capBytes();
    let total = 0;
    for (const e of all) total += e.sizeBytes;
    for (const e of all.slice().sort((a, b) => a.cachedAt - b.cachedAt)) {
      if (total <= cap) break;
      await this.remove(e);
      total -= e.sizeBytes;
      console.info(`GeometryCache: evicted ${e.hash.slice(0, 8)}… (${(e.sizeBytes / 1e6).toFixed(1)} MB)`);
    }
  }

  /**
   * Remove parts no entry points at: leftovers of loads that failed, were
   * abandoned, or were replaced. Only those older than `ORPHAN_AGE_MS`, so
   * a load still writing (here or in another tab) is left alone.
   */
  async sweep(): Promise<void> {
    try {
      const live = new Set((await this.index.getAllGeometryIndex()).map((e) => e.key));
      const now = this.now();
      for (const key of await this.files.keys()) {
        if (live.has(key) || this.active.has(key)) continue;
        const at = cacheKeyTime(key);
        if (Number.isFinite(at) && now - at < ORPHAN_AGE_MS) continue;
        await this.files.remove(key);
      }
    } catch (err) {
      console.warn('GeometryCache: sweep failed', err);
    }
  }

  /** Remove an entry: its index record and its files. Never throws. */
  private async remove(entry: GeometryIndexRecord): Promise<void> {
    await this.index.removeGeometryIndex(entry.hash).catch(() => {});
    await this.files.remove(entry.key).catch(() => {});
  }
}