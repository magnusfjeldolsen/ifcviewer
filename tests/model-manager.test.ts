import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { ModelManager } from '../src/viewer/ModelManager';
import { ANCHOR_REACH, HIGHLIGHT_COLOR, SEE_THROUGH_SETTLE_MS, ChunkMesh, ModelBatch, elementOfHit, modelIdOfObject, pieceGeometryOfHit } from '../src/viewer/ModelBatch';
import { boxMesh, boxModel, cameraLookingAt, makeModelManager } from './helpers/models';

/** Every chunk mesh of every model in the scene. */
function chunkMeshes(scene: THREE.Scene): ChunkMesh[] {
  const out: ChunkMesh[] = [];
  scene.traverse((o) => {
    if (o instanceof ChunkMesh) out.push(o);
  });
  return out;
}

/** Raycast the scene the way `raycastVisible` does and return the nearest hit. */
function pick(scene: THREE.Scene, origin: THREE.Vector3, direction: THREE.Vector3): THREE.Intersection | null {
  scene.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster(origin, direction.clone().normalize());
  const hits = raycaster.intersectObjects(scene.children, true);
  return hits[0] ?? null;
}

describe('ModelManager — models', () => {
  it('adds a model to the scene and registers it', () => {
    const { modelManager, scene } = makeModelManager([boxModel('m1', [1, 2])]);
    const entry = modelManager.getModel('m1')!;
    expect(entry.group.parent).toBe(scene);
    expect(entry.group.name).toBe('m1');
    expect(modelManager.getModelIds()).toEqual(['m1']);
    expect(modelManager.pieceCount()).toBe(2);
    expect(modelManager.elementIds('m1').sort()).toEqual([1, 2]);
  });

  it('removes a model from the scene', () => {
    const { modelManager, scene } = makeModelManager([boxModel('m1', [1])]);
    expect(modelManager.removeModel('m1')).toBe(true);
    expect(scene.children).toHaveLength(0);
    expect(modelManager.getModel('m1')).toBeUndefined();
    expect(modelManager.pieceCount()).toBe(0);
  });

  it('returns false when removing a model that does not exist', () => {
    const { modelManager } = makeModelManager();
    expect(modelManager.removeModel('nope')).toBe(false);
  });

  it('toggles model visibility', () => {
    const { modelManager } = makeModelManager([boxModel('m1', [1])]);
    modelManager.setVisible('m1', false);
    expect(modelManager.getModel('m1')!.group.visible).toBe(false);
    expect(modelManager.getModel('m1')!.visible).toBe(false);
    modelManager.setVisible('m1', true);
    expect(modelManager.getModel('m1')!.group.visible).toBe(true);
    expect(modelManager.setVisible('nope', true)).toBe(false);
  });

  it('keeps models independent', () => {
    const { modelManager } = makeModelManager([boxModel('a', [1]), boxModel('b', [1, 2])]);
    modelManager.setHidden('a', [1], true);
    expect(modelManager.getElementState('a', 1)!.hidden).toBe(true);
    expect(modelManager.getElementState('b', 1)!.hidden).toBe(false);
    modelManager.removeModel('a');
    expect(modelManager.getModelIds()).toEqual(['b']);
  });

  it('replaces a model added again with the same id', () => {
    const { modelManager, scene } = makeModelManager([boxModel('m1', [1])]);
    modelManager.addModel(boxModel('m1', [5, 6, 7]));
    expect(scene.children).toHaveLength(1);
    expect(modelManager.elementIds('m1').sort()).toEqual([5, 6, 7]);
  });

  it('clears all models', () => {
    const { modelManager, scene } = makeModelManager([boxModel('a', [1]), boxModel('b', [2])]);
    modelManager.clear();
    expect(scene.children).toHaveLength(0);
    expect(modelManager.getAllModels()).toHaveLength(0);
  });

  it('requests a render when models change', () => {
    const requestRender = vi.fn();
    const mm = new ModelManager(new THREE.Scene(), requestRender);
    mm.addModel(boxModel('m1', [1]));
    expect(requestRender).toHaveBeenCalled();
    requestRender.mockClear();
    mm.setHidden('m1', [1], true);
    expect(requestRender).toHaveBeenCalled();
    requestRender.mockClear();
    mm.removeModel('m1');
    expect(requestRender).toHaveBeenCalled();
  });
});

describe('ModelManager — bounds', () => {
  it('frames the exact extent of the loaded geometry', () => {
    // Unit boxes at x = 0, 2, 4.
    const { modelManager } = makeModelManager([boxModel('m1', [1, 2, 3])]);
    const box = modelManager.getBoundingBox();
    expect(box.min.toArray()).toEqual([-0.5, -0.5, -0.5]);
    expect(box.max.toArray()).toEqual([4.5, 0.5, 0.5]);
  });

  it('leaves hidden elements out of the box (fit to visible)', () => {
    const { modelManager } = makeModelManager([boxModel('m1', [1, 2, 3])]);
    modelManager.setHidden('m1', [3], true);
    expect(modelManager.getBoundingBox().max.x).toBe(2.5);
    modelManager.setHidden('m1', [3], false);
    expect(modelManager.getBoundingBox().max.x).toBe(4.5);
  });

  it('leaves a hidden model out of the all-models box, but frames it when asked for by id', () => {
    const { modelManager } = makeModelManager([
      boxModel('a', [1]),
      { id: 'b', meshes: [boxMesh(1, { at: [10, 0, 0] })] },
    ]);
    modelManager.setVisible('b', false);
    expect(modelManager.getBoundingBox().max.x).toBe(0.5);
    expect(modelManager.getBoundingBox('b').min.x).toBe(9.5);
  });

  it('is empty when every element is hidden', () => {
    const { modelManager } = makeModelManager([boxModel('m1', [1, 2])]);
    modelManager.setHidden('m1', [1, 2], true);
    expect(modelManager.getBoundingBox().isEmpty()).toBe(true);
  });

  it('getElementsBoundingBox unions every piece of the given elements, hidden or not', () => {
    const { modelManager } = makeModelManager([boxModel('m1', [1, 2, 3])]);
    modelManager.setHidden('m1', [3], true);
    const box = modelManager.getElementsBoundingBox([
      { modelId: 'm1', expressId: 1 },
      { modelId: 'm1', expressId: 3 },
    ]);
    expect(box.min.x).toBe(-0.5);
    expect(box.max.x).toBe(4.5);
  });

  it('keeps full precision far from the origin (georeferenced coordinates)', () => {
    const far = 417615.25;
    const { modelManager } = makeModelManager([
      { id: 'geo', meshes: [boxMesh(1, { at: [far, 241.5, -78698.75] }), boxMesh(2, { at: [far + 3, 241.5, -78698.75] })] },
    ]);
    const box = modelManager.getBoundingBox();
    expect(box.min.x).toBeCloseTo(far - 0.5, 6);
    expect(box.max.x).toBeCloseTo(far + 3.5, 6);
    expect(box.min.z).toBeCloseTo(-78699.25, 6);
  });

  it('forEachVisiblePiece visits each drawn piece with its world box', () => {
    const { modelManager } = makeModelManager([boxModel('a', [1, 1, 2]), boxModel('b', [9])]);
    modelManager.setHidden('a', [2], true);
    modelManager.setVisible('b', false);
    const seen: string[] = [];
    modelManager.forEachVisiblePiece((modelId, expressId, box) => seen.push(`${modelId}:${expressId}@${box.min.x}`));
    expect(seen.sort()).toEqual(['a:1@-0.5', 'a:1@1.5']);
  });
});

describe('ModelManager — streamed loads', () => {
  it('beginStream adds an empty model to the scene', () => {
    const { modelManager, scene } = makeModelManager();
    const entry = modelManager.beginStream('s');
    expect(entry.group.parent).toBe(scene);
    expect(modelManager.pieceCount()).toBe(0);
    expect(modelManager.getBoundingBox().isEmpty()).toBe(true);
  });

  it('appendMeshes fills the model across batches; elements are usable before the stream ends', () => {
    const { modelManager } = makeModelManager();
    modelManager.beginStream('s');
    modelManager.appendMeshes('s', [boxMesh(1), boxMesh(2, { at: [2, 0, 0] })]);
    modelManager.setHighlighted('s', [1], true);
    modelManager.appendMeshes('s', [boxMesh(3, { at: [4, 0, 0] }), boxMesh(1, { at: [6, 0, 0] })]);
    expect(modelManager.pieceCount()).toBe(4);
    expect(modelManager.elementIds('s').sort()).toEqual([1, 2, 3]);
    // The second piece of element 1 arrived after the highlight was set and
    // joins its element highlighted: hiding the element now hides both pieces.
    expect(modelManager.getElementState('s', 1)!.highlighted).toBe(true);
    modelManager.setHighlighted('s', [1], false);
    modelManager.setHidden('s', [2, 3], true);
    expect(modelManager.getBoundingBox().min.x).toBe(-0.5);
    expect(modelManager.getBoundingBox().max.x).toBe(6.5);
    modelManager.setHidden('s', [2, 3], false);
    expect(modelManager.endStream('s')).toBe(modelManager.getModel('s'));
    expect(modelManager.getBoundingBox().max.x).toBe(6.5);
  });

  it('a piece arriving for an already-hidden element arrives hidden', () => {
    const { modelManager } = makeModelManager();
    modelManager.beginStream('s');
    modelManager.appendMeshes('s', [boxMesh(1), boxMesh(2, { at: [2, 0, 0] })]);
    modelManager.setHidden('s', [2], true);
    modelManager.appendMeshes('s', [boxMesh(2, { at: [10, 0, 0] })]);
    modelManager.endStream('s');
    expect(modelManager.getBoundingBox().max.x).toBe(0.5);
  });

  it('endStream on an unknown id returns undefined', () => {
    const { modelManager } = makeModelManager();
    expect(modelManager.endStream('nope')).toBeUndefined();
  });

  it('appendMeshes is a no-op without an open stream, and after removeModel', () => {
    const { modelManager } = makeModelManager([boxModel('done', [1])]);
    modelManager.appendMeshes('done', [boxMesh(2)]);
    expect(modelManager.pieceCount()).toBe(1);
    modelManager.beginStream('s');
    modelManager.removeModel('s');
    modelManager.appendMeshes('s', [boxMesh(3)]);
    expect(modelManager.getModel('s')).toBeUndefined();
    expect(modelManager.pieceCount()).toBe(1);
  });

  it('addModel equals beginStream + appendMeshes + endStream', () => {
    const a = makeModelManager([boxModel('m', [1, 2, 3])]).modelManager;
    const b = makeModelManager().modelManager;
    b.beginStream('m');
    b.appendMeshes('m', boxModel('m', [1, 2, 3]).meshes);
    b.endStream('m');
    expect(b.getModel('m')!.batch.stats()).toEqual(a.getModel('m')!.batch.stats());
    expect(b.getBoundingBox().equals(a.getBoundingBox())).toBe(true);
  });

  it('beginStream replaces an existing model with the same id', () => {
    const { modelManager, scene } = makeModelManager([boxModel('m', [1])]);
    modelManager.beginStream('m');
    expect(scene.children).toHaveLength(1);
    expect(modelManager.pieceCount()).toBe(0);
  });
});

describe('ModelBatch — drawing in few draw calls', () => {
  it('draws a thousand pieces in a single chunk mesh', () => {
    const meshes = Array.from({ length: 1000 }, (_, i) => boxMesh(i + 1, { at: [i % 40, Math.floor(i / 40), 0] }));
    const { modelManager, scene } = makeModelManager([{ id: 'm', meshes }]);
    expect(modelManager.pieceCount()).toBe(1000);
    expect(chunkMeshes(scene)).toHaveLength(1);
    expect(modelManager.getModel('m')!.batch.stats()).toMatchObject({ vertices: 24000, triangles: 12000 });
  });

  it('splits a model into spatially compact chunks once a chunk passes its vertex cap', () => {
    // 20 × 20 boxes on a grid; 24 vertices each; cap 1200 → ≤ ~50 boxes per chunk.
    const meshes = Array.from({ length: 400 }, (_, i) => boxMesh(i + 1, { at: [(i % 20) * 3, Math.floor(i / 20) * 3, 0] }));
    const batch = new ModelBatch('m', { chunkVertexCap: 1200 });
    // Streamed in small batches, the way the worker delivers them.
    for (let i = 0; i < meshes.length; i += 37) batch.append(meshes.slice(i, i + 37));
    batch.finish();

    const chunks = batch.chunkMeshes();
    expect(chunks.length).toBeGreaterThan(8);
    expect(chunks.length).toBeLessThan(40);
    const total = batch.stats();
    expect(total.vertices).toBe(400 * 24);
    expect(total.triangles).toBe(400 * 12);
    // Compact: no chunk spans more than half the model in both directions.
    for (const mesh of chunks) {
      const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
      expect(Math.min(size.x, size.y)).toBeLessThan(30);
    }
    // Every piece still resolves after all those splits.
    const scene = new THREE.Scene();
    scene.add(batch.group);
    for (const id of [1, 77, 210, 400]) {
      const i = id - 1;
      const hit = pick(scene, new THREE.Vector3((i % 20) * 3, Math.floor(i / 20) * 3, 10), new THREE.Vector3(0, 0, -1));
      expect(elementOfHit(hit)).toEqual({ modelId: 'm', expressId: id });
    }
  });

  it('keeps frustum culling on, with bounds that cover every piece of the chunk (#74)', () => {
    const meshes = Array.from({ length: 400 }, (_, i) => boxMesh(i + 1, { at: [(i % 20) * 3, Math.floor(i / 20) * 3, 0] }));
    const batch = new ModelBatch('m', { chunkVertexCap: 1200 });
    batch.append(meshes);
    batch.finish();
    batch.group.updateMatrixWorld(true);

    for (const mesh of batch.chunkMeshes()) {
      expect(mesh.frustumCulled).toBe(true);
      expect(mesh.geometry.boundingSphere).not.toBeNull();
    }
    // Every piece's box lies inside its chunk's bounding sphere.
    const scene = new THREE.Scene();
    scene.add(batch.group);
    let covered = 0;
    batch.forEachVisiblePiece((_id, box) => {
      const owner = batch.chunkMeshes().find((m) => m.geometry.boundingBox!.containsBox(box));
      if (owner) covered++;
    });
    expect(covered).toBe(400);

    // A camera looking at one corner leaves most chunks outside its frustum,
    // so the renderer skips them.
    const camera = cameraLookingAt([0, 0, 8], [0, 0, 0]);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const drawn = batch.chunkMeshes().filter((m) => frustum.intersectsObject(m));
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(batch.chunkMeshes().length / 2);
  });

  it('puts see-through pieces in their own chunk, drawn in the transparent pass', () => {
    const glass = { r: 0.6, g: 0.8, b: 1, a: 0.3 };
    const { modelManager, scene } = makeModelManager([
      { id: 'm', meshes: [boxMesh(1), boxMesh(2, { at: [2, 0, 0], color: glass })] },
    ]);
    const chunks = chunkMeshes(scene);
    expect(chunks).toHaveLength(2);
    const transparent = chunks.filter((c) => (c.material as THREE.Material).transparent);
    expect(transparent).toHaveLength(1);
    expect(modelManager.getElementState('m', 2)!.opacity).toBeCloseTo(0.3);
    expect(modelManager.getModel('m')!.batch.stats().transparentChunks).toBe(1);
  });

  it('a piece placed by a mirroring transform keeps its triangles facing outwards', () => {
    const mesh = boxMesh(1);
    mesh.transform = new THREE.Matrix4().makeScale(-1, 1, 1).toArray();
    const { modelManager } = makeModelManager([{ id: 'm', meshes: [mesh] }]);
    const geo = modelManager.getModel('m')!.batch.pieceGeometry(0)!.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex()!;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < idx.count; t += 3) {
      a.fromBufferAttribute(pos, idx.getX(t));
      b.fromBufferAttribute(pos, idx.getX(t + 1));
      c.fromBufferAttribute(pos, idx.getX(t + 2));
      const normal = b.clone().sub(a).cross(c.clone().sub(a));
      const centre = a.clone().add(b).add(c).divideScalar(3);
      // Outward: the winding normal points away from the box centre.
      expect(normal.dot(centre)).toBeGreaterThan(0);
    }
  });
});

describe('ModelBatch — element appearance', () => {
  it('hides, highlights and recolours whole elements, and restores their own colour', () => {
    const red = { r: 1, g: 0, b: 0, a: 1 };
    const { modelManager } = makeModelManager([{ id: 'm', meshes: [boxMesh(1, { color: red }), boxMesh(1, { at: [2, 0, 0], color: red })] }]);
    const batch = modelManager.getModel('m')!.batch;

    modelManager.setHighlighted('m', [1], true);
    expect(batch.elementState(1)).toMatchObject({ highlighted: true, hidden: false });

    modelManager.setColor('m', [1], { r: 0, g: 0, b: 1 });
    expect(batch.elementState(1)!.color).toEqual({ r: 0, g: 0, b: 1 });
    expect(batch.elementState(1)!.colorOverridden).toBe(true);
    modelManager.setColor('m', [1], null);
    expect(batch.elementState(1)!.color).toEqual({ r: 1, g: 0, b: 0 });

    modelManager.setHidden('m', [1], true);
    expect(batch.isHidden(1)).toBe(true);
    // Both pieces are gone from the frame, not just the first.
    expect(modelManager.getBoundingBox().isEmpty()).toBe(true);
  });

  it('a see-through override gets an overlay draw; clearing it removes the overlay', () => {
    const { modelManager } = makeModelManager([boxModel('m', [1, 2, 3])]);
    const batch = modelManager.getModel('m')!.batch;
    modelManager.setOpacity('m', [2], 0.25);
    expect(batch.elementState(2)!.opacity).toBe(0.25);
    expect(batch.stats().overlays).toBe(1);
    modelManager.setOpacity('m', [2], null);
    expect(batch.elementState(2)!.opacity).toBe(1);
    expect(batch.stats().overlays).toBe(0);
  });

  it('colours tens of thousands of elements in one call', () => {
    const meshes = Array.from({ length: 20000 }, (_, i) => boxMesh(i + 1, { at: [i % 200, Math.floor(i / 200), 0] }));
    const { modelManager } = makeModelManager([{ id: 'm', meshes }]);
    const ids = modelManager.elementIds('m');
    const t0 = performance.now();
    modelManager.setColor('m', ids, { r: 0.1, g: 0.9, b: 0.2 });
    modelManager.setHidden('m', ids.filter((id) => id % 2 === 0), true);
    const ms = performance.now() - t0;
    expect(modelManager.getElementState('m', 12345)!.color.g).toBeCloseTo(0.9);
    expect(modelManager.getElementState('m', 12346)!.hidden).toBe(true);
    // Generous: a texture write per piece, no geometry touched.
    expect(ms).toBeLessThan(500);
  });
});

describe('ModelBatch — data colours (colour by parameter)', () => {
  const red = { r: 1, g: 0, b: 0, a: 1 };

  it('gives each element its own colour in one call, on every piece', () => {
    const { modelManager } = makeModelManager([boxModel('m', [1, 1, 2, 3], { color: red })]);
    const rgba = new Float32Array([0, 1, 0, 1, 0, 0, 1, 1, NaN, 0, 0, 0]);
    modelManager.setDataColors('m', [1, 2, 3], rgba);
    const batch = modelManager.getModel('m')!.batch;
    expect(batch.elementState(1)).toMatchObject({ color: { r: 0, g: 1, b: 0 }, dataColored: true, opacity: 1 });
    expect(batch.elementState(2)!.color).toEqual({ r: 0, g: 0, b: 1 });
    // NaN: no data colour, the element's own.
    expect(batch.elementState(3)).toMatchObject({ color: { r: 1, g: 0, b: 0 }, dataColored: false });
  });

  it('is a layer above the colour override: clearing it brings the override back', () => {
    const { modelManager } = makeModelManager([boxModel('m', [1, 2], { color: red })]);
    const batch = modelManager.getModel('m')!.batch;
    modelManager.setColor('m', [1], { r: 0, g: 0, b: 1 });
    modelManager.setDataColors('m', [1, 2], new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]));
    expect(batch.elementState(1)!.color).toEqual({ r: 0, g: 1, b: 0 });
    modelManager.clearDataColors('m');
    expect(batch.elementState(1)).toMatchObject({ color: { r: 0, g: 0, b: 1 }, colorOverridden: true, dataColored: false });
    expect(batch.elementState(2)).toMatchObject({ color: { r: 1, g: 0, b: 0 }, colorOverridden: false });
    expect(batch.dataColorBytes).toBe(0);
  });

  it('a ghost alpha makes an element see-through, and clearing makes it solid again', () => {
    const { modelManager } = makeModelManager([boxModel('m', [1, 2])]);
    const batch = modelManager.getModel('m')!.batch;
    modelManager.setDataColors('m', [1, 2], new Float32Array([0.5, 0.5, 0.5, 0.3, 1, 0, 0, 1]));
    expect(batch.elementState(1)!.opacity).toBeCloseTo(0.3);
    expect(batch.elementState(2)!.opacity).toBe(1);
    expect(batch.stats().overlays).toBe(1);
    modelManager.clearDataColors('m');
    expect(batch.elementState(1)!.opacity).toBe(1);
    expect(batch.stats().overlays).toBe(0);
  });

  it('a ghost never makes an element more solid than it was made', () => {
    const { modelManager } = makeModelManager([boxModel('m', [1])]);
    const batch = modelManager.getModel('m')!.batch;
    modelManager.setOpacity('m', [1], 0.25);
    modelManager.setDataColors('m', [1], new Float32Array([0.5, 0.5, 0.5, 0.3]));
    expect(batch.elementState(1)!.opacity).toBe(0.25);
  });

  it('leaves hidden, see-through and highlighted elements as they are', () => {
    const { modelManager } = makeModelManager([boxModel('m', [1, 2, 3])]);
    const batch = modelManager.getModel('m')!.batch;
    modelManager.setHidden('m', [1], true);
    modelManager.setOpacity('m', [2], 0.25);
    modelManager.setHighlighted('m', [3], true);
    modelManager.setDataColors('m', [1, 2, 3], new Float32Array(12).fill(1));
    expect(batch.elementState(1)!.hidden).toBe(true);
    expect(batch.elementState(2)!.opacity).toBe(0.25);
    expect(batch.elementState(3)!.highlighted).toBe(true);
    modelManager.clearDataColors('m');
    expect(batch.elementState(1)!.hidden).toBe(true);
    expect(batch.elementState(2)!.opacity).toBe(0.25);
    expect(batch.elementState(3)!.highlighted).toBe(true);
  });

  it('draws a selected element in the highlight colour, so the selection shows on any data colour', () => {
    const { modelManager } = makeModelManager([boxModel('m', [1])]);
    const batch = modelManager.getModel('m')!.batch;
    modelManager.setDataColors('m', [1], new Float32Array([0, 1, 0, 1]));
    modelManager.setHighlighted('m', [1], true);
    const blue = new THREE.Color(HIGHLIGHT_COLOR);
    expect(batch.elementState(1)!.color.b).toBeCloseTo(blue.b);
    modelManager.setHighlighted('m', [1], false);
    expect(batch.elementState(1)!.color).toEqual({ r: 0, g: 1, b: 0 });
  });

  it('holds no memory until used, and ignores elements the model does not have', () => {
    const { modelManager } = makeModelManager([boxModel('m', [1])]);
    const batch = modelManager.getModel('m')!.batch;
    expect(batch.dataColorBytes).toBe(0);
    modelManager.setDataColors('m', [1, 999], new Float32Array([1, 1, 1, 1, 0, 0, 0, 1]));
    expect(batch.elementState(1)!.dataColored).toBe(true);
    // Four floats per piece, for the pieces there are.
    expect(batch.dataColorBytes).toBe(16);
  });

  it('colours 20,000 elements, each its own colour, quickly', () => {
    const meshes = Array.from({ length: 20000 }, (_, i) => boxMesh(i + 1, { at: [i % 200, Math.floor(i / 200), 0] }));
    const { modelManager } = makeModelManager([{ id: 'm', meshes }]);
    const ids = Int32Array.from(modelManager.elementIds('m'));
    const rgba = new Float32Array(ids.length * 4).fill(1);
    for (let i = 0; i < ids.length; i++) rgba[i * 4] = i / ids.length;
    const t0 = performance.now();
    modelManager.setDataColors('m', ids, rgba);
    modelManager.clearDataColors('m');
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('ModelBatch — picking', () => {
  it('resolves a hit to its model and element, with the hit point in world space', () => {
    const { scene } = makeModelManager([boxModel('m', [10, 20, 30])]);
    const hit = pick(scene, new THREE.Vector3(2, 0, 10), new THREE.Vector3(0, 0, -1))!;
    expect(elementOfHit(hit)).toEqual({ modelId: 'm', expressId: 20 });
    expect(modelIdOfObject(hit.object)).toBe('m');
    expect(hit.point.z).toBeCloseTo(0.5);
    expect(hit.distance).toBeCloseTo(9.5);
    expect(hit.face!.normal.z).toBeCloseTo(1);
  });

  it('picks far from the origin without losing precision', () => {
    const x = 417615.25;
    const { scene } = makeModelManager([{ id: 'geo', meshes: [boxMesh(7, { at: [x, 0, 0] })] }]);
    const hit = pick(scene, new THREE.Vector3(x + 0.25, 0.1, 10), new THREE.Vector3(0, 0, -1))!;
    expect(elementOfHit(hit)!.expressId).toBe(7);
    expect(hit.point.x).toBeCloseTo(x + 0.25, 4);
    expect(hit.point.z).toBeCloseTo(0.5, 4);
  });

  it('does not pick hidden elements, or elements of a hidden model', () => {
    // Two boxes on the same line of sight: 1 in front, 2 behind.
    const { modelManager, scene } = makeModelManager([
      { id: 'm', meshes: [boxMesh(1, { at: [0, 0, 2] }), boxMesh(2, { at: [0, 0, 0] })] },
    ]);
    const shoot = () => elementOfHit(pick(scene, new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1)));
    expect(shoot()!.expressId).toBe(1);
    modelManager.setHidden('m', [1], true);
    expect(shoot()!.expressId).toBe(2);
    modelManager.setHidden('m', [1], false);
    modelManager.setVisible('m', false);
    // Raycasting goes through traverseVisible in the app; a hidden group is skipped there.
    const visible: THREE.Object3D[] = [];
    scene.traverseVisible((o) => visible.push(o));
    expect(visible.some((o) => o instanceof ChunkMesh)).toBe(false);
  });

  it('hands snapping the hit piece\'s own triangles, with faceIndex pointing into them', () => {
    const { scene } = makeModelManager([boxModel('m', [1, 2])]);
    const hit = pick(scene, new THREE.Vector3(2.2, 0.1, 10), new THREE.Vector3(0, 0, -1))!;
    const piece = pieceGeometryOfHit(hit)!;
    expect(piece.geometry.getIndex()!.count).toBe(36);
    // The triangle at faceIndex, placed in the world, contains the hit point.
    const pos = piece.geometry.getAttribute('position');
    const idx = piece.geometry.getIndex()!;
    const tri = new THREE.Triangle(
      new THREE.Vector3().fromBufferAttribute(pos, idx.getX(hit.faceIndex! * 3)).applyMatrix4(piece.matrixWorld),
      new THREE.Vector3().fromBufferAttribute(pos, idx.getX(hit.faceIndex! * 3 + 1)).applyMatrix4(piece.matrixWorld),
      new THREE.Vector3().fromBufferAttribute(pos, idx.getX(hit.faceIndex! * 3 + 2)).applyMatrix4(piece.matrixWorld),
    );
    expect(tri.containsPoint(hit.point)).toBe(true);
  });

  it('overlay meshes are never picked themselves (no duplicate hits)', () => {
    const { modelManager, scene } = makeModelManager([boxModel('m', [1])]);
    modelManager.setOpacity('m', [1], 0.25);
    scene.updateMatrixWorld(true);
    // Off the faces' diagonals, so each face yields exactly one triangle.
    const raycaster = new THREE.Raycaster(new THREE.Vector3(0.2, 0.1, 10), new THREE.Vector3(0, 0, -1));
    const hits = raycaster.intersectObjects(scene.children, true);
    // A box is entered and left: two faces, both from the chunk mesh.
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.object instanceof ChunkMesh)).toBe(true);
  });
});

describe('ModelBatch — precision far from the origin', () => {
  /** Largest gap between a piece's snapping corners, placed in the world, and where the box really has them. */
  function worstCornerError(batch: ModelBatch, pieceId: number, at: [number, number, number], size: [number, number, number]): number {
    const piece = batch.pieceGeometry(pieceId)!;
    const pos = piece.geometry.getAttribute('position');
    const t = new THREE.Vector3().setFromMatrixPosition(piece.matrixWorld);
    let worst = 0;
    for (let i = 0; i < pos.count; i++) {
      for (let k = 0; k < 3; k++) {
        const world = pos.getComponent(i, k) + t.getComponent(k);
        // Every corner of the box is at the centre ± half the edge.
        const local = world - at[k];
        worst = Math.max(worst, Math.abs(Math.abs(local) - size[k] / 2));
      }
    }
    return worst;
  }

  it('keeps sub-millimetre corners when the first piece is at the origin and the building 6,500 km away', () => {
    const batch = new ModelBatch('m');
    const site: [number, number, number] = [6500000.137, 1200000.071, 12.345];
    const size: [number, number, number] = [0.2, 0.06, 0.2];
    batch.append([boxMesh(1), boxMesh(2, { at: site, size })]);
    batch.finish();

    // Pieces are numbered from 0 in arrival order.
    expect(worstCornerError(batch, 0, [0, 0, 0], [1, 1, 1])).toBeLessThan(1e-5);
    expect(worstCornerError(batch, 1, site, size)).toBeLessThan(1e-5);
    const box = batch.expandByElements([2], new THREE.Box3());
    expect(box.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(6))).toEqual(size);
    expect(box.getCenter(new THREE.Vector3()).distanceTo(new THREE.Vector3(...site))).toBeLessThan(1e-6);

    // Picking lands on the far box, where it really is.
    const scene = new THREE.Scene();
    scene.add(batch.group);
    const hit = pick(scene, new THREE.Vector3(site[0] + 0.05, site[1] + 0.01, site[2] + 10), new THREE.Vector3(0, 0, -1))!;
    expect(elementOfHit(hit)!.expressId).toBe(2);
    expect(Math.abs(hit.point.z - (site[2] + 0.1))).toBeLessThan(1e-5);
    expect(Math.abs(hit.point.x - (site[0] + 0.05))).toBeLessThan(1e-5);
  });

  it('keeps sub-millimetre corners for a whole model far away, across chunk splits', () => {
    const base = [6500000.37, 1200000.81, 3.3];
    const size: [number, number, number] = [0.3, 0.3, 0.3];
    const at = (i: number): [number, number, number] => [base[0] + (i % 20) * 7.13, base[1] + Math.floor(i / 20) * 9.07, base[2]];
    const meshes = Array.from({ length: 400 }, (_, i) => boxMesh(i + 1, { at: at(i), size }));
    const batch = new ModelBatch('m', { chunkVertexCap: 1200 });
    for (let i = 0; i < meshes.length; i += 37) batch.append(meshes.slice(i, i + 37));
    batch.finish();
    expect(batch.chunkMeshes().length).toBeGreaterThan(4);

    let worst = 0;
    for (let i = 0; i < 400; i++) worst = Math.max(worst, worstCornerError(batch, i, at(i), size));
    expect(worst).toBeLessThan(1e-5);
    // Each chunk's own bounds (chunk space, placed by its mesh) cover its pieces in the world.
    let covered = 0;
    batch.forEachVisiblePiece((_id, box) => {
      if (batch.chunkMeshes().some((m) => m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld).expandByScalar(1e-6).containsBox(box))) covered++;
    });
    expect(covered).toBe(400);
  });

  it('gives a piece out of reach of every chunk its own chunk, without moving the others', () => {
    const batch = new ModelBatch('m');
    batch.append([boxMesh(1), boxMesh(2, { at: [3, 0, 0] })]);
    const [first] = batch.chunkMeshes();
    batch.append([boxMesh(3, { at: [ANCHOR_REACH * 3, 0, 0] }), boxMesh(4, { at: [6, 0, 0] })]);
    expect(batch.chunkMeshes()).toHaveLength(2);
    expect(batch.chunkMeshes()).toContain(first);
    // A later piece near the first ones still joins their chunk.
    expect(batch.stats().vertices).toBe(4 * 24);
    expect(first.geometry.drawRange.count).toBe(3 * 36);
  });
});

/**
 * What a WebGL renderer would hold for each buffer, uploaded by three r183's
 * rules (WebGLAttributes): the whole array the first time, then — on each
 * version bump — the queued update ranges, or the whole array when none are
 * queued. A buffer belongs to an attribute object: swapping the attribute's
 * array without marking it for update sends nothing.
 */
class GpuMirror {
  private held = new Map<THREE.BufferAttribute, { copy: number[]; version: number }>();
  /** Elements sent as whole buffers (new buffers, or updates without ranges). */
  wholeElements = 0;

  sync(batch: ModelBatch): void {
    for (const mesh of batch.chunkMeshes()) {
      const g = mesh.geometry;
      for (const name of ['position', 'normal', 'pieceIndex']) this.upload(g.getAttribute(name) as THREE.BufferAttribute);
      this.upload(g.getIndex()!);
    }
  }

  /** Elements of the CPU array whose GPU copy differs from it. */
  stale(attribute: THREE.BufferAttribute): number {
    const h = this.held.get(attribute)!;
    let n = 0;
    for (let i = 0; i < attribute.array.length; i++) if (h.copy[i] !== attribute.array[i]) n++;
    return n;
  }

  private upload(a: THREE.BufferAttribute): void {
    const h = this.held.get(a);
    if (!h) {
      this.held.set(a, { copy: Array.from(a.array), version: a.version });
      this.wholeElements += a.array.length;
      a.onUploadCallback();
      return;
    }
    if (h.version >= a.version) return;
    if (a.updateRanges.length === 0) {
      h.copy = Array.from(a.array);
      this.wholeElements += a.array.length;
    } else {
      for (const r of a.updateRanges) for (let i = r.start; i < r.start + r.count; i++) h.copy[i] = a.array[i];
      a.clearUpdateRanges();
    }
    h.version = a.version;
    a.onUploadCallback();
  }
}

describe('ModelBatch — what reaches the GPU', () => {
  it('an append that fits a chunk queues exactly the new vertices of every attribute', () => {
    const batch = new ModelBatch('m');
    batch.append([boxMesh(1)]);
    const gpu = new GpuMirror();
    gpu.sync(batch); // the first frame uploads everything
    const [mesh] = batch.chunkMeshes();
    const g = mesh.geometry;
    for (const name of ['position', 'normal', 'pieceIndex']) expect((g.getAttribute(name) as THREE.BufferAttribute).updateRanges).toEqual([]);

    batch.append([boxMesh(2, { at: [2, 0, 0] })]);
    expect(batch.chunkMeshes()).toEqual([mesh]); // same chunk, same buffers
    const v0 = 24, v1 = 48;
    for (const name of ['position', 'normal', 'pieceIndex']) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      expect(a.updateRanges, name).toEqual([{ start: v0 * a.itemSize, count: (v1 - v0) * a.itemSize }]);
    }
    expect(g.getIndex()!.updateRanges).toEqual([{ start: 36, count: 36 }]);
  });

  it('after a streamed load the GPU copy of every chunk matches its CPU arrays', () => {
    // Small batches into chunks that keep room, so most appends are partial
    // uploads; a cap low enough to split now and then.
    const meshes = Array.from({ length: 300 }, (_, i) => boxMesh(i + 1, { at: [(i % 15) * 3, Math.floor(i / 15) * 3, 0] }));
    const batch = new ModelBatch('m', { chunkVertexCap: 2400 });
    const gpu = new GpuMirror();
    const expectInSync = (names: string[]) => {
      for (const mesh of batch.chunkMeshes()) {
        const g = mesh.geometry;
        for (const name of names) expect(gpu.stale(g.getAttribute(name) as THREE.BufferAttribute), name).toBe(0);
        expect(gpu.stale(g.getIndex()!)).toBe(0);
      }
    };
    for (let i = 0; i < meshes.length; i += 7) {
      batch.append(meshes.slice(i, i + 7));
      gpu.sync(batch);
    }
    // Before `finish` as well as after: `finish` trims what the CPU keeps.
    expectInSync(['position', 'normal', 'pieceIndex']);
    batch.finish();
    gpu.sync(batch);
    // Normals and piece indices live only on the GPU from here on.
    expectInSync(['position']);
  });

  it('once finished and uploaded, keeps no CPU copy of what only the GPU reads', () => {
    const meshes = Array.from({ length: 50 }, (_, i) => boxMesh(i + 1, { at: [i * 2, 0, 0] }));
    const batch = new ModelBatch('m');
    batch.append(meshes.slice(0, 25));
    const gpu = new GpuMirror();
    gpu.sync(batch);
    batch.append(meshes.slice(25)); // queued, not yet uploaded
    batch.finish();
    const g = batch.chunkMeshes()[0].geometry;
    // Not before the GPU has the data…
    expect(g.getAttribute('normal').array.length).toBeGreaterThan(0);
    gpu.sync(batch);
    // …but right after.
    expect(g.getAttribute('normal').array).toHaveLength(0);
    expect(g.getAttribute('pieceIndex').array).toHaveLength(0);
    expect(g.getAttribute('normal').count).toBeGreaterThanOrEqual(50 * 24);
    // Picking and snapping still have what they read.
    expect(g.getAttribute('position').array.length).toBeGreaterThanOrEqual(50 * 24 * 3);
    expect(batch.pieceGeometry(30)!.geometry.getIndex()!.count).toBe(36);
    expect(() => batch.append([boxMesh(99)])).toThrow();
  });
});

describe('ModelBatch — cheap to stream', () => {
  it('a piece of half a chunk or more gets an exactly sized chunk that later splits never copy', () => {
    const big = boxMesh(1, { at: [30, 30, 0] });
    big.vertices = new Float32Array(Array.from({ length: 700 }, () => Array.from(big.vertices)).flat());
    big.normals = new Float32Array(Array.from({ length: 700 }, () => Array.from(big.normals)).flat());
    big.indices = new Uint32Array(Array.from({ length: 700 }, (_, k) => Array.from(boxMesh(1).indices, (i) => i + k * 24)).flat());
    const batch = new ModelBatch('m', { chunkVertexCap: 24 * 1400 }); // the big piece is exactly half
    batch.append([big]);
    const [solo] = batch.chunkMeshes();
    const positions = solo.geometry.getAttribute('position');
    expect(positions.count).toBe(700 * 24);
    // Enough small pieces around it to split the rest many times over.
    const small = Array.from({ length: 4000 }, (_, i) => boxMesh(i + 2, { at: [(i % 60) * 1.1, Math.floor(i / 60) * 1.1, 0] }));
    for (let i = 0; i < small.length; i += 100) batch.append(small.slice(i, i + 100));
    batch.finish();
    expect(batch.chunkMeshes().length).toBeGreaterThan(3);
    expect(batch.chunkMeshes()).toContain(solo);
    expect(solo.geometry.getAttribute('position')).toBe(positions);
    expect(solo.geometry.drawRange.count).toBe(700 * 36);
  });

  it('streams with little more upload than the model itself, and finishing uploads nothing', () => {
    const meshes = Array.from({ length: 2000 }, (_, i) => boxMesh(i + 1, { at: [(i % 50) * 3, Math.floor(i / 50) * 3, 0] }));
    const batch = new ModelBatch('m', { chunkVertexCap: 24 * 200 });
    const gpu = new GpuMirror();
    for (let i = 0; i < meshes.length; i += 25) {
      batch.append(meshes.slice(i, i + 25));
      gpu.sync(batch);
    }
    const streamed = gpu.wholeElements;
    batch.finish();
    gpu.sync(batch);
    expect(gpu.wholeElements).toBe(streamed);
    // Whole-buffer uploads (positions, normals, piece index, index — counted
    // in array elements, capacity included) stay within a few times the
    // model's own size, however often the regions split.
    const modelElements = 2000 * 24 * (3 + 4 + 1) + 2000 * 36;
    expect(streamed / modelElements).toBeLessThan(4);
    // The CPU keeps exactly what the chunks hold.
    let positions = 0;
    for (const mesh of batch.chunkMeshes()) {
      const g = mesh.geometry;
      positions += g.getAttribute('position').array.length;
      expect(g.getIndex()!.array.length).toBe(g.drawRange.count);
    }
    expect(positions).toBe(batch.stats().vertices * 3);
  });
});

describe('ModelBatch — per-element state upload', () => {
  const stateTexture = (b: ModelBatch) =>
    (b as unknown as { uniforms: { pieceState: { value: THREE.DataTexture } } }).uniforms.pieceState.value;

  it('a change to a few elements sends only their rows of the state texture', () => {
    const meshes = Array.from({ length: 20000 }, (_, i) => boxMesh(i + 1, { at: [i % 200, Math.floor(i / 200), 0] }));
    const batch = new ModelBatch('m');
    batch.append(meshes);
    const texture = stateTexture(batch);
    const rowFloats = texture.image.width * 4;
    // Not on the GPU yet: whatever changes, the first upload is whole.
    batch.setHighlighted([5], true);
    expect(texture.updateRanges).toEqual([]);
    texture.onUpdate!(texture); // the renderer uploaded it

    const version = texture.version;
    batch.setHighlighted([1500], true); // piece 1499: texels 2998–2999, row 2
    expect(texture.version).toBeGreaterThan(version);
    expect(texture.updateRanges).toEqual([{ start: 2 * rowFloats, count: rowFloats }]);
    texture.onUpdate!(texture);
    texture.clearUpdateRanges();

    // Touching most rows sends the whole texture in one go.
    batch.setHidden(meshes.map((m) => m.expressID).filter((id) => id % 2 === 0), true);
    expect(texture.updateRanges).toEqual([]);
    expect(batch.elementState(2)!.hidden).toBe(true);
  });
});

describe('ModelBatch — see-through overlays', () => {
  it('clearing the last see-through override frees only the overlay\'s own index, never the chunk\'s vertex buffers', () => {
    const { modelManager } = makeModelManager([boxModel('m', [1, 2, 3])]);
    const batch = modelManager.getModel('m')!.batch;
    modelManager.setOpacity('m', [2], 0.25);
    const overlay = batch.group.children.find((o) => o.userData.isPieceOverlay) as THREE.Mesh;
    const freed: string[][] = [];
    overlay.geometry.addEventListener('dispose', (e) => freed.push(Object.keys((e.target as THREE.BufferGeometry).attributes)));
    modelManager.setOpacity('m', [2], null);
    expect(batch.stats().overlays).toBe(0);
    // The renderer frees every attribute a disposed geometry lists.
    expect(freed).toEqual([[]]);
  });
});

describe('ModelBatch — see-through order', () => {
  /** World z of the first corner each visible band draws, in draw order. */
  function drawOrderZ(batch: ModelBatch): number[] {
    const bands = batch.group.children.filter((o) => o.userData.isSeeThroughBand && o.visible) as THREE.Mesh[];
    bands.sort((a, b) => a.renderOrder - b.renderOrder);
    return bands.map((m) => {
      const g = m.geometry;
      const v = g.getIndex()!.getX(g.drawRange.start);
      return g.getAttribute('position').getZ(v) + m.position.z;
    });
  }

  for (const glass of [false, true]) {
    it(`draws ${glass ? 'glass' : 'elements made see-through'} back to front once the view rests`, () => {
      const color = glass ? { r: 0.6, g: 0.8, b: 1, a: 0.3 } : undefined;
      // Three boxes in a row along z, far apart, arriving out of order.
      const { modelManager } = makeModelManager([
        { id: 'm', meshes: [boxMesh(1, { at: [0, 0, 20], color }), boxMesh(2, { at: [0, 0, -20], color }), boxMesh(3, { at: [0, 0, 0], color })] },
      ]);
      const batch = modelManager.getModel('m')!.batch;
      if (!glass) modelManager.setOpacity('m', [1, 2, 3], 0.25);

      const fromFront = cameraLookingAt([0, 0, 100], [0, 0, 0]);
      expect(batch.sortSeeThrough(fromFront, 0)).toBe(true); // a new view: wait for it to rest
      expect(batch.sortSeeThrough(fromFront, 50)).toBe(true);
      expect(batch.sortSeeThrough(fromFront, 50 + SEE_THROUGH_SETTLE_MS)).toBe(false);
      const front = drawOrderZ(batch);
      expect(front).toHaveLength(3);
      expect(front[0]).toBeLessThan(front[1]); // farthest (lowest z) first
      expect(front[1]).toBeLessThan(front[2]);

      const fromBehind = cameraLookingAt([0, 0, -100], [0, 0, 0]);
      batch.sortSeeThrough(fromBehind, 1000);
      // Moving keeps the last order…
      expect(drawOrderZ(batch)).toEqual(front);
      batch.sortSeeThrough(fromBehind, 1000 + SEE_THROUGH_SETTLE_MS);
      // …and the rested view gets its own.
      const behind = drawOrderZ(batch);
      expect(behind[0]).toBeGreaterThan(behind[1]);
      expect(behind[1]).toBeGreaterThan(behind[2]);
    });
  }
});

describe('ModelBatch — hidden elements cost nothing to draw', () => {
  /** Triangles each drawn chunk sends through the vertex stage. */
  function drawnTriangles(batch: ModelBatch): number {
    let n = 0;
    for (const mesh of batch.chunkMeshes()) {
      if (!mesh.visible) continue;
      const g = mesh.geometry;
      n += Math.min(g.drawRange.count, g.getIndex()!.count) / 3;
    }
    return n;
  }
  const grid = (count: number) => Array.from({ length: count }, (_, i) => boxMesh(i + 1, { at: [(i % 20) * 3, Math.floor(i / 20) * 3, 0] }));

  it('a chunk whose pieces are all hidden is not drawn; one mostly hidden draws only the rest', () => {
    const batch = new ModelBatch('m', { chunkVertexCap: 24 * 50 });
    batch.append(grid(400));
    batch.finish();
    const all = drawnTriangles(batch);
    expect(all).toBe(400 * 12);

    // Isolate a handful: almost nothing is sent any more.
    const keep = [1, 2, 3, 200, 399];
    batch.setHidden(Array.from({ length: 400 }, (_, i) => i + 1).filter((id) => !keep.includes(id)), true);
    expect(drawnTriangles(batch)).toBe(keep.length * 12);

    // Half the model, spatially: about half the work.
    batch.setHidden(Array.from({ length: 400 }, (_, i) => i + 1), false);
    batch.setHidden(Array.from({ length: 200 }, (_, i) => i + 1), true);
    expect(drawnTriangles(batch)).toBeLessThanOrEqual(220 * 12);

    // Everything back: the full chunks again.
    batch.setHidden(Array.from({ length: 400 }, (_, i) => i + 1), false);
    expect(drawnTriangles(batch)).toBe(all);
    expect(batch.chunkMeshes().every((m) => m.visible)).toBe(true);
  });

  it('still picks the elements left visible in a compacted chunk', () => {
    const scene = new THREE.Scene();
    const batch = new ModelBatch('m', { chunkVertexCap: 24 * 50 });
    batch.append(grid(400));
    batch.finish();
    scene.add(batch.group);
    batch.setHidden(Array.from({ length: 400 }, (_, i) => i + 1).filter((id) => id !== 77), true);
    const i = 76;
    const hit = pick(scene, new THREE.Vector3((i % 20) * 3, Math.floor(i / 20) * 3, 10), new THREE.Vector3(0, 0, -1));
    expect(elementOfHit(hit)).toEqual({ modelId: 'm', expressId: 77 });
  });

  it('pieces streamed in for an element that is already hidden stay out of the draw', () => {
    const hidden = Array.from({ length: 150 }, (_, i) => i + 1);
    const late = [boxMesh(10, { at: [100, 0, 0] }), ...grid(400).slice(150)];
    // Hidden while streaming: later pieces of a hidden element join hidden.
    const streamed = new ModelBatch('m', { chunkVertexCap: 24 * 50 });
    streamed.append(grid(150));
    streamed.setHidden(hidden, true);
    streamed.append(late);
    streamed.finish();
    // Hidden once everything is in.
    const after = new ModelBatch('m', { chunkVertexCap: 24 * 50 });
    after.append(grid(150));
    after.append(late);
    after.finish();
    after.setHidden(hidden, true);
    expect(drawnTriangles(streamed)).toBe(drawnTriangles(after));
    expect(drawnTriangles(after)).toBeLessThan(400 * 12);
  });
});

describe('ModelBatch — freeing memory', () => {
  it('removeModel disposes every geometry and material', () => {
    const { modelManager } = makeModelManager([
      { id: 'm', meshes: [boxMesh(1), boxMesh(2, { at: [2, 0, 0], color: { r: 1, g: 1, b: 1, a: 0.4 } })] },
    ]);
    modelManager.setOpacity('m', [1], 0.25); // creates an overlay too
    const entry = modelManager.getModel('m')!;
    const disposed = { geometries: 0, materials: new Set<THREE.Material>() };
    entry.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.addEventListener('dispose', () => disposed.geometries++);
        const m = o.material as THREE.Material;
        m.addEventListener('dispose', () => disposed.materials.add(m));
      }
    });
    const geometries = entry.group.children.length;
    modelManager.removeModel('m');
    expect(disposed.geometries).toBe(geometries);
    expect(disposed.materials.size).toBe(2);
  });
});
