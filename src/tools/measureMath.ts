/**
 * Pure measurement maths and formatting.
 *
 * `MeasurementTool` needs WebGL and a 2D canvas context, so it has no unit
 * tests; anything here can be tested. Orthogonal mode (Step 3) will add plane
 * projection and world-normal helpers alongside `formatDistance`.
 *
 * The scene is in metres. web-ifc bakes each file's length factor into the
 * mesh placement matrix, so a millimetre model and a metre model already share
 * one world scale — there is nothing to convert here, only to display.
 */

/** Below this many metres a distance reads in millimetres instead. */
const MILLIMETRE_THRESHOLD_M = 1;

/**
 * Render a distance in metres for the measurement label.
 *
 * Sub-metre distances switch to whole millimetres. Under a flat
 * `toFixed(2)` a 3 mm gap rendered as `"0.00 m"` — a measurement that
 * confidently reports zero is worse than one that refuses to answer, and a
 * viewer used for clash-adjacent checks is asked about small gaps often.
 */
export function formatDistance(metres: number): string {
  const value = Math.abs(metres);
  if (value < MILLIMETRE_THRESHOLD_M) {
    const mm = Math.round(value * 1000);
    // 0.9996 m rounds to 1000 mm, which reads as a unit mistake. Anything that
    // rounds up to a whole metre belongs on the metre side of the switch.
    if (mm < MILLIMETRE_THRESHOLD_M * 1000) return `${mm} mm`;
  }
  return `${value.toFixed(2)} m`;
}
