export interface ShortcutEntry {
  key: string;
  label: string;
  description?: string;
  /**
   * Fire only for the bare key: not with Ctrl, Cmd or Alt held. For a mode
   * toggle, where Ctrl+G (the browser's find-next) must not flip the mode.
   */
  plainOnly?: boolean;
  action: () => void;
}

export class KeyboardShortcuts {
  private shortcuts = new Map<string, ShortcutEntry>();
  private listener: (e: KeyboardEvent) => void;

  constructor() {
    this.listener = (e: KeyboardEvent) => {
      // Don't fire shortcuts when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // One press, one action. A held key's auto-repeat would toggle a mode
      // (G, V, ?) on and off many times a second, and repeat a deletion.
      if (e.repeat) return;

      // Match case-insensitively for letter keys
      const entry = this.shortcuts.get(e.key) ?? this.shortcuts.get(e.key.toLowerCase());
      if (entry) {
        if (entry.plainOnly && (e.ctrlKey || e.metaKey || e.altKey)) return;
        e.preventDefault();
        entry.action();
      }
    };
    document.addEventListener('keydown', this.listener);
  }

  register(entry: ShortcutEntry): void {
    this.shortcuts.set(entry.key, entry);
  }

  unregister(key: string): void {
    this.shortcuts.delete(key);
  }

  getAll(): ShortcutEntry[] {
    return Array.from(this.shortcuts.values());
  }

  dispose(): void {
    document.removeEventListener('keydown', this.listener);
    this.shortcuts.clear();
  }
}
