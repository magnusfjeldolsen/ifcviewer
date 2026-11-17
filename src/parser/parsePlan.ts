/**
 * How many helper workers stream a model's geometry alongside the main one.
 *
 * Each helper opens its own copy of the file, so it costs that copy plus a
 * web-ifc heap (about twice the file) for as long as the load runs, and its
 * open competes with the others: opening is not free in parallel. What it buys
 * is geometry time, which on a geometry-heavy file is most of the load.
 *
 * - Small files get none: they are done before a helper could join.
 * - At most `MAX_HELPERS`, and never more than half the cores minus the one
 *   the main worker uses, so the page itself keeps a core.
 * - Within a memory budget of `HELPER_BUDGET_BYTES`, or a quarter of the
 *   device's memory if that is less, at three file sizes per helper.
 *
 * The budget is what keeps the peak in check. Measured on a 357 MB model:
 * one helper cut the load from 10.3 s to 8.8 s for +0.7 GB at peak; three
 * cut it to 8.5 s for +2 GB. On a 48 MB model whose geometry is the whole
 * load, three helpers cut 26.8 s to 12.1 s for little memory. So a big file
 * gets one helper and a geometry-heavy small one gets three.
 */

/** Files below this parse alone. */
export const MIN_HELPER_FILE_BYTES = 20 * 1024 * 1024;

/** Most helpers for one model. */
export const MAX_HELPERS = 3;

/** What one helper is assumed to hold, in multiples of the file size. */
export const HELPER_MEMORY_FACTOR = 3;

/** Most memory all helpers together may hold. */
export const HELPER_BUDGET_BYTES = 1.25 * 1024 ** 3;

export interface HelperPlanInput {
  fileBytes: number;
  /** `navigator.hardwareConcurrency`; unknown means assume 4. */
  cores?: number;
  /** `navigator.deviceMemory` in GB; unknown means assume 4. */
  deviceMemoryGB?: number;
  /**
   * What helpers of other loads still running are assumed to hold: the
   * budget is for all helpers at once, not per load.
   */
  helperBytesInUse?: number;
}

export function planHelpers({ fileBytes, cores, deviceMemoryGB, helperBytesInUse = 0 }: HelperPlanInput): number {
  if (!(fileBytes >= MIN_HELPER_FILE_BYTES)) return 0;
  const byCores = Math.floor((cores ?? 4) / 2) - 1;
  const budget = Math.min(HELPER_BUDGET_BYTES, ((deviceMemoryGB ?? 4) * 1024 ** 3) / 4) - helperBytesInUse;
  const byMemory = Math.floor(budget / (HELPER_MEMORY_FACTOR * fileBytes));
  return Math.max(0, Math.min(MAX_HELPERS, byCores, byMemory));
}
