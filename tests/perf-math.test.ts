import { describe, it, expect } from 'vitest';
import {
  percentile,
  median,
  summarizeFrames,
  intervals,
  recentFps,
  orbitPositions,
  screenGrid,
  ndcFootprint,
} from '../src/debug/perfMath';

describe('percentile', () => {
  it('is NaN for no values, so a missing measurement is never "fast"', () => {
    expect(percentile([], 50)).toBeNaN();
  });

  it('interpolates between closest ranks like numpy', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48);
    expect(percentile([5], 95)).toBe(5);
  });

  it('does not depend on input order and does not mutate it', () => {
    const values = [3, 1, 2];
    expect(median(values)).toBe(2);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('summarizeFrames', () => {
  it('quotes fps from the median interval', () => {
    const s = summarizeFrames([16, 16, 17, 16, 16]);
    expect(s.frames).toBe(5);
    expect(s.medianFps).toBeCloseTo(62.5);
    expect(s.medianFrameMs).toBe(16);
  });

  it('lets one stall show in p95 and max but not in the median', () => {
    const run = Array.from({ length: 99 }, () => 10).concat([200]);
    const s = summarizeFrames(run);
    expect(s.medianFps).toBeCloseTo(100);
    expect(s.maxFrameMs).toBe(200);
    expect(s.meanFps).toBeLessThan(s.medianFps);
  });

  it('ignores non-positive and non-finite intervals', () => {
    const s = summarizeFrames([0, -1, NaN, Infinity, 20]);
    expect(s.frames).toBe(1);
    expect(s.medianFrameMs).toBe(20);
  });

  it('reports NaN, not zero, for an empty run', () => {
    const s = summarizeFrames([]);
    expect(s.frames).toBe(0);
    expect(s.medianFps).toBeNaN();
  });
});

describe('intervals', () => {
  it('is the gap between consecutive timestamps', () => {
    expect(intervals([0, 10, 25])).toEqual([10, 15]);
    expect(intervals([5])).toEqual([]);
  });
});

describe('recentFps', () => {
  it('counts frames drawn in the trailing window', () => {
    const ts = Array.from({ length: 61 }, (_, i) => 1000 + i * (1000 / 60));
    expect(recentFps(ts, ts[ts.length - 1])).toBeCloseTo(60, 0);
  });

  it('is null when the viewer has gone idle', () => {
    const ts = [0, 16, 32];
    expect(recentFps(ts, 2000)).toBeNull();
    expect(recentFps([], 0)).toBeNull();
  });
});

describe('orbitPositions', () => {
  const center = { x: 1, y: 2, z: 3 };
  const fit = { x: 11, y: 9, z: 13 };

  it('starts at the fit view', () => {
    const [first] = orbitPositions(center, fit, 8);
    expect(first.x).toBeCloseTo(11);
    expect(first.y).toBeCloseTo(9);
    expect(first.z).toBeCloseTo(13);
  });

  it('keeps distance and elevation all the way round', () => {
    const d0 = Math.hypot(10, 7, 10);
    for (const p of orbitPositions(center, fit, 12)) {
      expect(Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z)).toBeCloseTo(d0);
      expect(p.y).toBeCloseTo(9);
    }
  });

  it('goes halfway round at the halfway frame', () => {
    const p = orbitPositions(center, fit, 4)[2];
    expect(p.x).toBeCloseTo(-9);
    expect(p.z).toBeCloseTo(-7);
  });

  it('pulls the whole path in with distanceScale', () => {
    const [p] = orbitPositions(center, fit, 4, 0.5);
    expect(p).toEqual({ x: 6, y: 5.5, z: 8 });
  });
});

describe('screenGrid', () => {
  const full = { left: 0, top: 0, width: 1000, height: 500 };

  it('lays out cols × rows points inside the margin', () => {
    const pts = screenGrid(full, 5, 5, 0.1);
    expect(pts).toHaveLength(25);
    expect(pts[0]).toEqual({ x: 100, y: 50 });
    expect(pts[24]).toEqual({ x: 900, y: 450 });
    expect(pts[12]).toEqual({ x: 500, y: 250 });
  });

  it('stays inside an offset rectangle', () => {
    const pts = screenGrid({ left: 200, top: 100, width: 100, height: 50 }, 2, 2, 0);
    expect(pts).toEqual([
      { x: 200, y: 100 },
      { x: 300, y: 100 },
      { x: 200, y: 150 },
      { x: 300, y: 150 },
    ]);
  });

  it('centres a single point', () => {
    expect(screenGrid({ left: 0, top: 0, width: 200, height: 100 }, 1, 1)).toEqual([{ x: 100, y: 50 }]);
  });
});

describe('ndcFootprint', () => {
  it('maps NDC to screen pixels with y pointing down', () => {
    const r = ndcFootprint(
      [
        { x: -0.5, y: 0.5, z: 0 },
        { x: 0.5, y: -0.5, z: 0 },
      ],
      1000,
      500,
    );
    expect(r).toEqual({ left: 250, top: 125, width: 500, height: 250 });
  });

  it('clips to the canvas', () => {
    const r = ndcFootprint(
      [
        { x: -3, y: 2, z: 0.5 },
        { x: 0, y: 0, z: 0.5 },
      ],
      100,
      100,
    );
    expect(r).toEqual({ left: 0, top: 0, width: 50, height: 50 });
  });

  it('ignores points behind the camera, and is null when nothing is in front', () => {
    expect(ndcFootprint([{ x: 0, y: 0, z: 1.5 }], 100, 100)).toBeNull();
    const r = ndcFootprint(
      [
        { x: -0.5, y: -0.5, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0.9, y: 0.9, z: 1.2 },
      ],
      100,
      100,
    );
    expect(r).toEqual({ left: 25, top: 50, width: 25, height: 25 });
  });
});
