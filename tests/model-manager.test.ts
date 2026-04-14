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
  return { id, meshes };
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
});
