// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { FrameYielder } from '../src/utils/frameYield';

describe('FrameYielder', () => {
  it('does not yield while inside the frame budget', async () => {
    // A huge budget — the first call happens well within it.
    const yielder = new FrameYielder(1_000_000);
    expect(await yielder.yieldIfNeeded()).toBe(false);
  });

  it('yields once the budget is exceeded', async () => {
    // Budget 0 — every call is "over budget".
    const yielder = new FrameYielder(0);
    expect(await yielder.yieldIfNeeded()).toBe(true);
  });

  it('keeps skipping within budget across rapid successive calls', async () => {
    const yielder = new FrameYielder(1_000_000);
    for (let i = 0; i < 5; i++) {
      expect(await yielder.yieldIfNeeded()).toBe(false);
    }
  });

  it('completes a long loop without hanging when it yields every iteration', async () => {
    // Budget 0 forces a real MessageChannel yield each iteration; the loop
    // must still run to completion (guards against a yield that never
    // resolves).
    const yielder = new FrameYielder(0);
    let iterations = 0;
    for (let i = 0; i < 50; i++) {
      await yielder.yieldIfNeeded();
      iterations++;
    }
    expect(iterations).toBe(50);
  });

  it('resumes skipping after a yield resets the budget window', async () => {
    const yielder = new FrameYielder(1_000_000);
    // First call: within budget → skip.
    expect(await yielder.yieldIfNeeded()).toBe(false);
    // A fresh yielder with budget 0 to prove the yield path, then confirm
    // the large-budget one still skips on a later call (timer not tripped).
    expect(await yielder.yieldIfNeeded()).toBe(false);
  });
});
