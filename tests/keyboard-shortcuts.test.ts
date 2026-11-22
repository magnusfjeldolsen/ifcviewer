// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyboardShortcuts } from '../src/ui/KeyboardShortcuts';

function fireKey(key: string, target: EventTarget = document.body): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  Object.defineProperty(event, 'target', { value: target });
  document.dispatchEvent(event);
}

describe('KeyboardShortcuts', () => {
  let shortcuts: KeyboardShortcuts;

  beforeEach(() => {
    shortcuts = new KeyboardShortcuts();
  });

  afterEach(() => {
    shortcuts.dispose();
  });

  it('should fire registered shortcut on keydown', () => {
    const action = vi.fn();
    shortcuts.register({ key: 'c', label: 'Cut', action });

    fireKey('c');

    expect(action).toHaveBeenCalledOnce();
  });

  it('should match case-insensitively for letter keys', () => {
    const action = vi.fn();
    shortcuts.register({ key: 'c', label: 'Cut', action });

    fireKey('C');

    expect(action).toHaveBeenCalledOnce();
  });

  it('should not fire when typing in an input element', () => {
    const action = vi.fn();
    shortcuts.register({ key: 'c', label: 'Cut', action });

    const input = document.createElement('input');
    fireKey('c', input);

    expect(action).not.toHaveBeenCalled();
  });

  it('should not fire when typing in a textarea', () => {
    const action = vi.fn();
    shortcuts.register({ key: 'm', label: 'Measure', action });

    const textarea = document.createElement('textarea');
    fireKey('m', textarea);

    expect(action).not.toHaveBeenCalled();
  });

  it('should handle special keys like Escape', () => {
    const action = vi.fn();
    shortcuts.register({ key: 'Escape', label: 'Cancel', action });

    fireKey('Escape');

    expect(action).toHaveBeenCalledOnce();
  });

  it('should unregister a shortcut', () => {
    const action = vi.fn();
    shortcuts.register({ key: 'c', label: 'Cut', action });
    shortcuts.unregister('c');

    fireKey('c');

    expect(action).not.toHaveBeenCalled();
  });

  it('should return all registered shortcuts via getAll()', () => {
    shortcuts.register({ key: 'c', label: 'Cut', action: vi.fn() });
    shortcuts.register({ key: 'm', label: 'Measure', action: vi.fn() });

    const all = shortcuts.getAll();

    expect(all).toHaveLength(2);
    expect(all.map((s) => s.key)).toEqual(['c', 'm']);
  });

  it('should stop firing after dispose', () => {
    const action = vi.fn();
    shortcuts.register({ key: 'c', label: 'Cut', action });
    shortcuts.dispose();

    fireKey('c');

    expect(action).not.toHaveBeenCalled();
  });

  it('should ignore unregistered keys', () => {
    const action = vi.fn();
    shortcuts.register({ key: 'c', label: 'Cut', action });

    fireKey('x');

    expect(action).not.toHaveBeenCalled();
  });

  it('ignores auto-repeat, so holding a toggle key does not flicker it', () => {
    const action = vi.fn();
    shortcuts.register({ key: 'g', label: 'Fly', action });
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
    for (let i = 0; i < 5; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', repeat: true, bubbles: true }));
    expect(action).toHaveBeenCalledOnce();
  });

  it('a plain-only shortcut ignores Ctrl, Cmd and Alt chords', () => {
    const fly = vi.fn();
    const fit = vi.fn();
    shortcuts.register({ key: 'g', label: 'Fly', plainOnly: true, action: fly });
    shortcuts.register({ key: 'f', label: 'Fit', action: fit });
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const e = new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true, ...mod });
      document.body.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false); // the browser's own Ctrl+G still works
    }
    expect(fly).not.toHaveBeenCalled();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
    expect(fly).toHaveBeenCalledOnce();
    // Other shortcuts are unchanged.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(fit).toHaveBeenCalledOnce();
  });});
