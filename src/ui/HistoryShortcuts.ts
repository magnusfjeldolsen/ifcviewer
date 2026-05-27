/**
 * Keyboard wiring for undo / redo.
 *
 * A dedicated module — NOT part of `KeyboardShortcuts`, which maps a single
 * `e.key` with no notion of modifier chords or a focus guard. Here we need:
 *   - Ctrl/Cmd+Z              → undo()
 *   - Ctrl/Cmd+Y  OR  Ctrl/Cmd+Shift+Z → redo()  (decision U4: support both)
 *   - an input-focus guard so the browser's native text undo keeps working
 *     when the user is typing in the inspector search / future filter fields
 *   - preventDefault ONLY when we actually handle the event
 *
 * Decoupled from the concrete HistoryManager via a minimal structural target
 * (just `undo()` / `redo()`), so it's trivially testable with a fake and the
 * core stays DOM-free.
 *
 * See dev/plans/handoff-undo-redo.md ("Keyboard wiring").
 */
export interface HistoryTarget {
  undo(): void;
  redo(): void;
}

export class HistoryShortcuts {
  private target: HistoryTarget;
  private listener: (e: KeyboardEvent) => void;

  constructor(target: HistoryTarget) {
    this.target = target;
    this.listener = (e: KeyboardEvent) => this.onKeyDown(e);
    document.addEventListener('keydown', this.listener);
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Only Ctrl (Windows/Linux) or Cmd (macOS) chords concern us.
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    const key = e.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;

    // Focus guard: never intercept text-editing contexts — let the browser do
    // native text undo. Checked AFTER the key match so an unrelated keystroke
    // in an input is cheap, and BEFORE preventDefault so we never swallow it.
    if (isTextEditingTarget(e.target)) return;

    // Z without shift → undo; Z+shift OR Y → redo.
    let handled = false;
    if (key === 'z' && !e.shiftKey) {
      this.target.undo();
      handled = true;
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
      this.target.redo();
      handled = true;
    }

    if (handled) e.preventDefault();
  }

  dispose(): void {
    document.removeEventListener('keydown', this.listener);
  }
}

/**
 * True when the event target is (or sits inside) a text-editing element —
 * <input>, <textarea>, or anything with contenteditable. We bail on these so
 * the browser's native text undo isn't hijacked.
 */
function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  // `isContentEditable` covers a contenteditable ancestor in real browsers,
  // but jsdom only reports it for laid-out elements. Fall back to walking the
  // `contenteditable` attribute up the tree so the guard is reliable in both
  // (and so a focused <span> inside a contenteditable <div> is still caught).
  if (target.isContentEditable) return true;
  for (let el: HTMLElement | null = target; el; el = el.parentElement) {
    const attr = el.getAttribute('contenteditable');
    if (attr !== null && attr !== 'false') return true;
  }
  return false;
}
