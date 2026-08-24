/**
 * `PivotState` — the contract the contextual-action tray consumes to decide
 * whether to offer "Remove pivot", mirroring the `hasClipPlane()` /
 * `onStateChange()` pair covered in clipping-tool.test.ts.
 *
 * These are the tray's contract, not an exhaustive spec: a missed
 * notification leaves a button that lies about the state, and a spurious one
 * makes the tray churn.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { PivotState } from '../src/viewer/PivotState';

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

describe('PivotState', () => {
  let pivot: PivotState;

  beforeEach(() => {
    pivot = new PivotState();
  });

  it('starts with no pivot', () => {
    expect(pivot.has()).toBe(false);
    expect(pivot.get()).toBeNull();
  });

  it('holds the pivot that was placed', () => {
    pivot.place(v(1, 2, 3));
    expect(pivot.has()).toBe(true);
    expect(pivot.get()!.equals(v(1, 2, 3))).toBe(true);
  });

  it('stores a copy, so the caller cannot move the pivot afterwards', () => {
    // placePivot passes the raycast hit point straight through, and three
    // reuses intersection vectors.
    const hit = v(1, 2, 3);
    pivot.place(hit);
    hit.set(9, 9, 9);
    expect(pivot.get()!.equals(v(1, 2, 3))).toBe(true);
  });

  it('clears back to empty', () => {
    pivot.place(v(1, 2, 3));
    expect(pivot.clear()).toBe(true);
    expect(pivot.has()).toBe(false);
    expect(pivot.get()).toBeNull();
  });

  it('reports that there was nothing to clear', () => {
    expect(pivot.clear()).toBe(false);
  });

  it('notifies on place and on clear', () => {
    const cb = vi.fn();
    pivot.onChange(cb);

    pivot.place(v(1, 2, 3));
    expect(cb).toHaveBeenCalledTimes(1);

    pivot.clear();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('does not notify when clear finds nothing to clear', () => {
    // resetView clears the pivot unconditionally; waking the tray for a
    // no-op is how it starts flickering.
    const cb = vi.fn();
    pivot.onChange(cb);
    pivot.clear();
    expect(cb).not.toHaveBeenCalled();
  });

  it('notifies when a pivot replaces an existing one', () => {
    // The marker moved even though has() did not change.
    const cb = vi.fn();
    pivot.place(v(1, 2, 3));
    pivot.onChange(cb);
    pivot.place(v(4, 5, 6));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(pivot.get()!.equals(v(4, 5, 6))).toBe(true);
  });

  it('reflects the new state by the time listeners run', () => {
    // The tray re-reads has() inside its refresh, so notifying before the
    // state settled would render the previous state.
    const seen: boolean[] = [];
    pivot.onChange(() => seen.push(pivot.has()));
    pivot.place(v(1, 2, 3));
    pivot.clear();
    expect(seen).toEqual([true, false]);
  });

  it('stops notifying after unsubscribe', () => {
    const cb = vi.fn();
    const off = pivot.onChange(cb);
    off();
    pivot.place(v(1, 2, 3));
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribes one listener without disturbing the others', () => {
    const kept = vi.fn();
    const dropped = vi.fn();
    pivot.onChange(kept);
    const off = pivot.onChange(dropped);
    off();
    pivot.place(v(1, 2, 3));
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('survives a listener that unsubscribes itself mid-notify', () => {
    const other = vi.fn();
    const off = pivot.onChange(() => off());
    pivot.onChange(other);
    expect(() => pivot.place(v(1, 2, 3))).not.toThrow();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('drops every listener on dispose', () => {
    const cb = vi.fn();
    pivot.onChange(cb);
    pivot.dispose();
    pivot.place(v(1, 2, 3));
    expect(cb).not.toHaveBeenCalled();
  });
});
