import { describe, it, expect } from 'vitest';
import { easeOutCubic } from '../src/viewer/CameraAnimator';

describe('CameraAnimator', () => {
  describe('easeOutCubic', () => {
    it('should return 0 at t=0', () => {
      expect(easeOutCubic(0)).toBe(0);
    });

    it('should return 1 at t=1', () => {
      expect(easeOutCubic(1)).toBe(1);
    });

    it('should be monotonically increasing', () => {
      let prev = 0;
      for (let t = 0.1; t <= 1; t += 0.1) {
        const val = easeOutCubic(t);
        expect(val).toBeGreaterThan(prev);
        prev = val;
      }
    });

    it('should decelerate (second half changes less than first half)', () => {
      const firstHalf = easeOutCubic(0.5) - easeOutCubic(0);
      const secondHalf = easeOutCubic(1) - easeOutCubic(0.5);
      expect(firstHalf).toBeGreaterThan(secondHalf);
    });

    it('should return 0.5 at midpoint (approx 0.875)', () => {
      // ease-out cubic at t=0.5: 1 - (0.5)^3 = 0.875
      expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
    });
  });
});
