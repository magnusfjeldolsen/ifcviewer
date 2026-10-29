/**
 * The arithmetic behind the position marker: from a point in the scene to the
 * three numbers someone setting out on site would read off a drawing.
 *
 * Two conversions stand between them, and both are easy to get silently wrong:
 *
 * 1. **Axes.** IFC is Z-up. Three.js is Y-up, and web-ifc rotates every
 *    placement on the way out so the model stands upright in the scene:
 *    IFC (x, y, z) arrives as scene (x, z, −y). Reading the scene's Y as the
 *    model's Y would report every height as a northing.
 * 2. **Units.** web-ifc also scales every length to metres, whatever the file
 *    was authored in, so the scene is always in metres. The model's own
 *    length unit — millimetres, usually, for Norwegian building models — is
 *    what the numbers should be shown in.
 *
 * Pure, so the whole path from scene point to display text is testable.
 */

export interface Xyz {
  x: number;
  y: number;
  z: number;
}

/** A scene-space point (Y-up, metres) as model coordinates (Z-up, metres). */
export function sceneToModel(scene: Xyz): Xyz {
  // `0 - v` rather than `-v`, so a point on the axis reads 0 and not −0.
  return { x: scene.x, y: 0 - scene.z, z: scene.y };
}

/**
 * How many of `symbol` make a metre, or null for a unit this does not know.
 *
 * Only the SI lengths: a conversion-based unit such as a foot carries its own
 * factor in the IFC file, and guessing it from the label would be worse than
 * showing metres.
 */
export function unitsPerMetre(symbol: string): number | null {
  switch (symbol) {
    case 'm':
      return 1;
    case 'dm':
      return 10;
    case 'cm':
      return 100;
    case 'mm':
      return 1000;
    case 'km':
      return 0.001;
    default:
      return null;
  }
}

/**
 * Decimals worth showing in each unit: a tenth of a millimetre would be noise
 * on a building model, and a whole metre would be useless.
 */
const DECIMALS: Record<string, number> = { m: 3, dm: 2, cm: 1, mm: 0, km: 6 };

export interface CoordinateLine {
  axis: 'X' | 'Y' | 'Z';
  /** The number and its unit, e.g. `"12345 mm"`. */
  text: string;
  /** The bare number, for copying into another program. */
  value: string;
}

/**
 * Model coordinates in metres as three display lines in `unitSymbol`.
 *
 * Falls back to metres for a unit `unitsPerMetre` does not know, so the
 * numbers are never wrong — only, at worst, in a different unit than the
 * model's.
 */
export function formatCoordinates(modelMetres: Xyz, unitSymbol: string): CoordinateLine[] {
  const factor = unitsPerMetre(unitSymbol);
  const unit = factor === null ? 'm' : unitSymbol;
  const scale = factor ?? 1;
  const decimals = DECIMALS[unit] ?? 3;

  return (['x', 'y', 'z'] as const).map((key) => {
    const value = formatNumber(modelMetres[key] * scale, decimals);
    return { axis: key.toUpperCase() as CoordinateLine['axis'], text: `${value} ${unit}`, value };
  });
}

/** Plain-text block for the clipboard: one `X = … unit` line per axis. */
export function coordinatesAsText(lines: readonly CoordinateLine[]): string {
  return lines.map((line) => `${line.axis} = ${line.text}`).join('\n');
}

function formatNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  // toFixed keeps the sign of a value that rounds to zero ("-0.000").
  return Number(fixed) === 0 ? (0).toFixed(decimals) : fixed;
}
