// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HistoryShortcuts } from '../src/ui/HistoryShortcuts';

/**
 * HistoryShortcuts wires the keyboard to a HistoryManager-shaped target:
 *   - Ctrl/Cmd+Z              → undo()
 *   - Ctrl/Cmd+Y  AND  Ctrl/Cmd+Shift+Z → redo()
 * It must NOT intercept when focus is inside a text-editing element (so the
 * browser's native text undo keeps working), and it must only preventDefault
 * when it actually handled the event.
 *
 * It's deliberately a SEPARATE module from KeyboardShortcuts: the latter maps
 * a single `e.key` and has no notion of modifier chords or focus guards. The
 * existing 8 KeyboardShortcuts tests are left untouched.
 */

interface FakeHistory {
  undo: ReturnType<typeof vi.fn<() => void>>;
  redo: ReturnType<typeof vi.fn<() => void>>;
}

function makeFakeHistory(): FakeHistory {
  return { undo: vi.fn<() => void>(), redo: vi.fn<() => void>() };
}

/** Dispatch a keydown with the given key + modifiers from a given target. */
function fireKey(
  key: string,
  opts: { ctrl?: boolean; meta?: boolean; shift?: boolean; target?: EventTarget } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: opts.ctrl ?? false,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (opts.target) {
    Object.defineProperty(event, 'target', { value: opts.target });
  }
  document.dispatchEvent(event);
  return event;
}

describe('HistoryShortcuts', () => {
  let history: FakeHistory;
  let shortcuts: HistoryShortcuts;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    history = makeFakeHistory();
    shortcuts = new HistoryShortcuts(history);
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    shortcuts.dispose();
    document.body.innerHTML = '';
  });

  it('T24: Ctrl+Z with focus on the canvas calls undo() and preventDefault fires', () => {
    const event = fireKey('z', { ctrl: true, target: canvas });
    expect(history.undo).toHaveBeenCalledTimes(1);
    expect(history.redo).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('T25: Ctrl+Y and Ctrl+Shift+Z both call redo()', () => {
    fireKey('y', { ctrl: true, target: canvas });
    expect(history.redo).toHaveBeenCalledTimes(1);

    fireKey('z', { ctrl: true, shift: true, target: canvas });
    expect(history.redo).toHaveBeenCalledTimes(2);

    expect(history.undo).not.toHaveBeenCalled();
  });

  it('T25b: Cmd+Z (meta) undoes and Cmd+Shift+Z redoes (mac chords)', () => {
    fireKey('z', { meta: true, target: canvas });
    expect(history.undo).toHaveBeenCalledTimes(1);

    fireKey('z', { meta: true, shift: true, target: canvas });
    expect(history.redo).toHaveBeenCalledTimes(1);
  });

  it('T26: Ctrl+Z with focus inside an input / textarea / contenteditable does NOT undo', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(input, textarea, editable);

    const e1 = fireKey('z', { ctrl: true, target: input });
    const e2 = fireKey('z', { ctrl: true, target: textarea });
    const e3 = fireKey('z', { ctrl: true, target: editable });

    expect(history.undo).not.toHaveBeenCalled();
    // We never intercepted, so the browser's native text-undo proceeds.
    expect(e1.defaultPrevented).toBe(false);
    expect(e2.defaultPrevented).toBe(false);
    expect(e3.defaultPrevented).toBe(false);
  });

  it('T27: Ctrl+Z on empty history is a no-op but still preventDefault on the canvas', () => {
    // The fake history just records the call; "empty" is the manager's concern.
    // What we assert here is that the shortcut intercepts (preventDefault) so
    // the browser does not do something surprising, and still routes to undo().
    const event = fireKey('z', { ctrl: true, target: canvas });
    expect(event.defaultPrevented).toBe(true);
    expect(history.undo).toHaveBeenCalledTimes(1);
  });

  it('plain z (no modifier) is ignored', () => {
    const event = fireKey('z', { target: canvas });
    expect(history.undo).not.toHaveBeenCalled();
    expect(history.redo).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('stops handling after dispose()', () => {
    shortcuts.dispose();
    fireKey('z', { ctrl: true, target: canvas });
    expect(history.undo).not.toHaveBeenCalled();
  });
});
