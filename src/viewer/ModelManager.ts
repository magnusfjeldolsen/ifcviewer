import * as THREE from 'three';
import type { ParsedMesh, ParsedModel } from '../parser/types';
import { ModelBatch, SEE_THROUGH_SETTLE_MS, type ElementDrawState, type ModelBatchOptions } from './ModelBatch';

export interface ModelEntry {
  id: string;
  /** The model's scene node: hide it to hide the whole model. */
  group: THREE.Group;
  visible: boolean;
  /** What is drawn for this model, and the per-element appearance API. */
  batch: ModelBatch;
}

/** An element in a loaded model. */
export interface ElementRef {
  modelId: string;
  expressId: number;
}

/**
 * Owns every loaded model and what is drawn for it.
 *
 * Each model is one `ModelBatch`: its pieces merged into a few dozen chunk
 * meshes, with per-element colour, opacity, visibility and highlight held in
 * a texture rather than in per-mesh materials. Consumers talk about elements
 * — `(modelId, expressId)` — and never see meshes or materials:
 *
 * - `setHidden` / `setOpacity` / `setColor` / `setHighlighted` take a model
 *   and a list of expressIDs, so colouring or filtering tens of thousands of
 *   elements is one call.
 * - `getBoundingBox` and `forEachVisiblePiece` answer framing and marquee
 *   questions; `elementOfHit` (in ModelBatch) resolves a raycast hit.
 */
export class ModelManager {
  private scene: THREE.Scene;
  private models = new Map<string, ModelEntry>();
  /** Models whose streamed load is still open. */
  private streams = new Set<string>();
  /**
   * Optional render-on-demand hook. Called when models are added /
   * removed / hidden / shown, since those changes happen without any
   * camera movement and therefore won't trip OrbitControls' 'change' event.
   */
  private requestRender: (() => void) | null;
  private batchOptions: ModelBatchOptions;

  constructor(scene: THREE.Scene, requestRender?: () => void, batchOptions: ModelBatchOptions = {}) {
    this.scene = scene;
    this.requestRender = requestRender ?? null;
    this.batchOptions = batchOptions;
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
   * Start a streamed load: create the model, add it to the scene empty, and
   * register an entry. Meshes are then delivered in batches via
   * `appendMeshes`, and the stream is closed with `endStream`. Lets the
   * scene fill progressively during a long parse instead of appearing all
   * at once.
   */
  beginStream(id: string): ModelEntry {
    // Replace any existing model with this id.
    if (this.models.has(id)) {
      this.removeModel(id);
    }
    const batch = new ModelBatch(id, this.batchOptions);
    const entry: ModelEntry = { id, group: batch.group, visible: true, batch };
    this.scene.add(batch.group);
    this.models.set(id, entry);
    this.streams.add(id);
    // No requestRender here: an empty group has nothing to draw. The first
    // appendMeshes call requests the render once there is geometry.
    return entry;
  }

  /**
   * Append a batch of meshes to an in-progress streamed load. No-op if
   * there is no active stream for `id`.
   */
  appendMeshes(id: string, meshes: ParsedMesh[]): void {
    if (!this.streams.has(id)) return;
    const entry = this.models.get(id);
    if (!entry) return;
    entry.batch.append(meshes);
    if (meshes.length > 0) this.requestRender?.();
  }

  /**
   * Close a streamed load. Returns the finished entry (or undefined if no
   * stream was open for `id`).
   */
  endStream(id: string): ModelEntry | undefined {
    if (!this.streams.delete(id)) return undefined;
    const entry = this.models.get(id);
    entry?.batch.finish();
    this.requestRender?.();
    return entry;
  }

  removeModel(id: string): boolean {
    // Drop any in-progress stream first so a later appendMeshes can't add
    // meshes to a model we are about to dispose.
    this.streams.delete(id);

    const entry = this.models.get(id);
    if (!entry) return false;

    this.scene.remove(entry.group);
    entry.batch.dispose();

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

  /** Geometry pieces loaded across all models. */
  pieceCount(): number {
    let n = 0;
    for (const entry of this.models.values()) n += entry.batch.pieceCount;
    return n;
  }

  // ── Elements ───────────────────────────────────────────────

  /** Every element with geometry in a model (empty when the model is not loaded). */
  elementIds(modelId: string): number[] {
    const entry = this.models.get(modelId);
    return entry ? Array.from(entry.batch.elementIds()) : [];
  }

  hasElement(modelId: string, expressId: number): boolean {
    return this.models.get(modelId)?.batch.hasElement(expressId) ?? false;
  }

  /** How an element is drawn right now, or null if it is not loaded. */
  getElementState(modelId: string, expressId: number): ElementDrawState | null {
    return this.models.get(modelId)?.batch.elementState(expressId) ?? null;
  }

  /** Hide or show elements of one model. */
  setHidden(modelId: string, expressIds: Iterable<number>, hidden: boolean): void {
    this.apply(modelId, (b) => b.setHidden(expressIds, hidden));
  }

  /** Override the opacity of elements of one model; `null` restores their own. */
  setOpacity(modelId: string, expressIds: Iterable<number>, opacity: number | null): void {
    this.apply(modelId, (b) => b.setOpacity(expressIds, opacity));
  }

  /** Override the colour (linear RGB) of elements of one model; `null` restores their own. */
  setColor(
    modelId: string,
    expressIds: Iterable<number>,
    color: { r: number; g: number; b: number } | null,
  ): void {
    this.apply(modelId, (b) => b.setColor(expressIds, color));
  }

  /**
   * Colour elements of one model by data, each its own colour (see
   * `ModelBatch.setDataColors`): `rgba` holds linear RGBA per element, NaN
   * for none; an alpha below 1 ghosts the element. Drawn above any colour
   * override, which `clearDataColors` restores.
   */
  setDataColors(modelId: string, expressIds: ArrayLike<number>, rgba: Float32Array): void {
    this.apply(modelId, (b) => b.setDataColors(expressIds, rgba));
  }

  /** Remove every data colour of one model. */
  clearDataColors(modelId: string): void {
    this.apply(modelId, (b) => b.clearDataColors());
  }

  /** Turn the selection highlight on or off for elements of one model. */
  setHighlighted(modelId: string, expressIds: Iterable<number>, highlighted: boolean): void {
    this.apply(modelId, (b) => b.setHighlighted(expressIds, highlighted));
  }

  /** World-space bounds of the given elements, hidden or not. */
  getElementsBoundingBox(elements: Iterable<ElementRef>): THREE.Box3 {
    const byModel = new Map<string, number[]>();
    for (const { modelId, expressId } of elements) {
      let list = byModel.get(modelId);
      if (!list) byModel.set(modelId, (list = []));
      list.push(expressId);
    }
    const box = new THREE.Box3();
    for (const [modelId, ids] of byModel) this.models.get(modelId)?.batch.expandByElements(ids, box);
    return box;
  }

  /**
   * Visit every piece that is drawn — in a visible model and not hidden —
   * with its world-space box. One element can have several pieces.
   */
  forEachVisiblePiece(visit: (modelId: string, expressId: number, worldBox: THREE.Box3) => void): void {
    for (const entry of this.models.values()) {
      if (!entry.visible) continue;
      entry.batch.forEachVisiblePiece((expressId, box) => visit(entry.id, expressId, box));
    }
  }

  /**
   * Bounding box of the loaded geometry — fit-to-VISIBLE. Hidden elements
   * and hidden models are excluded so "Fit" frames what the user can
   * actually see.
   *
   * When `id` is given, that single model's visible elements are framed
   * regardless of the model's own `visible` flag (callers ask for a specific
   * model to frame it). When omitted, only visible models contribute.
   */
  getBoundingBox(id?: string): THREE.Box3 {
    const box = new THREE.Box3();
    if (id) {
      this.models.get(id)?.batch.expandByVisible(box);
    } else {
      for (const entry of this.models.values()) {
        if (entry.visible) entry.batch.expandByVisible(box);
      }
    }
    return box;
  }

  /**
   * Order see-through drawing back to front for `camera`; call before each
   * frame. Asks for one more frame once the view has rested, when the
   * pieces inside the see-through draws get sorted too (see
   * `ModelBatch.sortSeeThrough`).
   */
  sortSeeThrough(camera: THREE.Camera): void {
    const now = performance.now();
    let later = false;
    for (const entry of this.models.values()) {
      if (entry.visible && entry.batch.sortSeeThrough(camera, now)) later = true;
    }
    if (later && !this.seeThroughTimer) {
      this.seeThroughTimer = setTimeout(() => {
        this.seeThroughTimer = null;
        this.requestRender?.();
      }, SEE_THROUGH_SETTLE_MS + 10);
    }
  }

  private seeThroughTimer: ReturnType<typeof setTimeout> | null = null;

  clear(): void {
    for (const id of Array.from(this.models.keys())) {
      this.removeModel(id);
    }
  }

  dispose(): void {
    this.clear();
  }

  private apply(modelId: string, change: (batch: ModelBatch) => void): void {
    const entry = this.models.get(modelId);
    if (!entry) return;
    change(entry.batch);
    this.requestRender?.();
  }
}
