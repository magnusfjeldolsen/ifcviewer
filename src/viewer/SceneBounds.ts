import * as THREE from 'three';
import type { ParsedMesh } from '../parser/types';

/**
 * The world-space extent of everything loaded, kept per model and grown batch
 * by batch as geometry arrives.
 *
 * It is fed from the parsed data rather than measured off the scene: the scene
 * graph is free to change how it draws a model (one mesh per piece, or merged
 * batches) without this having to follow, and measuring the scene meant
 * `Box3.expandByObject` over every mesh — a `computeBoundingBox` per geometry,
 * 600 ms of blocked main thread at the end of a 48 MB load.
 *
 * Visibility plays no part: a hidden element or a hidden model still counts,
 * so unhiding it can never reveal a view sized without it.
 */
export class SceneBounds {
  private models = new Map<string, THREE.Box3>();
  private union = new THREE.Box3();
  private unionStale = false;
  private listeners: Array<() => void> = [];

  /** Grow `modelId`'s bounds by a batch of its meshes. */
  addMeshes(modelId: string, meshes: readonly ParsedMesh[]): void {
    if (meshes.length === 0) return;
    let box = this.models.get(modelId);
    if (!box) {
      box = new THREE.Box3();
      this.models.set(modelId, box);
    }
    for (const mesh of meshes) expandByMesh(box, mesh);
    // A model only ever grows while it loads, so the union can grow in place.
    if (!this.unionStale) this.union.union(box);
    this.notify();
  }

  /** Forget a model. Safe to call for one that was never added. */
  removeModel(modelId: string): void {
    if (!this.models.delete(modelId)) return;
    this.unionStale = true;
    this.notify();
  }

  /** Everything still loaded, as a new box. Empty when nothing is. */
  box(): THREE.Box3 {
    if (this.unionStale) {
      this.union.makeEmpty();
      for (const box of this.models.values()) this.union.union(box);
      this.unionStale = false;
    }
    return this.union.clone();
  }

  /** Hear about every change. Returns an unsubscribe callback. */
  onChange(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }
}

const scratchBox = new THREE.Box3();
const scratchMatrix = new THREE.Matrix4();

/**
 * Expand `target` by one parsed mesh, in world space.
 *
 * Uses the mesh's local bounding box when the worker sent one, and only falls
 * back to walking its vertices when it did not (entries cached before the
 * worker started sending it). Transforming the eight corners of the local box
 * can overstate the extent of a rotated mesh slightly; it never understates
 * it, which is the direction that matters for clipping planes.
 */
export function expandByMesh(target: THREE.Box3, mesh: ParsedMesh): THREE.Box3 {
  const local = localBounds(mesh, scratchBox);
  if (local.isEmpty()) return target;
  local.applyMatrix4(scratchMatrix.fromArray(mesh.transform));
  return target.union(local);
}

function localBounds(mesh: ParsedMesh, out: THREE.Box3): THREE.Box3 {
  const b = mesh.bounds;
  if (b) {
    out.min.fromArray(b.min);
    out.max.fromArray(b.max);
    return out;
  }

  out.makeEmpty();
  const v = mesh.vertices;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (minX > maxX) return out;
  out.min.set(minX, minY, minZ);
  out.max.set(maxX, maxY, maxZ);
  return out;
}
