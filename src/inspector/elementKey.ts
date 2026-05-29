/**
 * The single canonical codec for element-identity map/set keys.
 *
 * Many modules need to use a `(modelId, expressId)` pair as a Map/Set key.
 * The string form `"<modelId>:<expressId>"` was previously copy-pasted in
 * several places; this module is the one authoritative definition so the
 * encoding can never drift between call sites.
 *
 * There is intentionally no `parseKey`: nothing in the codebase decodes a
 * key back into its parts today, and we do not build for hypothetical future
 * needs. Add the inverse only when a real consumer requires it.
 */

/** Encode a `(modelId, expressId)` pair as a stable map/set key. */
export function makeKey(modelId: string, expressId: number): string {
  return `${modelId}:${expressId}`;
}
