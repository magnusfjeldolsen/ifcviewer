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

/**
 * Selection size past which the context menu stops resolving each member's
 * real identity for "select all of this category / type".
 *
 * Those rows need every selected element's class, PredefinedType and type
 * name, and each one is a worker round-trip (~5–10 ms). A menu that appears
 * instantly without two rows beats one that appears half a second late with
 * them — and past this size the by-value affordance on the inspector's own
 * property rows covers the same ground, from an intersection that has
 * already been computed.
 */
export const SIMILAR_MENU_ENRICH_MAX = 50;
