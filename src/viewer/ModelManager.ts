import * as THREE from 'three';
import type { ParsedMesh, ParsedModel } from '../parser/types';

export interface ModelEntry {
  id: string;
  group: THREE.Group;
  visible: boolean;
  /**
   * Index from expressID to all meshes in `group` that carry that ID.
   *
   * Built incrementally as meshes are added (`addModel`, or `appendMeshes`
   * during a streamed load) and read by SelectionManager (and any future
   * code that needs to look up meshes for an element). Without this index,
   * highlight of N elements is O(N x meshCount); with it, it's O(N + hits).
   * On a 100k-mesh model that's the difference between 10+ seconds and
   * sub-100ms when selecting tens of thousands of elements via marquee.
   */
  meshesByExpressId: Map<number, THREE.Mesh[]>;
}

/**
 * Per-model state held only while a streamed load is in progress
 * (`beginStream` .. `endStream`).
 *
 * `materialCache` is keyed by stringified RGBA. Reusing one
 * MeshPhongMaterial across every mesh that shares a color (a) shrinks
 * material count from ~mesh-count to a few dozen on real IFC models,
 * cutting WebGL state changes between draws, and (b) shrinks the
 * SelectionManager.highlightVariants pool proportionally (a
 * WeakMap<Material, Material> keyed by the original material reference;
 * shared originals -> shared variants).
 *
 * The cache is scoped to ONE model. Different models keep their own
 * material instances, which keeps removeModel's dispose loop safe: no
 * model references another model's materials.
 */
interface StreamState {
  entry: ModelEntry;
  materialCache: Map<string, THREE.MeshPhongMaterial>;
}

export class ModelManager {
  private scene: THREE.Scene;
  private models = new Map<string, ModelEntry>();
  /**
   * In-progress streamed loads, keyed by model id. Populated by
   * `beginStream`, consumed by `appendMeshes`, cleared by `endStream`
   * (and by `removeModel`, in case a model is removed mid-stream).
   */
  private streams = new Map<string, StreamState>();
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

  /**
   * Add a fully-parsed model in one call. Equivalent to `beginStream` +
   * `appendMeshes(all)` + `endStream`; used by callers that already hold
   * the complete mesh list (session restore, resetView, geometry-cache
   * hydration).
   */
  addModel(parsed: ParsedModel): ModelEntry {
    const entry = this.beginStream(parsed.id);
    this.appendMeshes(parsed.id, parsed.meshes);
    this.endStream(parsed.id);
    return entry;
  }

  /**
   * Start a streamed load: create the model's group, add it to the scene
   * empty, and register an entry. Meshes are then delivered in batches via
   * `appendMeshes`, and the stream is closed with `endStream`. Lets the
   * scene fill progressively during a long parse instead of appearing all
   * at once.
   */
  beginStream(id: string): ModelEntry {
    // Replace any existing model with this id.
    if (this.models.has(id)) {
      this.removeModel(id);
    }
    // Drop a stale in-progress stream for the same id, if any.
    this.streams.delete(id);

    const group = new THREE.Group();
    group.name = id;
    const entry: ModelEntry = {
      id,
      group,
      visible: true,
      meshesByExpressId: new Map(),
    };
    this.scene.add(group);
    this.models.set(id, entry);
    this.streams.set(id, { entry, materialCache: new Map() });
    // No requestRender here: an empty group has nothing to draw. The first
    // appendMeshes call requests the render once there is geometry.
    return entry;
  }

  /**
   * Append a batch of meshes to an in-progress streamed load. No-op if
   * there is no active stream for `id`.
   */
  appendMeshes(id: string, meshes: ParsedMesh[]): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    for (const mesh of meshes) {
      this.buildMesh(stream, mesh);
    }
    if (meshes.length > 0) this.requestRender?.();
  }

  /**
   * Close a streamed load. Returns the finished entry (or undefined if no
   * stream was open for `id`). Drops the per-stream material cache — the
   * materials themselves stay alive, referenced by the meshes.
   */
  endStream(id: string): ModelEntry | undefined {
    const stream = this.streams.get(id);
    this.streams.delete(id);
    return stream?.entry;
  }

  removeModel(id: string): boolean {
    // Drop any in-progress stream first so a later appendMeshes can't add
    // meshes to a group we are about to dispose.
    this.streams.delete(id);

    const entry = this.models.get(id);
    if (!entry) return false;

    this.scene.remove(entry.group);
    // Materials are shared across meshes within a model (see StreamState's
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

  // ── Internals ──────────────────────────────────────────────

  /**
   * Build one THREE.Mesh from a ParsedMesh and add it to the stream's
   * group plus the per-element index. Reuses a cached material when
   * another mesh in the same model already used the same RGBA color.
   */
  private buildMesh(stream: StreamState, mesh: ParsedMesh): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    // Bounding box is computed lazily by MarqueeSelector.classifyMesh on
    // first use. Eager computeBoundingBox here cost ~1-3s on a 100k-mesh
    // model load for no benefit when no marquee runs; the first marquee
    // pays the cost (~50-200ms) instead.

    const c = mesh.color;
    // toFixed(6) gives a stable key: the parser emits doubles, and two
    // meshes that should share a color must produce the same string.
    // Six decimals is well below the 8-bit sRGB precision of a real GPU
    // upload while still being far inside double-precision noise.
    const matKey = `${c.r.toFixed(6)},${c.g.toFixed(6)},${c.b.toFixed(6)},${c.a.toFixed(6)}`;
    let material = stream.materialCache.get(matKey);
    if (!material) {
      material = new THREE.MeshPhongMaterial({
        color: new THREE.Color(c.r, c.g, c.b),
        opacity: c.a,
        transparent: c.a < 1,
        side: THREE.DoubleSide,
      });
      stream.materialCache.set(matKey, material);
    }

    const threeMesh = new THREE.Mesh(geometry, material);
    threeMesh.userData.expressID = mesh.expressID;

    // Apply the placement transform from web-ifc
    const matrix = new THREE.Matrix4();
    matrix.fromArray(mesh.transform);
    threeMesh.applyMatrix4(matrix);

    stream.entry.group.add(threeMesh);

    // Populate the per-element index. One expressID can map to multiple
    // meshes (an IFC element can decompose into several geometry parts).
    let bucket = stream.entry.meshesByExpressId.get(mesh.expressID);
    if (!bucket) {
      bucket = [];
      stream.entry.meshesByExpressId.set(mesh.expressID, bucket);
    }
    bucket.push(threeMesh);
  }
}
