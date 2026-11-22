/**
 * What the Totals tab remembers between visits (#69): the parameters added
 * as rows, how each row is charted, and the group-by parameter. Kept by
 * parameter key, not by model, so the next model with the same parameters
 * shows its totals with no clicks. See docs/adr/0006.
 *
 * Stored in this browser only, as versioned JSON:
 *
 *   {"v":1,"rows":[{"key":"Qto_BeamBaseQuantities.NetVolume"},
 *                  {"key":"Identity.IfcClass","chart":"pie"}],
 *    "groupBy":"Identity.Type"}
 *
 * Anything unreadable is dropped rather than failing: a damaged entry
 * gives an empty Totals tab, never an error.
 */

export interface TotalsRowSetting {
  /** The parameter: its flat-row path. */
  key: string;
  /** Shown as a share chart instead of bars (only meaningful when grouped). */
  chart?: 'pie';
}

export interface TotalsSettings {
  rows: TotalsRowSetting[];
  groupBy: string | null;
}

export const TOTALS_STORAGE = 'ifcviewer:totals';

/** More rows than anyone reads at a glance; a damaged entry cannot grow without end. */
export const MAX_TOTALS_ROWS = 50;

export function emptyTotalsSettings(): TotalsSettings {
  return { rows: [], groupBy: null };
}

/** Read stored settings, tolerating anything: unknown or broken parts are dropped. */
export function parseTotalsSettings(raw: string | null): TotalsSettings {
  if (!raw) return emptyTotalsSettings();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyTotalsSettings();
  }
  if (typeof data !== 'object' || data === null || (data as { v?: unknown }).v !== 1) return emptyTotalsSettings();
  const d = data as { rows?: unknown; groupBy?: unknown };
  const rows: TotalsRowSetting[] = [];
  const seen = new Set<string>();
  if (Array.isArray(d.rows)) {
    for (const r of d.rows) {
      if (typeof r !== 'object' || r === null) continue;
      const key = (r as { key?: unknown }).key;
      if (typeof key !== 'string' || key === '' || seen.has(key)) continue;
      seen.add(key);
      const row: TotalsRowSetting = { key };
      if ((r as { chart?: unknown }).chart === 'pie') row.chart = 'pie';
      rows.push(row);
      if (rows.length >= MAX_TOTALS_ROWS) break;
    }
  }
  const groupBy = typeof d.groupBy === 'string' && d.groupBy !== '' ? d.groupBy : null;
  return { rows, groupBy };
}

export function serialiseTotalsSettings(s: TotalsSettings): string {
  return JSON.stringify({
    v: 1,
    rows: s.rows.map((r) => (r.chart ? { key: r.key, chart: r.chart } : { key: r.key })),
    groupBy: s.groupBy,
  });
}

/** Where settings are kept; `localStorage` in the app. */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadTotalsSettings(storage: SettingsStorage | null = defaultStorage()): TotalsSettings {
  try {
    return parseTotalsSettings(storage?.getItem(TOTALS_STORAGE) ?? null);
  } catch {
    return emptyTotalsSettings();
  }
}

export function saveTotalsSettings(s: TotalsSettings, storage: SettingsStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(TOTALS_STORAGE, serialiseTotalsSettings(s));
  } catch {
    // Storage blocked or full: the rows last until the page is reloaded.
  }
}
