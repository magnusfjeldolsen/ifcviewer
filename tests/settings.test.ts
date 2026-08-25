// @vitest-environment jsdom
/**
 * `Settings` — the central store the queued settings panel will read from.
 *
 * One setting exists today (D10's hover pre-highlight, default on). What is
 * worth testing is the storage contract, because the panel and every future
 * consumer depend on it: the `ifcviewer:settings:*` key shape, the documented
 * default when nothing is stored, and — the one that bites in the wild —
 * falling back to the default rather than throwing when storage is corrupt or
 * unavailable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Settings, SETTINGS_DEFAULTS, SETTINGS_KEY_PREFIX } from '../src/services/Settings';

describe('Settings', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns the documented default when nothing is stored', () => {
    expect(new Settings().get('hoverPreHighlight')).toBe(SETTINGS_DEFAULTS.hoverPreHighlight);
  });

  it('defaults the hover pre-highlight ON (D10)', () => {
    // It is what makes Tab cycling legible; a feature nobody discovers is
    // worse than one somebody turns off.
    expect(SETTINGS_DEFAULTS.hoverPreHighlight).toBe(true);
  });

  it('persists under the ifcviewer:settings:* prefix', () => {
    new Settings().set('hoverPreHighlight', false);
    expect(window.localStorage.getItem(`${SETTINGS_KEY_PREFIX}hoverPreHighlight`)).toBe('false');
  });

  it('reads a stored value back in a fresh instance', () => {
    new Settings().set('hoverPreHighlight', false);
    expect(new Settings().get('hoverPreHighlight')).toBe(false);
  });

  it('toggle flips and returns the new value', () => {
    const settings = new Settings();
    expect(settings.toggle('hoverPreHighlight')).toBe(false);
    expect(settings.get('hoverPreHighlight')).toBe(false);
    expect(settings.toggle('hoverPreHighlight')).toBe(true);
  });

  it('notifies subscribers with the key that changed', () => {
    const settings = new Settings();
    const cb = vi.fn();
    settings.onChange(cb);

    settings.set('hoverPreHighlight', false);
    expect(cb).toHaveBeenCalledWith('hoverPreHighlight');
  });

  it('stays quiet when the value is unchanged', () => {
    const settings = new Settings();
    const cb = vi.fn();
    settings.onChange(cb);
    settings.set('hoverPreHighlight', true); // already the default
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribes cleanly', () => {
    const settings = new Settings();
    const cb = vi.fn();
    settings.onChange(cb)();
    settings.set('hoverPreHighlight', false);
    expect(cb).not.toHaveBeenCalled();
  });

  it('falls back to the default when the stored value is corrupt', () => {
    window.localStorage.setItem(`${SETTINGS_KEY_PREFIX}hoverPreHighlight`, 'not json');
    expect(new Settings().get('hoverPreHighlight')).toBe(true);
  });

  it('falls back to the default when the stored value is the wrong type', () => {
    window.localStorage.setItem(`${SETTINGS_KEY_PREFIX}hoverPreHighlight`, '"yes"');
    expect(new Settings().get('hoverPreHighlight')).toBe(true);
  });

  it('survives storage being unavailable entirely', () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    const settings = new Settings();
    expect(settings.get('hoverPreHighlight')).toBe(true);
    // The write still takes effect for this session, it just does not persist.
    expect(() => settings.set('hoverPreHighlight', false)).not.toThrow();
    expect(settings.get('hoverPreHighlight')).toBe(false);

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
