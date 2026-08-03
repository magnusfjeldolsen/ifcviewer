/**
 * Tunable limits for the inspector's bulk paths.
 *
 * Central so the future `settings-panel` card can surface them without
 * reaching into panel internals — the user has asked for these to be
 * user-tunable.
 */

/**
 * Selection size past which the inspector asks before computing the
 * property intersection, instead of computing it immediately.
 *
 * This is a **sanity guard, not a cap**: below it the reduction runs with a
 * live progress overlay, and above it the user gets a "Compute anyway"
 * button rather than a refusal. The work itself is bounded — the worker
 * folds incrementally with O(1) memory and yields between chunks, so
 * navigation stays smooth at any N — but a very large selection can still
 * take long enough that silently starting it would be presumptuous.
 *
 * It governs ONLY the inspector's intersection display. Selecting, hiding,
 * isolating, coloring, `findMatching` and aggregation are unaffected: they
 * act on ids or reduce in the worker.
 */
export const BULK_INTERSECT_GUARD = 10_000;
