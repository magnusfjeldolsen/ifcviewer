# Plan — Undo / Redo (Ctrl+Z · Ctrl+Y)

Implementation-ready plan. Branch `feature/undo-redo` off `main`. Effort **M**.
The interaction keystone of `phase-scope-ops-and-undo.md`: a global history
that makes every scene-editing action reversible at the granularity the user
perceives. Build the **core + selection undo** first; retrofit clipping and
measurement second (§ Retrofit); new features (appearance, select-similar) are
born undo-aware on top of this contract.

## Goal

Ctrl+Z undoes, Ctrl+Y (and Ctrl+Shift+Z) redoes, the **last user action** —
where "an action" is one user-perceived gesture, not one internal mutation.
Adding 1000 elements via marquee undoes in one step. Camera moves are never
undoable. The history is transient (not persisted across reload).

## Architecture — Command pattern + a single HistoryManager

A **`Command`** captures one reversible action. The action is *already applied*
when the command is created; the command knows how to put state back and how to
re-apply it.

```ts
// src/core/history/Command.ts
export interface Command {
  /** Human label, e.g. "Hide 12 elements" — for tooltips / future history UI. */
  readonly label: string;
  /** Revert to the pre-action state. */
  undo(): void;
  /** Re-apply the action (after an undo). */
  redo(): void;
}
```

**`HistoryManager`** — the single owner of the undo/redo stacks.

```ts
// src/core/history/HistoryManager.ts
export class HistoryManager {
  push(command: Command): void;     // clears the redo stack
  undo(): void;                     // pop undo → cmd.undo() → push redo
  redo(): void;                     // pop redo → cmd.redo() → push undo
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;                    // e.g. on model add/remove (see Edge cases)
  isApplying(): boolean;            // true while an undo/redo is re-applying state
  onChange(cb: () => void): () => void; // for future history-state UI affordances
}
```

Key behaviours:
- **`push` clears redo** (standard — a new action invalidates the redo future).
- **Depth cap** (`MAX_HISTORY`, default **50**): pushing past the cap drops the
  oldest undo entry. Bounds memory for big selection mementos.
- **`isApplying()` guard**: set true around `cmd.undo()` / `cmd.redo()`. Every
  subsystem that emits commands checks this and **does not push** while a
  command is re-applying state — otherwise undoing a selection change would push
  a *new* selection command and corrupt the stack. This is the single most
  important correctness rule.

`HistoryManager` is **pure and unit-testable** with fake commands — no DOM, no
THREE.

## State capture — memento, not inverse-delta

Each subsystem already owns serializable state, so capture a **before/after
snapshot** (memento) and restore wholesale. Simpler and more robust than
computing inverse operations, and it matches "one event = one snapshot pair."

Generic helper to avoid boilerplate:

```ts
// src/core/history/mementoCommand.ts
export function mementoCommand<S>(
  label: string,
  before: S,
  after: S,
  apply: (state: S) => void,   // restores the subsystem to `state`
): Command {
  return {
    label,
    undo: () => apply(before),
    redo: () => apply(after),
  };
}
```

Subsystems snapshot `before`, perform the user action, snapshot `after`, then
`history.push(mementoCommand(label, before, after, applyFn))` — guarded by
`!history.isApplying()`.

## Keyboard wiring

Extend `src/ui/KeyboardShortcuts.ts` (or a small `HistoryShortcuts` module):
- `Ctrl/Cmd+Z` → `history.undo()`; `Ctrl/Cmd+Y` **or** `Ctrl/Cmd+Shift+Z` →
  `history.redo()`.
- **Input-focus guard**: if `document.activeElement` is an `<input>`,
  `<textarea>`, `[contenteditable]`, or inside one (e.g. the inspector search,
  future filter fields), **do not** intercept — let the browser do native text
  undo. This is essential once we have text inputs.
- `preventDefault()` only when we actually handle it.

## Per-subsystem granularity (the crux)

### Selection (ship in this PR — proves the model)
`SelectionManager` already collapses one gesture into one state change and one
`onChange`. Make each **user-initiated** mutation push one command:
- single click (`replace` / `add` toggle / `remove`), marquee `applyMany`,
  recall `selectExactly`, and `clear` → snapshot the selected-key set before,
  do the mutation, snapshot after, push one `mementoCommand` whose `apply`
  calls a lock-bypassing internal "set exactly these keys" (reuse the
  `selectExactly` machinery so restore spans models without touching the
  single-model-lock).
- **Do NOT push** for *system* selection changes: `onModelRemoved` pruning and
  any restore-from-session path are sync, not user actions.
- Implementation: give `SelectionManager` an optional `history` dep. The public
  user-action methods push; the sync methods don't. All pushes are guarded by
  `!history.isApplying()` so restoring during undo doesn't re-push.

### Clipping (Retrofit — § below)
Capture the plane memento (`{ normal, offset, enabled }` or the tool's
serializable plane state) at **pointer-down** and at **pointer-up** → one
command for the whole drag ("from mouse pressed to released" = one event).
Creating a plane and removing it (the tray "Remove clipping") are one command
each.

### Measurement (Retrofit — § below)
A **completed** measurement is one command (undo removes that whole
measurement; redo re-adds it). Removing a measurement is one command. The
command is pushed only on completion, so an undo never leaves a half-placed
measurement. If the user hits Ctrl+Z while mid-placement (first anchor down,
second pending), cancel the in-progress placement instead (no command) — define
this in the retrofit.

### Appearance (built undo-aware in `handoff-element-appearance.md`)
Each hide / unhide / isolate / show-all / transparent / opaque op over a Scope
= one command; memento = the prior appearance state of the affected elements.

### Selection basket (U3 — undoable)
The basket **is** undoable: an accidental **MC** (clear) or an over-eager bulk
**M+** must be recoverable. Memento = the basket's contents (the
`{ modelId, expressId }[]` it already serializes) before/after:
- **M+** (add the live selection) → one command, even when the selection is
  1000 elements.
- **M−** (remove) → one command.
- **MC** (clear) → one command — this is the "I didn't mean to clear it" case.
- **MR** (recall) does **not** change the basket; it changes the *selection*,
  which is already covered by selection undo. No separate basket command.
Restoring the basket during undo fires its `onChange`, which re-runs the
debounced session save — correct and harmless. Guarded by `isApplying()` so the
restore doesn't push a fresh command.

### Never recorded
Camera orbit / pan / zoom / fly-to / fit, pivot set. The single-model-lock
toggle is a persisted *preference*, not a scene edit — also not recorded.

## Files

| File | Change |
|------|--------|
| `src/core/history/Command.ts` | NEW — the `Command` interface. |
| `src/core/history/HistoryManager.ts` | NEW — stacks, push/undo/redo, depth cap, `isApplying`, `onChange`. Pure. |
| `src/core/history/mementoCommand.ts` | NEW — the before/after snapshot helper. |
| `src/ui/KeyboardShortcuts.ts` | Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z + input-focus guard. |
| `src/inspector/SelectionManager.ts` | Push selection commands for user actions; suppress during apply + sync. |
| `src/inspector/SelectionBasket.ts` | Push basket commands for M+ / M− / MC (memento of contents); suppress during apply + session restore. |
| `src/core/App.ts` | Construct the single `HistoryManager`; inject into SelectionManager + SelectionBasket (and later tools / appearance); `history.clear()` on model add/remove (see Edge cases). |

Retrofit (separate or follow-on PR) also touches `ClippingTool.ts` and
`MeasurementTool.ts`.

## Edge cases

- **Model add/remove invalidates references.** A history entry holds expressIds
  of a model that may be removed. **v1: `history.clear()` on any model add or
  remove** — safe and predictable. (Refinement later: prune only the affected
  entries.) Decision **U2**.
- **Empty stack** → undo/redo are no-ops; the shortcut still `preventDefault`s
  so the browser doesn't do something surprising, *unless* focus is in a text
  input (then we never intercepted).
- **Re-entrancy** → `isApplying()` guard (above) is the protection.
- **Undo of a selection across models** → the restore `apply` bypasses the
  single-model-lock (reuse `selectExactly`) so it faithfully restores a
  cross-model selection without mutating the user's lock preference.
- **Tool visual sync** → a command's `undo`/`redo` calls back into the owning
  subsystem's normal apply path, which already `requestRender()`s and updates
  any handles (clip plane gizmo, measurement labels).

## Test plan

**Automated** (the core is pure → strong unit coverage):
- `tests/history-manager.test.ts` (NEW): push/undo/redo; `push` clears redo;
  depth cap drops oldest; `canUndo/canRedo`; `onChange` fires; `isApplying`
  true only during re-apply; re-apply does not push (guarded fake command).
- `tests/mementoCommand.test.ts` (NEW): undo applies `before`, redo applies
  `after`.
- `SelectionManager` (extend `inspector-selection.test.ts`): a single
  `applyMany`/`selectExactly` of N ids → one command; undo restores prior
  selection exactly; redo re-applies; `onModelRemoved` pruning pushes **no**
  command; undo during model-removal is consistent.
- Keyboard guard (jsdom): Ctrl+Z with focus in an `<input>` does **not** call
  `history.undo()`; with focus on the canvas it does.

**Manual smoke**:
1. Marquee-select ~hundreds → Ctrl+Z once → selection returns to prior state in
   one step. Ctrl+Y → reselects.
2. Click A, ctrl-click B, ctrl-click C → three Ctrl+Z steps walk back A←B←C.
3. Type in inspector search, Ctrl+Z → edits the *text*, not the selection.
4. Undo with an empty history → nothing breaks; page doesn't navigate.
5. Remove a model → undo history is cleared (no stale-id crash on a later undo).

## Retrofit — clipping + measurement (follow-on)

After the core + selection ship and the contract is proven:
- **ClippingTool**: snapshot plane state at `onPointerDown`; on `onPointerUp`
  push one `mementoCommand("Adjust clip plane", before, after, applyPlane)`.
  Create-plane and remove-plane (tray button) push their own commands.
- **MeasurementTool**: on measurement completion push `mementoCommand("Add
  measurement", beforeList, afterList, setMeasurements)`; on delete push the
  inverse. Mid-placement Ctrl+Z cancels the pending placement (no command).
- Tests: a clip drag = one undo restores the prior offset; a completed
  measurement undo removes the whole measurement; redo restores it.

## Open decisions

- **U1 — depth cap value.** Recommend **50**. (Memory: a 1000-id selection
  memento is ~8 KB serialized; 50 entries ≈ trivial.)
- **U4 — redo keys.** Recommend supporting **both** Ctrl+Y and Ctrl+Shift+Z.
- **U5 — a visible history UI** (undo/redo buttons, list)? Out of scope v1;
  `onChange` is exposed so it can be added later without touching the core.

## Confirmed (build to these)

- **Granularity** (user): clipping = drag start→end is one event; measurement =
  whole measurement is one event; selection bulk op (e.g. 1000 via marquee) is
  one event; camera state is **not** recorded. Events must align with how the
  user interacts.
- **U2 — model add/remove clears the history** (v1; safe and predictable —
  prune-only is a later refinement).
- **U3 — the Selection Basket IS undoable.** M+ / M− / MC each = one command,
  so an accidental clear or an over-eager bulk add is recoverable. (See the
  Selection basket granularity subsection above.)
