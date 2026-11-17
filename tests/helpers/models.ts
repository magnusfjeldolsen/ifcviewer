/**
 * Test fixtures for anything that needs loaded models: real `ModelManager`s
 * built from small boxes, so tests exercise the same batching, picking and
 * per-element state the app does — no GL context required.
 */
import * as THREE from 'three';
import type { ParsedMesh, ParsedModel } from '../../src/parser/types';
import { ModelManager } from '../../src/viewer/ModelManager';

export interface BoxOptions {
  /** Centre of the box in world space (default: the origin). */
  at?: [number, number, number];
  /** Edge lengths (default 1×1×1). */
  size?: [number, number, number];
  /** Linear RGBA (default opaque grey). */
  color?: { r: number; g: number; b: number; a: number };
}

/**
 * One axis-aligned box as the IFC worker would deliver it: 24 vertices (four
 * per face, so each face has its own normal), 12 triangles, centred on the
 * local origin and placed by `transform`.
 */
export function boxMesh(expressID: number, options: BoxOptions = {}): ParsedMesh {
  const [sx, sy, sz] = options.size ?? [1, 1, 1];
  const [cx, cy, cz] = options.at ?? [0, 0, 0];
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  const vertices = new Float32Array(geometry.getAttribute('position').array);
  const normals = new Float32Array(geometry.getAttribute('normal').array);
  const indices = new Uint32Array(geometry.getIndex()!.array);
  geometry.dispose();
  const transform = new THREE.Matrix4().makeTranslation(cx, cy, cz).toArray();
  return {
    expressID,
    vertices,
    normals,
    indices,
    transform,
    color: options.color ?? { r: 0.5, g: 0.5, b: 0.5, a: 1 },
  };
}

/**
 * A model whose elements are unit boxes laid out along +X, 2 m apart, in the
 * order given — element `ids[i]` sits at x = 2·i. A repeated id gets a second
 * piece (an element made of two boxes).
 */
export function boxModel(id: string, ids: number[], options: Omit<BoxOptions, 'at'> = {}): ParsedModel {
  return { id, meshes: ids.map((expressId, i) => boxMesh(expressId, { ...options, at: [i * 2, 0, 0] })) };
}

/** A real ModelManager on its own scene, with the given models loaded. */
export function makeModelManager(models: ParsedModel[] = []): { modelManager: ModelManager; scene: THREE.Scene } {
  const scene = new THREE.Scene();
  const modelManager = new ModelManager(scene);
  for (const m of models) modelManager.addModel(m);
  return { modelManager, scene };
}

/** A camera at `position` looking at `target`, with its matrices up to date. */
export function cameraLookingAt(
  position: [number, number, number],
  target: [number, number, number],
): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(...position);
  camera.lookAt(...target);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}
