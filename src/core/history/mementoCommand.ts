import type { Command } from './Command';

/**
 * Build a `Command` from a before/after state snapshot (memento).
 *
 * Each subsystem already owns serializable state, so capturing a before/after
 * snapshot and restoring wholesale is simpler and more robust than computing
 * inverse operations — it matches "one user gesture = one snapshot pair."
 *
 * The helper does **not** clone the snapshots: callers pass already-captured
 * state that they will not mutate (e.g. a fresh array built at capture time),
 * and `apply` receives the exact reference back. Cloning here would be wasted
 * work for big mementos (a 1000-id selection) and would surprise callers that
 * rely on reference identity.
 *
 * Usage:
 *   const before = snapshot();
 *   doTheUserAction();
 *   const after = snapshot();
 *   history.push(mementoCommand('Label', before, after, restore));
 *
 * `restore(state)` must put the subsystem back to exactly `state`.
 */
export function mementoCommand<S>(
  label: string,
  before: S,
  after: S,
  apply: (state: S) => void,
): Command {
  return {
    label,
    undo: () => apply(before),
    redo: () => apply(after),
  };
}
