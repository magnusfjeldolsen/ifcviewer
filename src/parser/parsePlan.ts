/**
 * How many helper workers stream a model's geometry alongside the main one.
 *
 * Each helper opens its own copy of the file, so it costs that copy plus a
 * web-ifc heap — twice the file on a 357 MB model, six times on a
 * geometry-heavy 48 MB one (277 MB each) — for as long as the load runs, and its
 * open competes with the others: opening is not free in parallel. What it buys
 * is geometry time, which on a geometry-heavy file is most of the load.
 *
 * - Small files get none: they are done before a helper could join.
 * - At most `MAX_HELPERS`, and never more than half the cores minus the one
 *   the main worker uses, so the page itself keeps a core.
 * - None on a device that reports 4 GB of memory or less. Chrome reports
 *   `navigator.deviceMemory` in coarse powers of two, documented as capped
 *   at 8 (the Chrome measured here says 32 on a 64 GB machine); Firefox and
 *   Safari say nothing. Anything above 4, or nothing, keeps the rules below.
 * - Within a memory budget of `HELPER_BUDGET_BYTES` for all loads at once,
 *   at three file sizes per helper.
 *
 * The budget is what keeps the peak in check. Measured on a 357 MB model:
 * one helper cut the load from 10.3 s to 8.8 s for +0.7 GB at peak; three
 * cut it to 8.5 s for +2 GB. On a 48 MB model whose geometry is the whole
 * load (none → two → three helpers): 25.7 s → 12.6 s → 10.5–11.6 s, and the
 * page's own process peaked at 2.9 → 3.9 → 4.4 GB (it was 3.8 GB before any
 * of this work). The third helper bought about a second for half a gigabyte
 * over the old peak, so there are at most two: a big file gets one, a
 * geometry-heavy small one two.
 */

/** Files below this parse alone. */
export const MIN_HELPER_FILE_BYTES = 20 * 1024 * 1024;

/** Most helpers for one model. */
export const MAX_HELPERS = 2;

/** What one helper is assumed to hold, in multiples of the file size. */
export const HELPER_MEMORY_FACTOR = 3;

/** Devices reporting this much memory (GB) or less get no helpers. */
export const SMALL_DEVICE_GB = 4;

/** Most memory all helpers together may hold. */
export const HELPER_BUDGET_BYTES = 1.25 * 1024 ** 3;

export interface HelperPlanInput {
  fileBytes: number;
  /** `navigator.hardwareConcurrency`; unknown means assume 4. */
  cores?: number;
  /** `navigator.deviceMemory` in GB, as the browser reports it; undefined where it does not. */
  deviceMemoryGB?: number;
  /**
   * What helpers of other loads still running are assumed to hold: the
   * budget is for all helpers at once, not per load.
   */
  helperBytesInUse?: number;
}

export function planHelpers({ fileBytes, cores, deviceMemoryGB, helperBytesInUse = 0 }: HelperPlanInput): number {
  if (!(fileBytes >= MIN_HELPER_FILE_BYTES)) return 0;
  if (deviceMemoryGB !== undefined && deviceMemoryGB <= SMALL_DEVICE_GB) return 0;
  const byCores = Math.floor((cores ?? 4) / 2) - 1;
  const budget = HELPER_BUDGET_BYTES - helperBytesInUse;
  const byMemory = Math.floor(budget / (HELPER_MEMORY_FACTOR * fileBytes));
  return Math.max(0, Math.min(MAX_HELPERS, byCores, byMemory));
}
