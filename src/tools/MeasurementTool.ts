import * as THREE from 'three';
import type { Tool } from './Tool';
import { raycastVisible } from '../utils/raycast';
import {
  MeasurementStore,
  type SerializedMeasurement,
} from './MeasurementStore';
import { MeasurementRenderer } from './MeasurementRenderer';
import { measurementViews } from './measurementViews';
import { measurementCandidatesAt } from './measurementPicking';
import type { Candidate, ScreenPoint } from '../inspector/candidateMath';
import type { SelectionMode } from '../inspector/types';

export interface MeasurementToolDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /**
   * Optional render-on-demand hook. Called whenever the tool mutates
   * scene state (hover marker, preview line/label, committed measurement
   * groups). No-op if omitted.
   */
  requestRender?: () => void;
}

/**
 * Placing measurements.
 *
 * States:
 *   IDLE       — tool is not active
 *   PICK_START — crosshair cursor, waiting for click on a surface
 *   PICK_END   — start point placed, waiting for second click
 *
 * A "click" is a pointerdown + pointerup where the mouse moved < 3px,
 * so orbit drags never accidentally place points.
 *
 * Three things share the work and none reaches into another:
 * `MeasurementStore` decides what exists, what is selected and what is
 * visible; `MeasurementRenderer` owns every scene object; and this class owns
 * the pointer state machine and the public surface the app talks to. The
 * store's change event is the only route to a redraw, so add, delete, clear,
 * restore and model-hide all share one path and the visuals have one place to
 * drift from.
 */
export class MeasurementTool implements Tool {
  readonly name = 'measurement';

  private deps: MeasurementToolDeps;
  private mouse = new THREE.Vector2();

  /** What measurements exist, which is selected, which models hide them. */
  private store = new MeasurementStore();
  /** Every scene object. */
  private view: MeasurementRenderer;
  /** The measurement the cursor is over, per the candidate system. */
  private hoveredId: string | null = null;

  // State
  private pickingStart = false;
  private pickingEnd = false;
  private startPoint: THREE.Vector3 | null = null;
  private startModelId: string | null = null;

  // Click-vs-drag detection
  private pointerDownPos = { x: 0, y: 0 };
  private static readonly CLICK_THRESHOLD = 3; // px

  // Bound handlers
  private boundOnPointerDown: (e: PointerEvent) => void;
  private boundOnPointerUp: (e: PointerEvent) => void;
  private boundOnPointerMove: (e: PointerEvent) => void;
  private boundOnContextMenu: (e: MouseEvent) => void;

  constructor(deps: MeasurementToolDeps) {
    this.deps = deps;
    this.view = new MeasurementRenderer({
      scene: deps.scene,
      camera: deps.camera,
      canvas: deps.canvas,
    });
    this.boundOnPointerDown = this.onPointerDown.bind(this);
    this.boundOnPointerUp = this.onPointerUp.bind(this);
    this.boundOnPointerMove = this.onPointerMove.bind(this);
    this.boundOnContextMenu = this.onContextMenu.bind(this);
    this.store.onChange(() => this.draw());
  }

  activate(): void {
    this.enterPickStart();
  }

  deactivate(): void {
    this.removeListeners();
    this.clearPendingStart();
    this.view.hidePreview();
    this.view.hideHoverMarker();
    this.pickingStart = false;
    this.pickingEnd = false;
    this.startPoint = null;
    this.deps.canvas.style.cursor = '';
  }

  /** Call every frame to keep markers at constant screen size. */
  update(): void {
    this.view.updateScales();
  }

  // ── Measurement lifecycle (delegated to the store) ─────────

  /** Subscribe to measurement add / remove / select / visibility changes. */
  onStateChange(cb: () => void): () => void {
    return this.store.onChange(cb);
  }

  hasMeasurements(): boolean {
    return this.store.size() > 0;
  }

  /** Remove every measurement. Wired to "Clear measurements" and Reset View. */
  clearMeasurements(): void {
    this.store.clear();
    this.clearPendingStart();
    this.deps.requestRender?.();
  }

  /**
   * Apply a click to the measurement selection so `Delete` knows what to take.
   * `mode` is the element-selection vocabulary: plain click replaces, Ctrl/Cmd
   * toggles, Shift removes. `null` deselects everything.
   */
  selectMeasurement(id: string | null, mode: SelectionMode = 'replace'): void {
    this.store.applySelection(id, mode);
  }

  getSelectedMeasurementIds(): string[] {
    return this.store.getSelectedIds();
  }

  /** `Delete` / `Backspace` — takes every selected measurement in one go. */
  removeSelectedMeasurement(): boolean {
    return this.store.removeSelected();
  }

  /** D15 — a model went away, so its measurements go with it. */
  onModelRemoved(modelId: string): void {
    this.store.onModelRemoved(modelId);
  }

  /** D15 — a model was hidden or shown; its measurements follow. */
  setModelVisible(modelId: string, visible: boolean): void {
    this.store.setModelVisible(modelId, visible);
  }

  /** D6 — the session snapshot. */
  serialize(): SerializedMeasurement[] {
    return this.store.serialize();
  }

  /** D6 — restore, dropping any measurement whose models did not come back. */
  deserialize(entries: readonly SerializedMeasurement[], liveModelIds: ReadonlySet<string>): void {
    this.store.deserialize(entries, liveModelIds);
  }

  // ── Candidate system surface ───────────────────────────────

  /**
   * Measurements under the cursor, as candidates. Screen-space, not a raycast
   * — see `measurementPicking.ts` for why.
   */
  candidatesAt(cursor: ScreenPoint): Candidate[] {
    return measurementCandidatesAt(
      this.store.list(),
      cursor,
      this.deps.camera,
      { width: this.deps.canvas.clientWidth, height: this.deps.canvas.clientHeight },
      (record) => this.store.isVisible(record),
    );
  }

  /** Pre-highlight: `null` clears it. */
  setHovered(id: string | null): void {
    if (this.hoveredId === id) return;
    this.hoveredId = id;
    this.draw();
  }

  dispose(): void {
    this.deactivate();
    this.store.clear();
    // clear() only notifies when there was something to drop; tear the scene
    // down unconditionally so an empty store still releases its groups.
    this.view.dispose();
    this.store.dispose();
  }

  // ── Drawing ────────────────────────────────────────────────

  /**
   * Hand the renderer the current picture. The only place the scene is told
   * about committed measurements.
   */
  private draw(): void {
    // A measurement that no longer exists cannot still be hovered — otherwise
    // the id would linger and re-highlight if the same id ever returned.
    if (this.hoveredId && !this.store.get(this.hoveredId)) this.hoveredId = null;

    this.view.sync(
      measurementViews(this.store.list(), {
        isVisible: (record) => this.store.isVisible(record),
        isSelected: (id) => this.store.isSelected(id),
        hoveredId: this.hoveredId,
      }),
    );
    this.deps.requestRender?.();
  }

  // ── State transitions ──────────────────────────────────────

  private enterPickStart(): void {
    this.pickingStart = true;
    this.pickingEnd = false;
    this.startPoint = null;
    this.startModelId = null;
    this.deps.canvas.style.cursor = 'crosshair';
    this.addListeners();
  }

  private enterPickEnd(): void {
    this.pickingStart = false;
    this.pickingEnd = true;
  }

  private clearPendingStart(): void {
    this.view.hidePendingStart();
    this.startPoint = null;
    this.startModelId = null;
  }

  // ── Event listener management ──────────────────────────────

  private addListeners(): void {
    this.deps.canvas.addEventListener('pointerdown', this.boundOnPointerDown);
    this.deps.canvas.addEventListener('pointerup', this.boundOnPointerUp);
    this.deps.canvas.addEventListener('pointermove', this.boundOnPointerMove);
    this.deps.canvas.addEventListener('contextmenu', this.boundOnContextMenu);
  }

  private removeListeners(): void {
    this.deps.canvas.removeEventListener('pointerdown', this.boundOnPointerDown);
    this.deps.canvas.removeEventListener('pointerup', this.boundOnPointerUp);
    this.deps.canvas.removeEventListener('pointermove', this.boundOnPointerMove);
    this.deps.canvas.removeEventListener('contextmenu', this.boundOnContextMenu);
  }

  // ── Pointer handlers ───────────────────────────────────────

  private onPointerDown(e: PointerEvent): void {
    if (e.button === 0) {
      this.pointerDownPos = { x: e.clientX, y: e.clientY };
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button !== 0) return;

    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist >= MeasurementTool.CLICK_THRESHOLD) return; // was a drag, not a click

    this.updateMouse(e);
    const hit = raycastVisible(this.mouse, this.deps.camera, this.deps.scene, this.deps.renderer);
    if (!hit) return;

    const modelId = modelIdOf(hit.object);

    if (this.pickingStart) {
      this.startPoint = hit.point.clone();
      this.startModelId = modelId;
      this.view.showPendingStart(this.startPoint);
      this.enterPickEnd();
    } else if (this.pickingEnd && this.startPoint) {
      const modelIds = [this.startModelId, modelId].filter((id): id is string => id !== null);
      this.store.add(this.startPoint, hit.point, modelIds);
      this.clearPendingStart();
      this.view.hidePreview();
      this.enterPickStart();
    }
    this.deps.requestRender?.();
  }

  private onPointerMove(e: PointerEvent): void {
    this.updateMouse(e);
    const hit = raycastVisible(this.mouse, this.deps.camera, this.deps.scene, this.deps.renderer);

    if (hit) {
      this.view.showHoverMarker(hit.point);
    } else {
      this.view.hideHoverMarker();
    }

    if (this.pickingEnd && this.startPoint && hit) {
      this.view.showPreview(this.startPoint, hit.point);
    } else if (this.pickingEnd) {
      this.view.hidePreview();
    }
    // Hover marker and preview line track the cursor; every move mutates
    // scene state without touching the camera, so OrbitControls won't fire.
    this.deps.requestRender?.();
  }

  private onContextMenu(e: MouseEvent): void {
    if (this.pickingEnd) {
      // Right-click cancels the current start point, back to PICK_START
      e.preventDefault();
      this.clearPendingStart();
      this.view.hidePreview();
      this.pickingStart = true;
      this.pickingEnd = false;
      this.deps.requestRender?.();
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private updateMouse(e: MouseEvent): void {
    const rect = this.deps.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }
}

/**
 * The model a hit mesh belongs to. `ModelManager` names each model group with
 * the app's model UUID and parents the meshes directly under it, so the
 * parent's name is the id — the same lookup `SelectionManager.identityFromHit`
 * does. Null for anything not under a model group.
 */
function modelIdOf(object: THREE.Object3D): string | null {
  const parent = object.parent;
  return parent && parent.name ? parent.name : null;
}
