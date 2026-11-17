/**
 * `SceneBounds` — the extent of everything loaded, which sizes the clipping
 * planes.
 *
 * It replaced measuring the scene with `Box3.expandByObject` when a load
 * settled. That cost a `computeBoundingBox` per geometry — 600 ms of blocked
 * main thread at the end of the 48 MB SBM_RIE load — and, because it only ran
 * at the end, a streamed model's planes covered just its first batch until
 * then: the last batch of SBM_RIE landed 179 m beyond the far plane and stayed
 * cut until the load settled.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { SceneBounds, expandByMesh } from '../src/viewer/SceneBounds';
import type { ParsedMesh } from '../src/parser/types';

const IDENTITY = new THREE.Matrix4().toArray();

/** A mesh whose vertices span `min`..`max` in local space. */
function meshSpanning(
  min: [number, number, number],
  max: [number, number, number],
  options: { transform?: number[]; withBounds?: boolean } = {},
): ParsedMesh {
  const mesh: ParsedMesh = {
    expressID: 1,
    vertices: new Float32Array([...min, ...max, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    transform: options.transform ?? IDENTITY,
    color: { r: 1, g: 1, b: 1, a: 1 },
  };
  if (options.withBounds ?? true) mesh.bounds = { min, max };
  return mesh;
}

function expectBox(box: THREE.Box3, min: number[], max: number[]): void {
  expect(box.min.toArray().map((v) => +v.toFixed(6))).toEqual(min);
  expect(box.max.toArray().map((v) => +v.toFixed(6))).toEqual(max);
}

describe('expandByMesh', () => {
  it('places the local bounds in the world with the mesh transform', () => {
    const translate = new THREE.Matrix4().makeTranslation(100, 0, -50).toArray();
    const box = expandByMesh(new THREE.Box3(), meshSpanning([0, 0, 0], [1, 2, 3], { transform: translate }));
    expectBox(box, [100, 0, -50], [101, 2, -47]);
  });

  it('never understates a rotated mesh', () => {
    // 90° about Y sends local +X to world -Z.
    const rotate = new THREE.Matrix4().makeRotationY(Math.PI / 2).toArray();
    const box = expandByMesh(new THREE.Box3(), meshSpanning([0, 0, 0], [4, 1, 1], { transform: rotate }));
    expectBox(box, [0, 0, -4], [1, 1, 0]);
  });

  it('falls back to the vertices for meshes cached before bounds existed', () => {
    const translate = new THREE.Matrix4().makeTranslation(10, 0, 0).toArray();
    const box = expandByMesh(
      new THREE.Box3(),
      meshSpanning([-1, -2, -3], [1, 2, 3], { transform: translate, withBounds: false }),
    );
    expectBox(box, [9, -2, -3], [11, 2, 3]);
  });

  it('trusts the worker bounds rather than walking the vertices', () => {
    const mesh = meshSpanning([0, 0, 0], [1, 1, 1]);
    mesh.bounds = { min: [-5, -5, -5], max: [5, 5, 5] };
    expectBox(expandByMesh(new THREE.Box3(), mesh), [-5, -5, -5], [5, 5, 5]);
  });

  it('ignores a mesh with no vertices', () => {
    const empty: ParsedMesh = { ...meshSpanning([0, 0, 0], [1, 1, 1], { withBounds: false }), vertices: new Float32Array(0) };
    expect(expandByMesh(new THREE.Box3(), empty).isEmpty()).toBe(true);
  });
});

describe('SceneBounds', () => {
  it('grows with every batch of a streamed load, not just the first', () => {
    const bounds = new SceneBounds();
    bounds.addMeshes('m', [meshSpanning([0, 0, 0], [10, 10, 10])]);
    expectBox(bounds.box(), [0, 0, 0], [10, 10, 10]);
    // The last SBM_RIE batch: geometry far outside what the first one showed.
    bounds.addMeshes('m', [meshSpanning([180, 0, 0], [190, 5, 5])]);
    expectBox(bounds.box(), [0, 0, 0], [190, 10, 10]);
  });

  it('covers every model, and drops one when it is removed', () => {
    const bounds = new SceneBounds();
    bounds.addMeshes('a', [meshSpanning([0, 0, 0], [1, 1, 1])]);
    bounds.addMeshes('b', [meshSpanning([50, 0, 0], [60, 1, 1])]);
    expectBox(bounds.box(), [0, 0, 0], [60, 1, 1]);

    bounds.removeModel('b');
    expectBox(bounds.box(), [0, 0, 0], [1, 1, 1]);
    bounds.removeModel('a');
    expect(bounds.box().isEmpty()).toBe(true);
  });

  it('starts a re-added model from scratch', () => {
    // resetView removes every model and streams it back in under the same id.
    const bounds = new SceneBounds();
    bounds.addMeshes('m', [meshSpanning([0, 0, 0], [100, 1, 1])]);
    bounds.removeModel('m');
    bounds.addMeshes('m', [meshSpanning([0, 0, 0], [1, 1, 1])]);
    expectBox(bounds.box(), [0, 0, 0], [1, 1, 1]);
  });

  it('hands out a copy, so a caller cannot disturb it', () => {
    const bounds = new SceneBounds();
    bounds.addMeshes('m', [meshSpanning([0, 0, 0], [1, 1, 1])]);
    bounds.box().expandByScalar(1000);
    expectBox(bounds.box(), [0, 0, 0], [1, 1, 1]);
  });

  it('tells listeners about additions and removals, and stays quiet otherwise', () => {
    const bounds = new SceneBounds();
    const cb = vi.fn();
    bounds.onChange(cb);
    bounds.addMeshes('m', [meshSpanning([0, 0, 0], [1, 1, 1])]);
    bounds.addMeshes('m', []);
    bounds.removeModel('never-added');
    bounds.removeModel('m');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('measures a 4,000-mesh batch without walking a single vertex', () => {
    // The worker sends local bounds; the main thread only transforms corners.
    const meshes = Array.from({ length: 4000 }, (_, i) => {
      const m = meshSpanning([i, 0, 0], [i + 1, 1, 1]);
      // Vertices that disagree with the bounds: if they were read, the box
      // would reach y = 1e6.
      m.vertices = new Float32Array([0, 1e6, 0]);
      return m;
    });
    const bounds = new SceneBounds();
    bounds.addMeshes('m', meshes);
    expectBox(bounds.box(), [0, 0, 0], [4000, 1, 1]);
  });
});
