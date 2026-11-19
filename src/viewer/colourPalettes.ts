/**
 * The colours "colour by parameter" (#68) paints with, as data.
 *
 * Every colour here is sRGB, as CSS writes it, so a legend swatch is the
 * colour as written. The renderer works in linear light: `toLinear` converts
 * before a colour reaches the model. To add a palette, add an entry to
 * `GRADIENTS`; the legend offers every entry.
 */

/** An sRGB colour, each channel 0..1. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** A colour scale from the lowest value (first stop) to the highest (last). */
export interface GradientPalette {
  id: string;
  /** As the legend's palette picker shows it. */
  label: string;
  /** Evenly spaced stops, low to high. */
  stops: readonly string[];
}

/**
 * Numeric scales. The first is the default: red for the lowest value to
 * green for the highest, as the owner asked for. Its middle stops are
 * darker than a print scale's: the viewer's lighting darkens faces, and a
 * pale yellow washes out against the light background.
 */
export const GRADIENTS: readonly GradientPalette[] = [
  {
    id: 'red-green',
    label: 'Red – yellow – green',
    stops: ['#d73027', '#f46d43', '#fdae61', '#e8d34a', '#a6d96a', '#66bd63', '#1a9850'],
  },
  {
    // Viridis: ordered by lightness, so it reads with any colour vision and
    // in greyscale.
    id: 'colour-blind-safe',
    label: 'Colour-blind safe',
    stops: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  },
];

export const DEFAULT_GRADIENT = GRADIENTS[0];

/**
 * Distinct values (text, yes/no, a few numbers in different units), in
 * order of use: Kelly's colours of maximum contrast, without white, black
 * and grey (the model and the "no value" state use those) and without the
 * deep blues, which a selected element is drawn in.
 */
export const CATEGORY_COLOURS: readonly string[] = [
  '#f38400', // orange
  '#be0032', // red
  '#008856', // green
  '#875692', // purple
  '#f3c300', // yellow
  '#a1caf1', // light blue
  '#e68fac', // pink
  '#8db600', // yellow-green
  '#882d17', // reddish brown
  '#c2b280', // buff
  '#b3446c', // purplish red
  '#f99379', // salmon
];

/**
 * The colour of the `i`-th distinct value: the hand-picked colours first,
 * then as many more as wanted, spread round the colour wheel by the golden
 * angle so each new hue lands far from the last ones, with lightness and
 * saturation alternating so neighbours in the list differ even where hues
 * come close. Hues near the selection blue are skipped.
 */
export function categoryColour(i: number): Rgb {
  if (i < CATEGORY_COLOURS.length) return hexToRgb(CATEGORY_COLOURS[i]);
  const n = i - CATEGORY_COLOURS.length;
  // The selection blue is about 217°: hues are spread over the 300° of the
  // wheel left once 195–255° is taken out.
  let hue = (20 + n * 137.508 * (300 / 360)) % 300;
  if (hue >= 195) hue += 60;
  // Every third value lighter, every third darker; a slow drift on top so
  // the hundredth value is not the twentieth again.
  const lightness = [0.5, 0.36, 0.64][n % 3] + ((Math.floor(n / 3) % 5) - 2) * 0.025;
  const saturation = [0.75, 0.55][n % 2];
  return hslToRgb(hue, saturation, lightness);
}

/** HSL (hue in degrees, saturation and lightness 0..1) → sRGB. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (m: number): number => (m + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (m: number): number => l - a * Math.max(-1, Math.min(k(m) - 3, 9 - k(m), 1));
  return { r: f(0), g: f(8), b: f(4) };
}

/** The values past the most common ones, sharing one colour: a light warm grey. */
export const OTHER_COLOUR = '#bdb5ab';

/**
 * Elements in the scope with no value: near white, like a card model, so
 * the coloured elements stand out and nothing reads as the model's own grey
 * concrete.
 *
 * Opaque on purpose. An opacity below 1 draws them as a see-through ghost,
 * which shows coloured elements behind them, but see-through parts are
 * drawn in sorted depth bands: on the Snowdon sample, orbit frame time went
 * from 5.9 to 7.6 ms on integrated graphics and draw calls from 5 to 81,
 * and on a model of a hundred chunks the draw calls could reach thousands.
 */
export const NO_VALUE_COLOUR = '#f2f2f2';
export const NO_VALUE_OPACITY = 1;

export function gradientById(id: string): GradientPalette {
  return GRADIENTS.find((g) => g.id === id) ?? DEFAULT_GRADIENT;
}

/** "#d73027" → {r, g, b} in 0..1. */
export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** {r, g, b} → "#d73027". */
export function rgbToHex(c: Rgb): string {
  const h = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** The colour at `t` (0 = lowest, 1 = highest) along a scale, interpolated in sRGB. */
export function sampleGradient(palette: GradientPalette, t: number): Rgb {
  const stops = palette.stops;
  if (stops.length === 1) return hexToRgb(stops[0]);
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  return { r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f };
}

function channelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB → linear RGB, which the renderer's colours are in. */
export function toLinear(c: Rgb): Rgb {
  return { r: channelToLinear(c.r), g: channelToLinear(c.g), b: channelToLinear(c.b) };
}

/** Steps in a gradient lookup table: finer than the eye separates on a face. */
export const GRADIENT_LUT_SIZE = 256;

/**
 * The scale as linear RGB at `GRADIENT_LUT_SIZE` evenly spaced points, so
 * colouring each element is a table lookup, not a conversion.
 */
export function gradientLut(palette: GradientPalette): Float32Array {
  const lut = new Float32Array(GRADIENT_LUT_SIZE * 3);
  for (let i = 0; i < GRADIENT_LUT_SIZE; i++) {
    const c = toLinear(sampleGradient(palette, i / (GRADIENT_LUT_SIZE - 1)));
    lut[i * 3] = c.r;
    lut[i * 3 + 1] = c.g;
    lut[i * 3 + 2] = c.b;
  }
  return lut;
}

/** CSS for a bar showing the whole scale, low on the left. */
export function gradientCss(palette: GradientPalette): string {
  return `linear-gradient(to right, ${palette.stops.join(', ')})`;
}
