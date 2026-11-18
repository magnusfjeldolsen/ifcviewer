// Pure comparison logic for `npm run compare` (bench/compare.mjs): no browser,
// no files, so tests/compare-logic.test.ts can exercise it directly.
//
// A "signature" is what one side's page reports for the model on screen:
//   { models: [{ modelId, pieces, elementCount, tris, verts, emptyPieces,
//                elements: { [expressID]: ElementSignature } }],
//     sceneBox: { min: [x,y,z], max: [x,y,z] } | null }
// and an ElementSignature is
//   { pieces, tris, verts, area, box: [minx,miny,minz,maxx,maxy,maxz] | nulls,
//     colors: 'r,g,b,a|r,g,b,a|…' (one entry per piece, sorted) }

/** Bounding boxes may differ by this much (scene units, metres) and still match. */
export const BOX_TOLERANCE = 1e-3;

/**
 * Chunks store positions as 32-bit offsets from a per-chunk anchor, so the same
 * element can come out about 1e-4 different between runs. An area that differs
 * by less than this relative amount is "rounding only", not a difference.
 */
export const AREA_ROUNDING = 1e-3;

/** The share of differing pixels (in percent) above which a screenshot pair counts as different. */
export const PIXEL_THRESHOLD_PCT = 0.5;

/** Relative difference of two areas: 0 when equal, 1 when one is zero and the other is not. */
export function relativeAreaDifference(a, b) {
  if (a === b) return 0;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

/** 'same' | 'rounding' | 'different' for two total surface areas. */
export function classifyArea(a, b, rounding = AREA_ROUNDING) {
  const rel = relativeAreaDifference(a, b);
  if (rel === 0) return 'same';
  return rel < rounding ? 'rounding' : 'different';
}

/** True when two boxes (or two missing boxes) agree within `tolerance` on every side. */
export function boxesMatch(a, b, tolerance = BOX_TOLERANCE) {
  if (!a || !b) return !a && !b;
  for (let i = 0; i < 6; i++) {
    const u = a[i];
    const v = b[i];
    if (u === null || v === null) {
      if (u !== v) return false;
    } else if (Math.abs(u - v) > tolerance) {
      return false;
    }
  }
  return true;
}

/** Scene boxes are `{ min, max }` or null. */
function sceneBoxesMatch(a, b) {
  if (!a || !b) return !a && !b;
  return boxesMatch([...a.min, ...a.max], [...b.min, ...b.max]);
}

/** What differs between one element on side A and the same element on side B. */
export function compareElement(e, f) {
  const hard = [];
  for (const k of ['pieces', 'tris', 'verts']) {
    if (e[k] !== f[k]) hard.push(`${k} ${e[k]} vs ${f[k]}`);
  }
  if (e.colors !== f.colors) hard.push(`colour/opacity ${e.colors} vs ${f.colors}`);
  if (!boxesMatch(e.box, f.box)) hard.push(`box ${JSON.stringify(e.box)} vs ${JSON.stringify(f.box)}`);
  const area = classifyArea(e.area, f.area);
  if (area === 'different') hard.push(`area ${e.area} vs ${f.area}`);
  return { hard, roundingOnly: area === 'rounding' && hard.length === 0, areaRounding: area === 'rounding' };
}

/**
 * Compare two signatures. Returns
 *   { summary, differences, roundingOnly, identical }
 * `differences` is a list of readable lines (everything but rounding); `identical`
 * is true when the list is empty. Rounding-only elements are counted and listed
 * separately and never make the comparison fail.
 */
export function compareSignatures(a, b) {
  const differences = [];
  const roundingOnly = [];
  const summary = { models: [a.models.length, b.models.length], perModel: [] };
  if (a.models.length !== b.models.length) {
    differences.push(`model count ${a.models.length} vs ${b.models.length}`);
  }
  for (let i = 0; i < Math.min(a.models.length, b.models.length); i++) {
    const x = a.models[i];
    const y = b.models[i];
    const counts = {};
    for (const k of ['pieces', 'elementCount', 'tris', 'verts', 'emptyPieces']) counts[k] = [x[k], y[k]];
    let identical = 0;
    let rounding = 0;
    let different = 0;
    const ids = new Set([...Object.keys(x.elements), ...Object.keys(y.elements)]);
    for (const id of [...ids].sort((p, q) => Number(p) - Number(q))) {
      const e = x.elements[id];
      const f = y.elements[id];
      if (!e || !f) {
        different++;
        differences.push(`#${id}: only in ${e ? 'A' : 'B'}`);
        continue;
      }
      const d = compareElement(e, f);
      if (d.hard.length > 0) {
        different++;
        differences.push(`#${id}: ${d.hard.join('; ')}`);
      } else if (d.roundingOnly) {
        rounding++;
        roundingOnly.push(`#${id}: area ${e.area} vs ${f.area}`);
      } else {
        identical++;
      }
    }
    summary.perModel.push({ counts, elementsIdentical: identical, elementsRoundingOnly: rounding, elementsDifferent: different });
  }
  summary.sceneBox = [a.sceneBox, b.sceneBox];
  if (!sceneBoxesMatch(a.sceneBox, b.sceneBox)) {
    differences.push(`scene box ${JSON.stringify(a.sceneBox)} vs ${JSON.stringify(b.sceneBox)}`);
  }
  return { summary, differences, roundingOnly, identical: differences.length === 0 };
}

/** 'same' or 'different' for the share of differing pixels in a screenshot pair. */
export function pixelVerdict(pct, threshold = PIXEL_THRESHOLD_PCT) {
  if (!Number.isFinite(pct)) return 'different';
  return pct > threshold ? 'different' : 'same';
}

/** The three fixed camera poses, from the scene box (y up): name, position, target. */
export function cameraPoses(box) {
  const c = box.min.map((v, i) => (v + box.max[i]) / 2);
  const d = Math.hypot(...box.max.map((v, i) => v - box.min[i]));
  return [
    { name: 'iso', position: [c[0] + d * 0.8, c[1] + d * 0.6, c[2] + d * 0.8], target: c },
    { name: 'top', position: [c[0] + 0.01, c[1] + d * 1.3, c[2] + d * 0.05], target: c },
    { name: 'close', position: [c[0] - d * 0.25, c[1] + d * 0.1, c[2] + d * 0.3], target: c },
  ];
}
