import * as THREE from 'three';
import type { ParsedModel } from '../parser/IfcParser';

export interface ModelEntry {
  id: string;
  group: THREE.Group;
  visible: boolean;
}

export class ModelManager {
  private scene: THREE.Scene;
  private models = new Map<string, ModelEntry>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  addModel(parsed: ParsedModel): ModelEntry {
    // Remove existing model with same id
    if (this.models.has(parsed.id)) {
      this.removeModel(parsed.id);
    }

    const group = new THREE.Group();
    group.name = parsed.id;

    for (const mesh of parsed.meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      // Pre-compute the local bounding box once: marquee selection reads
      // mesh.geometry.boundingBox on every classify call (10k+ meshes), and
      // an unset boundingBox forces an O(verts) computation on first hit.
      geometry.computeBoundingBox();

      const material = new THREE.MeshPhongMaterial({
        color: new THREE.Color(mesh.color.r, mesh.color.g, mesh.color.b),
        opacity: mesh.color.a,
        transparent: mesh.color.a < 1,
        side: THREE.DoubleSide,
      });

      const threeMesh = new THREE.Mesh(geometry, material);
      threeMesh.userData.expressID = mesh.expressID;

      // Apply the placement transform from web-ifc
      const matrix = new THREE.Matrix4();
      matrix.fromArray(mesh.transform);
      threeMesh.applyMatrix4(matrix);

      group.add(threeMesh);
    }

    this.scene.add(group);

    const entry: ModelEntry = { id: parsed.id, group, visible: true };
    this.models.set(parsed.id, entry);

    return entry;
  }

  removeModel(id: string): boolean {
    const entry = this.models.get(id);
    if (!entry) return false;

    this.scene.remove(entry.group);
    entry.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });

    this.models.delete(id);
    return true;
  }

  setVisible(id: string, visible: boolean): boolean {
    const entry = this.models.get(id);
    if (!entry) return false;

    entry.group.visible = visible;
    entry.visible = visible;
    return true;
  }

  getModel(id: string): ModelEntry | undefined {
    return this.models.get(id);
  }

  getAllModels(): ModelEntry[] {
    return Array.from(this.models.values());
  }

  getModelIds(): string[] {
    return Array.from(this.models.keys());
  }

  getBoundingBox(id?: string): THREE.Box3 {
    const box = new THREE.Box3();

    if (id) {
      const entry = this.models.get(id);
      if (entry) box.expandByObject(entry.group);
    } else {
      for (const entry of this.models.values()) {
        if (entry.visible) box.expandByObject(entry.group);
      }
    }

    return box;
  }

  clear(): void {
    for (const id of this.models.keys()) {
      this.removeModel(id);
    }
  }

  dispose(): void {
    this.clear();
  }
}
