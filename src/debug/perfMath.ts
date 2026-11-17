/**
 * Pure helpers behind the `?stats` performance surface: frame-time
 * statistics, the scripted orbit path and the pick grid. Kept free of three.js
 * and the DOM so the numbers the benchmark reports are unit-tested.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The p-th percentile (0..100) of `values`, by linear interpolation between
 * closest ranks — the same definition numpy uses by default. NaN for an empty
 * list, so a missing measurement can never masquerade as a fast one.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

export interface FrameSummary {
  /** Number of frame intervals summarised. */
  frames: number;
  /** 1000 / median frame interval. */
  medianFps: number;
  /** Frames drawn divided by wall time — what a stopwatch would say. */
  meanFps: number;
  medianFrameMs: number;
  p95FrameMs: number;
  p99FrameMs: number;
  maxFrameMs: number;
}

/**
 * Summarise a run of frame intervals (ms between consecutive frames).
 *
 * Median fps is quoted from the median interval rather than averaged per
 * frame: averaging 1000/dt over-weights the fast frames, so one stall in a
 * run of 60 fps frames would barely move it.
 */
export function summarizeFrames(intervalsMs: readonly number[]): FrameSummary {
  const valid = intervalsMs.filter((dt) => Number.isFinite(dt) && dt > 0);
  if (valid.length === 0) {
    return {
      frames: 0,
      medianFps: NaN,
      meanFps: NaN,
      medianFrameMs: NaN,
      p95FrameMs: NaN,
      p99FrameMs: NaN,
      maxFrameMs: NaN,
    };
  }
  const total = valid.reduce((a, b) => a + b, 0);
  const med = median(valid);
  return {
    frames: valid.length,
    medianFps: 1000 / med,
    meanFps: (1000 * valid.length) / total,
    medianFrameMs: med,
    p95FrameMs: percentile(valid, 95),
    p99FrameMs: percentile(valid, 99),
    maxFrameMs: Math.max(...valid),
  };
}

/** Intervals between consecutive timestamps. */
export function intervals(timestamps: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < timestamps.length; i++) out.push(timestamps[i] - timestamps[i - 1]);
  return out;
}

/**
 * Frames per second over the trailing `windowMs`, from render timestamps.
 * Returns null when nothing was drawn recently: the app renders on demand,
 * so an idle viewer has no frame rate, and showing the last one would lie.
 */
export function recentFps(timestamps: readonly number[], now: number, windowMs = 1000): number | null {
  const last = timestamps[timestamps.length - 1];
  if (last === undefined || now - last > Math.min(windowMs, 500)) return null;
  const from = now - windowMs;
  const inWindow = timestamps.filter((t) => t > from);
  if (inWindow.length < 2) return null;
  const span = inWindow[inWindow.length - 1] - inWindow[0];
  return span > 0 ? ((inWindow.length - 1) * 1000) / span : null;
}

/**
 * Camera positions for a scripted 360° orbit about `center`.
 *
 * The orbit keeps the fit view's elevation and swings its horizontal offset
 * round the vertical (Y) axis, so frame 0 is exactly the fit view when
 * `distanceScale` is 1. `distanceScale` < 1 pulls the whole path in towards the
 * centre — the "zoomed in close" run.
 */
export function orbitPositions(
  center: Vec3,
  fitPosition: Vec3,
  frames: number,
  distanceScale = 1,
): Vec3[] {
  const ox = (fitPosition.x - center.x) * distanceScale;
  const oy = (fitPosition.y - center.y) * distanceScale;
  const oz = (fitPosition.z - center.z) * distanceScale;
  const out: Vec3[] = [];
  for (let i = 0; i < frames; i++) {
    const a = (2 * Math.PI * i) / frames;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    out.push({
      x: center.x + ox * cos + oz * sin,
      y: center.y + oy,
      z: center.z - ox * sin + oz * cos,
    });
  }
  return out;
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The screen rectangle covered by points given in normalised device
 * coordinates (-1..1, y up), clipped to a `width` × `height` canvas. Used to
 * aim the pick grid at the model rather than at the empty space around it:
 * a fit view leaves most of the screen empty, and a miss costs far less than
 * a hit, so a whole-screen grid would flatter the pick.
 * Null when none of it is on screen.
 */
export function ndcFootprint(
  ndcPoints: ReadonlyArray<{ x: number; y: number; z: number }>,
  width: number,
  height: number,
): ScreenRect | null {
  // Behind the camera, a projected point lands on the wrong side of the
  // screen; ignore those rather than letting them stretch the rectangle.
  const inFront = ndcPoints.filter((p) => p.z > -1 && p.z < 1);
  if (inFront.length === 0) return null;
  const clamp = (v: number) => Math.min(1, Math.max(-1, v));
  const xs = inFront.map((p) => clamp(p.x));
  const ys = inFront.map((p) => clamp(p.y));
  const left = ((Math.min(...xs) + 1) / 2) * width;
  const right = ((Math.max(...xs) + 1) / 2) * width;
  const top = ((1 - Math.max(...ys)) / 2) * height;
  const bottom = ((1 - Math.min(...ys)) / 2) * height;
  if (right - left <= 0 || bottom - top <= 0) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * A `cols` × `rows` grid of screen points over `rect`, inset from its edges by
 * `margin` (a fraction of width/height) so no sample sits on the very border.
 */
export function screenGrid(
  rect: ScreenRect,
  cols = 5,
  rows = 5,
  margin = 0.1,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const x0 = rect.left + rect.width * margin;
  const y0 = rect.top + rect.height * margin;
  const w = rect.width * (1 - 2 * margin);
  const h = rect.height * (1 - 2 * margin);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({
        x: x0 + (cols === 1 ? w / 2 : (w * c) / (cols - 1)),
        y: y0 + (rows === 1 ? h / 2 : (h * r) / (rows - 1)),
      });
    }
  }
  return out;
}
