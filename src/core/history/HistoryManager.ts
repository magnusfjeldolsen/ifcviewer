import type { Command } from './Command';

/**
 * Depth cap for the undo stack. Pushing past this drops the oldest entry.
 * Bounds memory for big selection mementos (a 1000-id selection serializes to
 * ~8 KB; 50 entries is trivial). Decision U1 in handoff-undo-redo.md.
 */
export const MAX_HISTORY = 50;

/**
 * The single owner of the undo / redo stacks for the whole app.
 *
 * Pure: no DOM, no THREE. Every scene-editing subsystem (selection, basket,
 * later clipping / measurement / appearance) pushes one `Command` per
 * user-perceived gesture and otherwise leaves the stacks alone.
 *
 * The single most important correctness rule is the `isApplying()` guard: it
 * is true only while a command is re-applying state inside `undo()` / `redo()`.
 * Every subsystem that emits commands checks `!isApplying()` before pushing, so
 * the act of undoing (which calls back into the subsystem's apply path, firing
 * its onChange) does NOT push a fresh command and corrupt the stack.
 *
 * See dev/plans/handoff-undo-redo.md.
 */
export class HistoryManager {
  /** Past actions, oldest first; `undoStack[length-1]` is the next to undo. */
  private undoStack: Command[] = [];
  /** Undone actions, most-recently-undone last; the next to redo. */
  private redoStack: Command[] = [];

  /** True only while a command is re-applying state (inside undo/redo). */
  private applying = false;

  /** Observer pattern, mirroring SelectionManager / tools (see observer memory). */
  private changeListeners: Array<() => void> = [];

  /**
   * Record an already-applied action. Clears the redo stack (a new action
   * invalidates the redo future) and drops the oldest entry past the cap.
   * Notifies on every push.
   */
  push(command: Command): void {
    this.undoStack.push(command);
    if (this.undoStack.length > MAX_HISTORY) {
      this.undoStack.shift(); // drop the oldest
    }
    this.redoStack = [];
    this.notifyChange();
  }

  /**
   * Revert the most recent action. No-op (no notify) on an empty undo stack.
   * The `isApplying` flag is raised around `cmd.undo()` so the subsystem's
   * own apply path doesn't push a fresh command. The flag is cleared in a
   * `finally` so a throwing command can't freeze the manager.
   */
  undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;
    this.applying = true;
    try {
      command.undo();
    } finally {
      this.applying = false;
    }
    this.redoStack.push(command);
    this.notifyChange();
  }

  /**
   * Re-apply the most recently undone action. No-op (no notify) on an empty
   * redo stack. Same `isApplying` guard discipline as `undo()`.
   */
  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    this.applying = true;
    try {
      command.redo();
    } finally {
      this.applying = false;
    }
    this.undoStack.push(command);
    this.notifyChange();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Empty both stacks and notify. Called on any model add/remove (decision
   * U2) because a stale entry could hold expressIds of a removed model.
   *
   * Notifies unconditionally — even on an already-empty history — so the
   * model add/remove path can always let observers (a future history UI)
   * refresh without special-casing the empty case.
   */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.notifyChange();
  }

  /** True only while a command is re-applying state (inside undo/redo). */
  isApplying(): boolean {
    return this.applying;
  }

  /** Subscribe to stack-state changes. Returns an unsubscribe callback. */
  onChange(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  private notifyChange(): void {
    for (const cb of this.changeListeners) cb();
  }
}
