import { describe, it, expect } from 'vitest';
import { countVisibleColumns, visibleRows } from '../src/inspector/visibleCounts';
import type { ColumnData } from '../src/inspector/parameterColumn';

const N = 300_000;
const COLUMNS = 15;

/** A synthetic model: 15 columns over 300k rows, half text (40 values), half numbers (two units). */
function columns(): ColumnData[] {
  const out: ColumnData[] = [];
  for (let c = 0; c < COLUMNS; c++) {
    if (c % 2 === 0) {
      const codes = new Int32Array(N);
      for (let i = 0; i < N; i++) codes[i] = (i * 7 + c) % 41 === 0 ? -1 : (i * 13 + c) % 40;
      out.push({ type: 'discrete', key: `T${c}`, count: N, codes, dictionary: Array.from({ length: 40 }, (_, k) => `v${k}`) });
    } else {
      const values = new Float64Array(N);
      const unitIndex = new Uint16Array(N);
      for (let i = 0; i < N; i++) {
        values[i] = (i * 31 + c) % 200;
        unitIndex[i] = i % 5 === 0 ? 1 : 0;
      }
      out.push({
        type: 'numeric',
        key: `N${c}`,
        count: N,
        values,
        units: [
          { key: 'si:mm', symbol: 'mm' },
          { key: 'si:m', symbol: 'm' },
        ],
        unitIndex,
      });
    }
  }
  return out;
}

describe('recount cost on a large model', () => {
  /** Best of a few runs, after a warm-up: the number is for people to read. */
  function best(run: () => void): number {
    run();
    let b = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      run();
      b = Math.min(b, performance.now() - t0);
    }
    return b;
  }

  const ids = Int32Array.from({ length: N }, (_, i) => i);

  it('15 built columns, none open: only counts, no per-value maps', () => {
    const cols = columns();
    const rows = visibleRows(ids, (id) => id % 3 !== 0)!;
    const ms = best(() => countVisibleColumns(cols, rows, null));
    console.log(`visible recount, ${COLUMNS} columns x ${N} rows, none open: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1500);
    const out = countVisibleColumns(cols, rows, null);
    expect(out.get('T0')!.values).toBeNull();
  });

  it('one unique-per-element numeric column open: no per-value map for it', () => {
    const values = Float64Array.from({ length: N }, (_, i) => i + 0.5);
    const unique: ColumnData = { type: 'numeric', key: 'Unique', count: N, values, units: [{ key: 'si:mm', symbol: 'mm' }], unitIndex: null };
    const rows = visibleRows(ids, (id) => id % 3 !== 0)!;
    const ms = best(() => countVisibleColumns([unique], rows, { key: 'Unique', perValue: false }));
    console.log(`visible recount, unique numeric column x ${N} rows, open: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1500);
    const seen = countVisibleColumns([unique], rows, { key: 'Unique', perValue: false }).get('Unique')!;
    expect(seen.count).toBe(rows.length);
    expect(seen.values).toBeNull();
  });
});
