export interface ShortcutEntry {
  key: string;
  label: string;
  description?: string;
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

      // Match case-insensitively for letter keys
      const entry = this.shortcuts.get(e.key) ?? this.shortcuts.get(e.key.toLowerCase());
      if (entry) {
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
