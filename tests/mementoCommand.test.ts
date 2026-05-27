import { describe, it, expect } from 'vitest';
import { mementoCommand } from '../src/core/history/mementoCommand';

/**
 * mementoCommand wraps a before/after snapshot pair into a Command. It does
 * NOT clone the snapshots — callers pass already-captured immutable-enough
 * state (e.g. a frozen array of keys), so undo/redo simply hand the exact
 * reference back to the subsystem's apply function.
 */

describe('mementoCommand', () => {
  it('T10: undo() applies `before`, redo() applies `after`, and label is preserved', () => {
    const applied: string[] = [];
    const before = 'BEFORE';
    const after = 'AFTER';
    const cmd = mementoCommand('Set thing', before, after, (s: string) => {
      applied.push(s);
    });

    expect(cmd.label).toBe('Set thing');

    cmd.undo();
    expect(applied).toEqual([before]);

    cmd.redo();
    expect(applied).toEqual([before, after]);
  });

  it('T11: apply receives the EXACT snapshot reference (helper does not clone)', () => {
    const received: unknown[] = [];
    const before = { ids: [1, 2, 3] };
    const after = { ids: [4, 5] };
    const cmd = mementoCommand('Snapshot', before, after, (s) => {
      received.push(s);
    });

    cmd.undo();
    cmd.redo();

    // Identity, not deep equality: the helper must not copy the snapshots.
    expect(received[0]).toBe(before);
    expect(received[1]).toBe(after);
  });
});
