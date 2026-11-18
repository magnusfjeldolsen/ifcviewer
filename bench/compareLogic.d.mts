export const BOX_TOLERANCE: number;
export const AREA_ROUNDING: number;
export const PIXEL_THRESHOLD_PCT: number;
export interface ElementSignature {
  pieces: number;
  tris: number;
  verts: number;
  area: number;
  box: Array<number | null>;
  colors: string;
}
export interface ModelSignature {
  modelId?: number;
  pieces: number;
  elementCount: number;
  tris: number;
  verts: number;
  emptyPieces: number;
  elements: Record<string, ElementSignature>;
}
export interface SceneBox {
  min: number[];
  max: number[];
}
export interface Signature {
  models: ModelSignature[];
  sceneBox: SceneBox | null;
}
export function relativeAreaDifference(a: number, b: number): number;
export function classifyArea(a: number, b: number, rounding?: number): 'same' | 'rounding' | 'different';
export function boxesMatch(a: Array<number | null> | null, b: Array<number | null> | null, tolerance?: number): boolean;
export function compareElement(
  e: ElementSignature,
  f: ElementSignature,
): { hard: string[]; roundingOnly: boolean; areaRounding: boolean };
export function compareSignatures(
  a: Signature,
  b: Signature,
): {
  summary: {
    models: [number, number];
    perModel: Array<{
      counts: Record<string, [number, number]>;
      elementsIdentical: number;
      elementsRoundingOnly: number;
      elementsDifferent: number;
    }>;
    sceneBox: [SceneBox | null, SceneBox | null];
  };
  differences: string[];
  roundingOnly: string[];
  identical: boolean;
};
export function pixelVerdict(pct: number, threshold?: number): 'same' | 'different';
export function cameraPoses(box: SceneBox): Array<{ name: string; position: number[]; target: number[] }>;
