import * as THREE from 'three';
import type { ParsedModel } from '../parser/IfcParser';

export interface ModelEntry {
  id: string;
  group: THREE.Group;
  visible: boolean;
  /**
   * Index from expressID to all meshes in `group` that carry that ID.
   *
   * Built once at `addModel` and read by SelectionManager (and any future
   * code that needs to look up meshes for an element). Without this index,
   * highlight of N elements is O(N x meshCount); with it, it's O(N + hits).
   * On a 100k-mesh model that's the difference between 10+ seconds and
   * sub-100ms when selecting tens of thousands of elements via marquee.
   */
  meshesByExpressId: Map<number, THREE.Mesh[]>;
}

export class ModelManager {
  private scene: THREE.Scene;
  private models = new Map<string, ModelEntry>();
  /**
   * Optional render-on-demand hook. Called when models are added /
   * removed / hidden / shown, since those changes happen without any
   * camera movement and therefore won't trip OrbitControls' 'change' event.
   */
  private requestRender: (() => void) | null;

  constructor(scene: THREE.Scene, requestRender?: () => void) {
    this.scene = scene;
    this.requestRender = requestRender ?? null;
  }

  addModel(parsed: ParsedModel): ModelEntry {
    // Remove existing model with same id
    if (this.models.has(parsed.id)) {
      this.removeModel(parsed.id);
    }

    const group = new THREE.Group();
    group.name = parsed.id;

    const meshesByExpressId = new Map<number, THREE.Mesh[]>();

    // Per-call material cache, keyed by stringified RGBA. Reusing one
    // MeshPhongMaterial across every mesh that shares a color (a) shrinks
    // material count from ~mesh-count to a few dozen on real IFC models,
    // cutting WebGL state changes between draws — the main cause of the
    // orbit / pan / zoom lag the user reported after PR #21 made selection
    // fast — and (b) shrinks the SelectionManager.highlightVariants pool
    // proportionally (it's a WeakMap<Material, Material> keyed by the
    // original material reference; shared originals → shared variants).
    // Cache is local to one addModel call so different models keep their
    // own material instances, which keeps removeModel's dispose loop safe:
    // no model references another model's materials.
    const materialCache = new Map<string, THREE.MeshPhongMaterial>();

    for (const mesh of parsed.meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      // Bounding box is computed lazily by MarqueeSelector.classifyMesh on
      // first use. Eager computeBoundingBox here cost ~1-3s on a 100k-mesh
      // model load for no benefit when no marquee runs; the first marquee
      // pays the cost (~50-200ms) instead. Net win on load.

      const c = mesh.color;
      // toFixed(6) gives a stable key: the parser emits doubles, and two
      // meshes that should share a color must produce the same string.
      // Six decimals is well below the 8-bit sRGB precision of a real
      // GPU upload while still being far inside double-precision noise.
      const matKey = `${c.r.toFixed(6)},${c.g.toFixed(6)},${c.b.toFixed(6)},${c.a.toFixed(6)}`;
      let material = materialCache.get(matKey);
      if (!material) {
        material = new THREE.MeshPhongMaterial({
          color: new THREE.Color(c.r, c.g, c.b),
          opacity: c.a,
          transparent: c.a < 1,
          side: THREE.DoubleSide,
        });
        materialCache.set(matKey, material);
      }

      const threeMesh = new THREE.Mesh(geometry, material);
      threeMesh.userData.expressID = mesh.expressID;

      // Apply the placement transform from web-ifc
      const matrix = new THREE.Matrix4();
      matrix.fromArray(mesh.transform);
      threeMesh.applyMatrix4(matrix);

      group.add(threeMesh);

      // Populate the per-element index. One expressID can map to multiple
      // meshes (an IFC element can decompose into several geometry parts).
      let bucket = meshesByExpressId.get(mesh.expressID);
      if (!bucket) {
        bucket = [];
        meshesByExpressId.set(mesh.expressID, bucket);
      }
      bucket.push(threeMesh);
    }

    this.scene.add(group);

    const entry: ModelEntry = { id: parsed.id, group, visible: true, meshesByExpressId };
    this.models.set(parsed.id, entry);
    this.requestRender?.();

    return entry;
  }

  removeModel(id: string): boolean {
    const entry = this.models.get(id);
    if (!entry) return false;

    this.scene.remove(entry.group);
    // Materials are shared across meshes within a model (see addModel's
    // materialCache), so dedupe before disposing. THREE.Material.dispose()
    // is idempotent — calling it twice is harmless — but deduping is the
    // honest accounting and keeps the dispose count meaningful in tests.
    const seenMaterials = new Set<THREE.Material>();
    entry.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (!seenMaterials.has(m)) {
            seenMaterials.add(m);
            m.dispose();
          }
        }
      }
    });

    this.models.delete(id);
    this.requestRender?.();
    return true;
  }

  setVisible(id: string, visible: boolean): boolean {
    const entry = this.models.get(id);
    if (!entry) return false;

    entry.group.visible = visible;
    entry.visible = visible;
    this.requestRender?.();
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
