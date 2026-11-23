/**
 * How big a measurement label must be in the scene to look the same size on
 * screen at every distance (#57).
 *
 * A sprite sized in world units covers more pixels the closer the camera
 * gets, without limit — at arm's length the label filled the window. Sizing
 * it from the camera's own geometry instead keeps it at a fixed height in
 * CSS pixels: the world height that spans one pixel at depth `d` is
 * `2 * d * tan(fov / 2) / viewportHeight`, so a label `LABEL_HEIGHT_PX` tall
 * is that many of them.
 *
 * Everything is in CSS pixels, the unit of the canvas's `clientHeight`, so
 * the device pixel ratio cancels out: a label is the same physical size on a
 * 1x and a 2x screen. Pure arithmetic, so it can be checked without WebGL.
 */

/** Label height on screen, in CSS pixels. The text inside is about 60 % of it. */
export const LABEL_HEIGHT_PX = 24;

/** Depth is clamped so a label at or behind the camera plane cannot collapse to nothing or flip. */
const MIN_DEPTH = 1e-6;

/**
 * World-space height of a label that is `LABEL_HEIGHT_PX` tall on screen.
 *
 * @param depth            distance of the label along the camera's view axis, in metres
 * @param verticalFovDeg   the perspective camera's vertical field of view, in degrees
 * @param viewportHeightPx the canvas height in CSS pixels
 */
export function labelWorldHeight(
  depth: number,
  verticalFovDeg: number,
  viewportHeightPx: number,
): number {
  const worldPerPixel =
    (2 * Math.max(depth, MIN_DEPTH) * Math.tan((verticalFovDeg * Math.PI) / 360)) /
    Math.max(viewportHeightPx, 1);
  return worldPerPixel * LABEL_HEIGHT_PX;
}
