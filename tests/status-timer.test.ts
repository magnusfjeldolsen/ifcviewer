import { describe, it, expect, vi } from 'vitest';
import { StatusTimer } from '../src/ui/statusTimer';

describe('transient status messages', () => {
  function setup() {
    const timers: Array<() => void> = [];
    const clear = vi.fn();
    const status = new StatusTimer(clear, (fn) => timers.push(fn));
    return { status, clear, timers };
  }

  it('clears a message after its time', () => {
    const { status, clear, timers } = setup();
    status.shown();
    status.clearAfter(4000);
    timers[0]();
    expect(clear).toHaveBeenCalledOnce();
  });

  it('never clears a newer message early, even one with the same text', () => {
    const { status, clear, timers } = setup();
    status.shown(); // "Showing only 40 elements"
    status.clearAfter(4000);
    status.shown(); // the same text again
    status.clearAfter(4000);
    timers[0]();
    expect(clear).not.toHaveBeenCalled();
    timers[1]();
    expect(clear).toHaveBeenCalledOnce();
  });
});
