/**
 * The camera's vertical field of view, and the ease between orbit and flying
 * (#116). Orbit looks at a model from outside and wants the narrow view;
 * flying moves inside it, where the narrow view reads as looking down a tube.
 */

/** Vertical field of view in orbit, degrees. */
export const ORBIT_FOV_DEG = 45;

/**
 * Vertical field of view while flying, degrees. The one place to tune it;
 * a setting would replace this constant.
 */
export const FLY_FOV_DEG = 70;

/** How long the full change between the two takes, ms. */
export const FOV_EASE_MS = 250;

/** Slow at both ends, so neither the start nor the end of the change jolts. */
export function smoothstep(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
}

/**
 * How long a change from `from` to `to` takes: the full `FOV_EASE_MS` for the
 * whole orbit-to-flying swing, proportionally less for part of it (leaving
 * flying while it is still easing in only has the part already covered to
 * undo).
 */
export function fovEaseDuration(from: number, to: number): number {
  const full = Math.abs(FLY_FOV_DEG - ORBIT_FOV_DEG);
  if (full === 0) return 0;
  return FOV_EASE_MS * Math.min(Math.abs(to - from) / full, 1);
}

/** One field-of-view change in progress. Clock-agnostic: the caller passes `now`. */
export class FovEase {
  private from = 0;
  private to = 0;
  private startedAt = 0;
  private duration = 0;
  private active = false;

  /** Begin easing from `from` to `to`. A change of nothing is not started. */
  start(from: number, to: number, now: number): void {
    this.from = from;
    this.to = to;
    this.startedAt = now;
    this.duration = fovEaseDuration(from, to);
    this.active = from !== to && this.duration > 0;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Where the ease is heading, or null when none is running. */
  target(): number | null {
    return this.active ? this.to : null;
  }

  /**
   * The field of view at `now`. On the last step it is exactly the target,
   * never a float a hair off it, and the ease is over.
   */
  sample(now: number): number {
    if (!this.active) return this.to;
    const t = (now - this.startedAt) / this.duration;
    if (t >= 1) {
      this.active = false;
      return this.to;
    }
    return this.from + (this.to - this.from) * smoothstep(t);
  }

  cancel(): void {
    this.active = false;
  }
}
