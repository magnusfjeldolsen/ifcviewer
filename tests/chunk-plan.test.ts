import { describe, it, expect } from 'vitest';
import { ChunkPlan } from '../src/parser/chunkPlan';
import { planHelpers, MIN_HELPER_FILE_BYTES, MAX_HELPERS } from '../src/parser/parsePlan';

const last = <T,>(a: readonly T[]): T | undefined => a[a.length - 1];

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('ChunkPlan', () => {
  it('hands out every id exactly once, in order', () => {
    const plan = new ChunkPlan(range(1000), { workers: 3 });
    const seen: number[] = [];
    for (let c = plan.take(0); c; c = plan.take(c.index % 3)) seen.push(...c.ids);
    expect(seen).toEqual(range(1000));
    expect(plan.drained).toBe(true);
  });

  it('shrinks chunks as the list runs out, so no worker is left with a long tail', () => {
    const plan = new ChunkPlan(range(10000), { workers: 4, minChunk: 8, maxChunk: 100000 });
    const sizes: number[] = [];
    for (let c = plan.take(0); c; c = plan.take(0)) sizes.push(c.ids.length);
    expect(sizes[0]).toBe(625); // 10000 / (4 workers × 4)
    expect(last(sizes)).toBeLessThanOrEqual(8);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
  });

  it('caps a chunk at maxChunk', () => {
    const plan = new ChunkPlan(range(100000), { workers: 1, maxChunk: 512 });
    expect(plan.take(0)!.ids).toHaveLength(512);
  });

  it('is finished only when every chunk handed out has been delivered', () => {
    const plan = new ChunkPlan(range(10), { workers: 1, minChunk: 10 });
    const c = plan.take(0)!;
    expect(plan.drained).toBe(true);
    expect(plan.finished).toBe(false);
    plan.done(0, c.index);
    expect(plan.finished).toBe(true);
  });

  it('gives a failed worker’s unfinished chunks to the next worker that asks', () => {
    const plan = new ChunkPlan(range(100), { workers: 2, minChunk: 50 });
    const a = plan.take(1)!;
    const b = plan.take(0)!;
    plan.done(0, b.index);
    expect(plan.take(0)).toBeNull();
    plan.fail(1);
    expect(plan.drained).toBe(false);
    const again = plan.take(0)!;
    expect(again.ids).toEqual(a.ids);
    plan.done(0, again.index);
    expect(plan.finished).toBe(true);
  });

  it('an empty list is finished from the start', () => {
    const plan = new ChunkPlan([], { workers: 2 });
    expect(plan.take(0)).toBeNull();
    expect(plan.finished).toBe(true);
  });
});

describe('planHelpers', () => {
  const MB = 1024 * 1024;

  it('gives small files no helpers', () => {
    expect(planHelpers({ fileBytes: MIN_HELPER_FILE_BYTES - 1, cores: 20, deviceMemoryGB: 8 })).toBe(0);
  });

  it('keeps a core for the page and one for the main worker', () => {
    expect(planHelpers({ fileBytes: 48 * MB, cores: 4, deviceMemoryGB: 8 })).toBe(1);
    expect(planHelpers({ fileBytes: 48 * MB, cores: 2, deviceMemoryGB: 8 })).toBe(0);
  });

  it('never goes above the cap', () => {
    expect(planHelpers({ fileBytes: 48 * MB, cores: 64, deviceMemoryGB: 8 })).toBe(MAX_HELPERS);
  });

  it('gives a big file one helper however much memory the device has, at three file sizes each', () => {
    expect(planHelpers({ fileBytes: 357e6, cores: 20, deviceMemoryGB: 32 })).toBe(1);
    expect(planHelpers({ fileBytes: 229e6, cores: 20, deviceMemoryGB: 32 })).toBe(1);
    expect(planHelpers({ fileBytes: 48e6, cores: 20, deviceMemoryGB: 32 })).toBe(MAX_HELPERS);
  });

  it('gives a device that reports 4 GB or less no helpers at all', () => {
    // Chrome reports 0.25, 0.5, 1, 2, 4 or 8: anything up to 4 is a small device.
    for (const gb of [0.25, 0.5, 1, 2, 4]) {
      expect(planHelpers({ fileBytes: 48e6, cores: 20, deviceMemoryGB: gb })).toBe(0);
    }
  });

  it('keeps the usual limits when the device reports 8 GB, which is also what a 64 GB machine reports', () => {
    expect(planHelpers({ fileBytes: 48e6, cores: 20, deviceMemoryGB: 8 })).toBe(MAX_HELPERS);
    expect(planHelpers({ fileBytes: 357e6, cores: 20, deviceMemoryGB: 8 })).toBe(1);
  });

  it('counts helpers of other loads against the same budget', () => {
    expect(planHelpers({ fileBytes: 48e6, cores: 20, deviceMemoryGB: 32 })).toBe(MAX_HELPERS);
    // A 357 MB load's helper holds ~1.07 GB of the 1.25 GB budget: one more 48 MB load gets one.
    expect(planHelpers({ fileBytes: 48e6, cores: 20, deviceMemoryGB: 32, helperBytesInUse: 3 * 357e6 })).toBe(1);
    expect(planHelpers({ fileBytes: 357e6, cores: 20, deviceMemoryGB: 32, helperBytesInUse: 3 * 357e6 })).toBe(0);
  });

  it('keeps the usual limits when the browser does not say (Firefox, Safari)', () => {
    expect(planHelpers({ fileBytes: 48e6, cores: 20 })).toBe(MAX_HELPERS);
    expect(planHelpers({ fileBytes: 357e6, cores: 20 })).toBe(1);
    // Cores unknown: assume 4, which leaves room for one.
    expect(planHelpers({ fileBytes: 48 * MB })).toBe(1);
  });
});
