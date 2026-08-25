import * as THREE from 'three';
import { raycastVisible } from '../utils/raycast';
import type { Candidate, ScreenPoint } from './candidateMath';

/**
 * The element provider for the candidate system.
 *
 * A thin wrapper around today's `raycastVisible` — deliberately so. Element
 * selection is the behaviour with the most tests and the most to lose, and the
 * only safe way to fold it into a new arbitration scheme is to leave the pick
 * itself byte-for-byte unchanged and add ranking around it.
 *
 * Highest priority (1): the model is the content, the measurement drawn over
 * it is annotation. `Tab` is the escape hatch when the user means the
 * annotation.
 */

export const ELEMENT_PRIORITY = 1;

export interface ElementCandidateDeps {
  camera: THREE.Camera;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
}

/** Read a candidate's raycast intersection, or null if it isn't an element. */
export function elementHit(candidate: Candidate): THREE.Intersection | null {
  if (candidate.kind !== 'element') return null;
  return (candidate.payload as THREE.Intersection | undefined) ?? null;
}

/**
 * Whatever `raycastVisible` finds at `cursor`, as at most one candidate.
 *
 * Distance is 0 because a raycast hit is *under* the cursor, not near it —
 * which is also what makes an element beat a measurement 5 px away without
 * needing a special case in the ranking.
 */
export function elementCandidatesAt(deps: ElementCandidateDeps, cursor: ScreenPoint): Candidate[] {
  const width = deps.canvas.clientWidth;
  const height = deps.canvas.clientHeight;
  if (width <= 0 || height <= 0) return [];

  const ndc = new THREE.Vector2((cursor.x / width) * 2 - 1, -(cursor.y / height) * 2 + 1);
  const hit = raycastVisible(ndc, deps.camera, deps.scene, deps.renderer);
  if (!hit) return [];

  return [
    {
      kind: 'element',
      priority: ELEMENT_PRIORITY,
      distance: 0,
      depth: hit.distance,
      id: `element:${hit.object.uuid}`,
      payload: hit,
    },
  ];
}
