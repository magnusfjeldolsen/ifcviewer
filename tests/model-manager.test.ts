import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ModelManager } from '../src/viewer/ModelManager';
import type { ParsedModel } from '../src/parser/IfcParser';

// Identity 4x4 matrix as flat array
const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

function createMockParsedModel(id: string, meshCount = 2): ParsedModel {
  const meshes = Array.from({ length: meshCount }, (_, i) => ({
    expressID: i + 1,
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    transform: IDENTITY,
    color: { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
  }));
  return { id, modelID: 1, meshes };
}

describe('ModelManager', () => {
  it('should add a model to the scene', () => {
    const scene = new THREE.Scene();
    const manager = new ModelManager(scene);
    const parsed = createMockParsedModel('test-model');

    const entry = manager.addModel(parsed);

    expect(entry.id).toBe('test-model');
    expect(entry.visible).toBe(true);
    expect(entry.group.children).toHaveLength(2);
    expect(scene.children).toContain(entry.group);
  });

  it('should remove a model from the scene', () => {
    const scene = new THREE.Scene();
    const manager = new ModelManager(scene);
    manager.addModel(createMockParsedModel('m1'));

    const removed = manager.removeModel('m1');

    expect(removed).toBe(true);
    expect(manager.getModel('m1')).toBeUndefined();
  });

  it('should return false when removing non-existent model', () => {
    const scene = new THREE.Scene();
    const manager = new ModelManager(scene);

    expect(manager.removeModel('nope')).toBe(false);
  });

  it('should toggle model visibility', () => {
    const scene = new THREE.Scene();
    const manager = new ModelManager(scene);
    manager.addModel(createMockParsedModel('m1'));

    manager.setVisible('m1', false);
    const entry = manager.getModel('m1');
    expect(entry?.visible).toBe(false);
    expect(entry?.group.visible).toBe(false);

    manager.setVisible('m1', true);
    expect(manager.getModel('m1')?.visible).toBe(true);
  });

  it('should manage multiple models independently', () => {
    const scene = new THREE.Scene();
    const manager = new ModelManager(scene);

    manager.addModel(createMockParsedModel('m1', 1));
    manager.addModel(createMockParsedModel('m2', 3));

    expect(manager.getAllModels()).toHaveLength(2);
    expect(manager.getModel('m1')?.group.children).toHaveLength(1);
    expect(manager.getModel('m2')?.group.children).toHaveLength(3);

    manager.removeModel('m1');
    expect(manager.getAllModels()).toHaveLength(1);
    expect(manager.getModel('m2')).toBeDefined();
  });

  it('should replace model when adding with same id', () => {
    const scene = new THREE.Scene();
    const manager = new ModelManager(scene);

    manager.addModel(createMockParsedModel('m1', 1));
    manager.addModel(createMockParsedModel('m1', 5));

    expect(manager.getAllModels()).toHaveLength(1);
    expect(manager.getModel('m1')?.group.children).toHaveLength(5);
  });

  it('should compute bounding box', () => {
    const scene = new THREE.Scene();
    const manager = new ModelManager(scene);
    manager.addModel(createMockParsedModel('m1'));

    const box = manager.getBoundingBox();
    expect(box.isEmpty()).toBe(false);
  });

  it('should clear all models', () => {
    const scene = new THREE.Scene();
    const manager = new ModelManager(scene);
    manager.addModel(createMockParsedModel('m1'));
    manager.addModel(createMockParsedModel('m2'));

    manager.clear();

    expect(manager.getAllModels()).toHaveLength(0);
  });

  it('builds a meshesByExpressId index covering every mesh', () => {
    const scene = new THREE.Scene();
    const manager = new ModelManager(scene);
    // createMockParsedModel uses sequential expressIDs starting at 1, so a
    // 5-mesh model has IDs 1..5, each mapping to exactly one mesh.
    const entry = manager.addModel(createMockParsedModel('m1', 5));

    expect(entry.meshesByExpressId.size).toBe(5);
    for (let id = 1; id <= 5; id++) {
      const bucket = entry.meshesByExpressId.get(id);
      expect(bucket).toBeDefined();
      expect(bucket).toHaveLength(1);
      // The bucketed mesh must be the same THREE.Mesh that's in the group.
      expect(entry.group.children).toContain(bucket![0]);
      expect(bucket![0].userData.expressID).toBe(id);
    }
  });

  describe('material sharing by color', () => {
    // Helper: a ParsedModel with arbitrary per-mesh colors. We control
    // colors per-mesh so each test can assert which meshes should (or
    // shouldn't) share a material instance.
    function modelWithColors(
      id: string,
      colors: Array<{ r: number; g: number; b: number; a: number }>,
    ): ParsedModel {
      return {
        id,
        modelID: 1,
        meshes: colors.map((color, i) => ({
          expressID: i + 1,
          vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          indices: new Uint32Array([0, 1, 2]),
          transform: IDENTITY,
          color,
        })),
      };
    }

    it('reuses a single material for meshes that share a color', () => {
      const scene = new THREE.Scene();
      const manager = new ModelManager(scene);
      // 3 meshes, 2 of which share the same color.
      const parsed = modelWithColors('m1', [
        { r: 0.5, g: 0.5, b: 0.5, a: 1.0 }, // A
        { r: 0.5, g: 0.5, b: 0.5, a: 1.0 }, // A (same as above)
        { r: 0.2, g: 0.7, b: 0.1, a: 1.0 }, // B
      ]);

      const entry = manager.addModel(parsed);
      const meshes = entry.group.children as THREE.Mesh[];

      // The two same-colored meshes must share the same material instance.
      expect(meshes[0].material).toBe(meshes[1].material);
      // The third mesh has a distinct color → distinct material instance.
      expect(meshes[0].material).not.toBe(meshes[2].material);

      // Across the group, exactly 2 unique material refs.
      const uniqueMaterials = new Set(meshes.map((m) => m.material));
      expect(uniqueMaterials.size).toBe(2);
    });

    it('treats different alpha as a different material', () => {
      // Two meshes with identical RGB but different alpha. The cache key
      // includes alpha, so they must get distinct materials. (This also
      // matters because `transparent: c.a < 1` flips between the two.)
      const scene = new THREE.Scene();
      const manager = new ModelManager(scene);
      const parsed = modelWithColors('m1', [
        { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
        { r: 0.5, g: 0.5, b: 0.5, a: 0.5 },
      ]);

      const entry = manager.addModel(parsed);
      const meshes = entry.group.children as THREE.Mesh[];

      expect(meshes[0].material).not.toBe(meshes[1].material);
      const opaque = meshes[0].material as THREE.MeshPhongMaterial;
      const translucent = meshes[1].material as THREE.MeshPhongMaterial;
      expect(opaque.transparent).toBe(false);
      expect(translucent.transparent).toBe(true);
    });

    it('does not share materials across separate addModel calls', () => {
      // Each addModel call has its own materialCache, so two models with
      // the same color produce distinct material instances. This is what
      // keeps removeModel's dispose loop safe: no cross-model references.
      const scene = new THREE.Scene();
      const manager = new ModelManager(scene);
      const color = { r: 0.3, g: 0.6, b: 0.9, a: 1.0 };

      const a = manager.addModel(modelWithColors('a', [color]));
      const b = manager.addModel(modelWithColors('b', [color]));

      const matA = (a.group.children[0] as THREE.Mesh).material;
      const matB = (b.group.children[0] as THREE.Mesh).material;
      expect(matA).not.toBe(matB);
    });

    it('removeModel disposes each unique material once, not once per mesh', () => {
      // With material sharing, the dispose loop must dedupe — otherwise a
      // 17k-mesh model with 30 distinct materials would call dispose()
      // 17k times instead of 30. dispose() is idempotent in three, but
      // the count is meaningful: it asserts removeModel still walks the
      // tree and frees every distinct material exactly once.
      const scene = new THREE.Scene();
      const manager = new ModelManager(scene);
      const parsed = modelWithColors('m1', [
        { r: 0.5, g: 0.5, b: 0.5, a: 1.0 }, // A
        { r: 0.5, g: 0.5, b: 0.5, a: 1.0 }, // A
        { r: 0.5, g: 0.5, b: 0.5, a: 1.0 }, // A
        { r: 0.2, g: 0.7, b: 0.1, a: 1.0 }, // B
        { r: 0.2, g: 0.7, b: 0.1, a: 1.0 }, // B
      ]);
      const entry = manager.addModel(parsed);

      // Collect the unique materials before remove, then spy on dispose.
      const uniqueMaterials = Array.from(
        new Set((entry.group.children as THREE.Mesh[]).map((m) => m.material as THREE.Material)),
      );
      expect(uniqueMaterials).toHaveLength(2);

      const disposeCounts = uniqueMaterials.map((m) => {
        let count = 0;
        const original = m.dispose.bind(m);
        m.dispose = () => {
          count++;
          original();
        };
        return () => count;
      });

      const removed = manager.removeModel('m1');
      expect(removed).toBe(true);

      // Each unique material disposed exactly once, despite being shared
      // by multiple meshes.
      for (const getCount of disposeCounts) {
        expect(getCount()).toBe(1);
      }
    });

    it('preserves the meshesByExpressId index when materials are shared', () => {
      // Regression guard: the material cache is an addition to addModel;
      // the per-expressID bucket map from PR #21 must still cover every
      // mesh, including ones whose materials are shared with siblings.
      const scene = new THREE.Scene();
      const manager = new ModelManager(scene);
      const parsed = modelWithColors('m1', [
        { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
        { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
        { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
      ]);
      const entry = manager.addModel(parsed);

      // 3 meshes → 3 expressIDs (1..3), each bucket points at the right mesh.
      expect(entry.meshesByExpressId.size).toBe(3);
      for (let id = 1; id <= 3; id++) {
        const bucket = entry.meshesByExpressId.get(id);
        expect(bucket).toBeDefined();
        expect(bucket).toHaveLength(1);
        expect(bucket![0].userData.expressID).toBe(id);
        expect(entry.group.children).toContain(bucket![0]);
      }
    });
  });

  it('buckets multiple meshes that share an expressID under one key', () => {
    // IFC elements can decompose into multiple geometries; the index must
    // collect all of them so SelectionManager.highlightExpress hits every
    // mesh that belongs to a given element.
    const scene = new THREE.Scene();
    const manager = new ModelManager(scene);
    const sharedExpressId = 42;
    const parsed: ParsedModel = {
      id: 'shared',
      modelID: 1,
      meshes: [
        {
          expressID: sharedExpressId,
          vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          indices: new Uint32Array([0, 1, 2]),
          transform: IDENTITY,
          color: { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
        },
        {
          expressID: sharedExpressId,
          vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          indices: new Uint32Array([0, 1, 2]),
          transform: IDENTITY,
          color: { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
        },
      ],
    };
    const entry = manager.addModel(parsed);

    expect(entry.meshesByExpressId.size).toBe(1);
    const bucket = entry.meshesByExpressId.get(sharedExpressId);
    expect(bucket).toHaveLength(2);
  });
});
