/**
 * Central user-settings store.
 *
 * Every key lives under `ifcviewer:settings:*` in localStorage and is read
 * through here rather than by each consumer, so the queued `settings-panel`
 * card can surface the whole set without hunting for scattered
 * `localStorage.getItem` calls.
 *
 * Only one setting exists today (`hoverPreHighlight`, D10). The point of
 * shipping the module now is that it is small and the alternative — a
 * one-off key read inline — is exactly what the panel would later have to
 * unpick.
 *
 * Note what does NOT live here: the single-model-selection lock keeps its own
 * legacy key (`ifcviewer:inspectorSingleModelLock`) because moving it would
 * silently reset the preference for everyone who has already set it.
 */

export const SETTINGS_KEY_PREFIX = 'ifcviewer:settings:';

/**
 * The settings and their defaults. Adding a key here is all a new setting
 * needs — the storage key, the type and the default all follow.
 */
export interface SettingsShape {
  /**
   * D10 — show what a click would pick before the click. Default on: it is
   * what makes `Tab` cycling legible, and a feature nobody discovers is worse
   * than one somebody turns off.
   */
  hoverPreHighlight: boolean;
}

export const SETTINGS_DEFAULTS: Readonly<SettingsShape> = {
  hoverPreHighlight: true,
};

type SettingsKey = keyof SettingsShape;

export class Settings {
  private cache = new Map<SettingsKey, SettingsShape[SettingsKey]>();
  private listeners: Array<(key: SettingsKey) => void> = [];

  get<K extends SettingsKey>(key: K): SettingsShape[K] {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached as SettingsShape[K];

    const value = readStored(key) ?? SETTINGS_DEFAULTS[key];
    this.cache.set(key, value);
    return value as SettingsShape[K];
  }

  /** Persist and notify. A write of the current value notifies nobody. */
  set<K extends SettingsKey>(key: K, value: SettingsShape[K]): void {
    if (this.get(key) === value) return;
    this.cache.set(key, value);
    writeStored(key, value);
    for (const cb of this.listeners) cb(key);
  }

  /** Flip a boolean setting and return its new value. */
  toggle<K extends SettingsKey>(key: K): SettingsShape[K] {
    const next = !this.get(key) as SettingsShape[K];
    this.set(key, next);
    return next;
  }

  /** Subscribe to any setting change. Returns an unsubscribe callback. */
  onChange(listener: (key: SettingsKey) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  dispose(): void {
    this.listeners = [];
  }
}

function storageKey(key: SettingsKey): string {
  return `${SETTINGS_KEY_PREFIX}${key}`;
}

/**
 * Read one key, or null when it is unset or unreadable. A stored value that
 * does not parse is treated as unset: a corrupt entry must fall back to the
 * documented default rather than take the app down at construction time.
 */
function readStored(key: SettingsKey): SettingsShape[SettingsKey] | null {
  try {
    const raw = window.localStorage?.getItem(storageKey(key));
    if (raw === null || raw === undefined) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === typeof SETTINGS_DEFAULTS[key]
      ? (parsed as SettingsShape[SettingsKey])
      : null;
  } catch {
    return null;
  }
}

function writeStored(key: SettingsKey, value: SettingsShape[SettingsKey]): void {
  try {
    window.localStorage?.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    /* storage may be disabled — the in-memory cache still holds for this session */
  }
}
