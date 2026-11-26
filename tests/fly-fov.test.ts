import { describe, it, expect } from 'vitest';
import {
  FovEase,
  FLY_FOV_DEG,
  FOV_EASE_MS,
  ORBIT_FOV_DEG,
  fovEaseDuration,
  smoothstep,
} from '../src/viewer/flyFov';

describe('fly field of view — constants', () => {
  it('flies wider than it orbits', () => {
    expect(ORBIT_FOV_DEG).toBe(45);
    expect(FLY_FOV_DEG).toBeGreaterThan(ORBIT_FOV_DEG);
    expect(FLY_FOV_DEG).toBeLessThan(90);
  });
});

describe('smoothstep', () => {
  it('starts at 0, ends at 1 and clamps outside', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5);
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
  });
});

describe('fovEaseDuration', () => {
  it('takes the full time for the whole swing, in either direction', () => {
    expect(fovEaseDuration(ORBIT_FOV_DEG, FLY_FOV_DEG)).toBe(FOV_EASE_MS);
    expect(fovEaseDuration(FLY_FOV_DEG, ORBIT_FOV_DEG)).toBe(FOV_EASE_MS);
  });

  it('takes proportionally less for part of it', () => {
    const mid = (ORBIT_FOV_DEG + FLY_FOV_DEG) / 2;
    expect(fovEaseDuration(mid, ORBIT_FOV_DEG)).toBeCloseTo(FOV_EASE_MS / 2);
    expect(fovEaseDuration(ORBIT_FOV_DEG, ORBIT_FOV_DEG)).toBe(0);
  });
});

describe('FovEase', () => {
  it('moves monotonically and lands exactly on the target', () => {
    const ease = new FovEase();
    ease.start(ORBIT_FOV_DEG, FLY_FOV_DEG, 1000);
    expect(ease.isActive()).toBe(true);
    expect(ease.target()).toBe(FLY_FOV_DEG);
    let last = ORBIT_FOV_DEG;
    for (let t = 1000; t < 1000 + FOV_EASE_MS; t += 16) {
      const fov = ease.sample(t);
      expect(fov).toBeGreaterThanOrEqual(last);
      expect(fov).toBeLessThan(FLY_FOV_DEG);
      last = fov;
    }
    expect(ease.sample(1000 + FOV_EASE_MS)).toBe(FLY_FOV_DEG);
    expect(ease.isActive()).toBe(false);
    expect(ease.target()).toBeNull();
  });

  it('is half-way at half time', () => {
    const ease = new FovEase();
    ease.start(ORBIT_FOV_DEG, FLY_FOV_DEG, 0);
    expect(ease.sample(FOV_EASE_MS / 2)).toBeCloseTo((ORBIT_FOV_DEG + FLY_FOV_DEG) / 2);
  });

  it('does not start a change of nothing', () => {
    const ease = new FovEase();
    ease.start(ORBIT_FOV_DEG, ORBIT_FOV_DEG, 0);
    expect(ease.isActive()).toBe(false);
  });

  it('a late frame jumps straight to the target', () => {
    const ease = new FovEase();
    ease.start(FLY_FOV_DEG, ORBIT_FOV_DEG, 0);
    expect(ease.sample(10_000)).toBe(ORBIT_FOV_DEG);
    expect(ease.isActive()).toBe(false);
  });

  it('cancel stops it', () => {
    const ease = new FovEase();
    ease.start(ORBIT_FOV_DEG, FLY_FOV_DEG, 0);
    ease.cancel();
    expect(ease.isActive()).toBe(false);
  });
});
