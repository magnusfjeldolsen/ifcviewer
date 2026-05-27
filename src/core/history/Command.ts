/**
 * One reversible user action.
 *
 * A `Command` is created *after* its action has already been applied — the
 * subsystem mutates its own state, then constructs the command knowing how to
 * put that state back (`undo`) and how to re-apply it (`redo`). The
 * HistoryManager owns the stacks; the command only knows how to move state
 * between its two snapshots.
 *
 * See dev/plans/handoff-undo-redo.md ("Architecture — Command pattern").
 */
export interface Command {
  /** Human label, e.g. "Hide 12 elements" — for tooltips / future history UI. */
  readonly label: string;
  /** Revert to the pre-action state. */
  undo(): void;
  /** Re-apply the action (after an undo). */
  redo(): void;
}
