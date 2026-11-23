import { describe, it, expect } from 'vitest';
import { countVisible, visibleRows } from '../src/inspector/visibleCounts';
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
  it('counts 15 columns over 300k rows (one third hidden) quickly', () => {
    const cols = columns();
    const ids = Int32Array.from({ length: N }, (_, i) => i);
    const rows = visibleRows(ids, (id) => id % 3 !== 0)!;
    // Warm up, then take the best of a few runs: the number is for people to read.
    for (const c of cols) countVisible(c, rows);
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      for (const c of cols) countVisible(c, rows);
      best = Math.min(best, performance.now() - t0);
    }
    console.log(`visible recount, ${COLUMNS} columns x ${N} rows: ${best.toFixed(1)} ms`);
    expect(best).toBeLessThan(1500);
  });
});
