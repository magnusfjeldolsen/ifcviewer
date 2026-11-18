import { describe, it, expect, vi, afterEach } from 'vitest';
import { LoadTimeline, WorkerTimeline, wallNow } from '../../src/core/LoadTimeline';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LoadTimeline', () => {
  it('keeps marks as ms since the timeline started', () => {
    const t = new LoadTimeline(100);
    t.mark('a', 150);
    t.mark('b', 400);
    expect(t.toJSON()).toEqual({ startedAt: 100, marks: { a: 50, b: 300 }, spans: {} });
  });

  it('keeps the first write of a mark, so "first batch" stays the first one', () => {
    const t = new LoadTimeline(0);
    t.mark('main.firstBatch', 10);
    t.mark('main.firstBatch', 20);
    expect(t.toJSON().marks['main.firstBatch']).toBe(10);
  });

  it('sums every call of a span', () => {
    const t = new LoadTimeline(0);
    t.add('main.append', 3);
    t.add('main.append', 4);
    expect(t.toJSON().spans['main.append']).toBe(7);
  });

  it('times a function into a span and passes its result through', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(10).mockReturnValueOnce(25);
    const t = new LoadTimeline(0);
    expect(t.time('work', () => 42)).toBe(42);
    expect(t.toJSON().spans.work).toBe(15);
  });

  it('still records the span when the timed function throws', () => {
    const t = new LoadTimeline(0);
    expect(() => t.time('boom', () => { throw new Error('x'); })).toThrow('x');
    expect(t.toJSON().spans.boom).toBeGreaterThanOrEqual(0);
  });

  it('moves worker wall-clock marks onto the page clock and takes worker spans as they are', () => {
    const t = new LoadTimeline(1000);
    t.absorbWorker({
      marks: { 'worker.opened': performance.timeOrigin + 1500 },
      spans: { 'worker.open': 480 },
    });
    const out = t.toJSON();
    expect(out.marks['worker.opened']).toBeCloseTo(500, 6);
    expect(out.spans['worker.open']).toBe(480);
  });

  it('ignores a missing worker report', () => {
    const t = new LoadTimeline(0);
    t.absorbWorker(undefined);
    expect(t.toJSON()).toEqual({ startedAt: 0, marks: {}, spans: {} });
  });

  it('hands out copies, so a published report does not change under the reader', () => {
    const t = new LoadTimeline(0);
    t.add('x', 1);
    const first = t.toJSON();
    t.add('x', 1);
    expect(first.spans.x).toBe(1);
  });
});

describe('WorkerTimeline', () => {
  it('stamps marks in wall-clock time and keeps the first write', () => {
    const w = new WorkerTimeline();
    const before = wallNow();
    w.mark('worker.received');
    const after = wallNow();
    const stamped = w.toJSON().marks['worker.received'];
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
    w.mark('worker.received');
    expect(w.toJSON().marks['worker.received']).toBe(stamped);
  });

  it('sums spans', () => {
    const w = new WorkerTimeline();
    w.add('worker.weld', 2);
    w.add('worker.weld', 3);
    expect(w.toJSON().spans['worker.weld']).toBe(5);
  });
});
