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
import type { SnapTarget } from './snapCandidates';
import { resolveMeasurement, type SnapPoint } from './measureMath';
import type { MeasurementEnd } from './MeasurementStore';
import { SnapCursor, endFrom, modelIdOf } from './SnapCursor';
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
  /**
   * Show the user a short message. Used for the one thing this tool can
   * refuse: two surfaces that are not parallel have no single distance
   * between them, and saying so is the whole point of refusing.
   */
  onMessage?: (message: string) => void;
  /**
   * Whether snapping is on. Read on every resolve rather than cached, so the
   * `S` toggle takes effect on the next pointer move without the tool having
   * to subscribe to anything.
   */
  snappingEnabled?: () => boolean;
  /** Which targets are currently offered. Omitted means all of them. */
  allowedSnapTargets?: () => ReadonlySet<SnapTarget>;
  /** Flip one target on or off. The app persists it and reports what happened. */
  onToggleSnapTarget?: (target: SnapTarget) => void;
  /** Called when `S` flips snapping, so the app can persist and report it. */
  onToggleSnapping?: () => void;
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

  /** What the cursor is snapped to — shared with every tool that places a point. */
  private snap: SnapCursor;
  /** The first end, once placed: where it is and whether it caught a surface. */
  private startSnap: SnapPoint | null = null;
  private startEnd: MeasurementEnd | null = null;
  private boundOnKeyDown: (e: KeyboardEvent) => void;

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
    this.boundOnKeyDown = this.onKeyDown.bind(this);
    this.snap = new SnapCursor(deps);
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
    this.startSnap = null;
    this.startEnd = null;
  }

  // ── Event listener management ──────────────────────────────

  private addListeners(): void {
    this.deps.canvas.addEventListener('pointerdown', this.boundOnPointerDown);
    this.deps.canvas.addEventListener('pointerup', this.boundOnPointerUp);
    this.deps.canvas.addEventListener('pointermove', this.boundOnPointerMove);
    this.deps.canvas.addEventListener('contextmenu', this.boundOnContextMenu);
    window.addEventListener('keydown', this.boundOnKeyDown);
  }

  private removeListeners(): void {
    this.deps.canvas.removeEventListener('pointerdown', this.boundOnPointerDown);
    this.deps.canvas.removeEventListener('pointerup', this.boundOnPointerUp);
    this.deps.canvas.removeEventListener('pointermove', this.boundOnPointerMove);
    this.deps.canvas.removeEventListener('contextmenu', this.boundOnContextMenu);
    window.removeEventListener('keydown', this.boundOnKeyDown);
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

    this.snap.refresh(e, hit);
    const snap = this.snap.active();
    const point = snap ? snap.position.clone() : hit.point.clone();
    const modelId = modelIdOf(hit.object);

    if (this.pickingStart) {
      this.startPoint = point;
      this.startModelId = modelId;
      this.startSnap = { position: point, planeNormal: snap?.planeNormal };
      this.startEnd = endFrom(snap);
      // Stays exactly where it was clicked for the rest of the placement —
      // it is the plate, and a plate that drifts is not a reference.
      this.view.showPendingStart(point, this.startEnd, snap?.planeNormal);
      this.enterPickEnd();
    } else if (this.pickingEnd && this.startSnap) {
      const resolved = resolveMeasurement(this.startSnap, {
        position: point,
        planeNormal: snap?.planeNormal,
      });

      if (!resolved.ok) {
        // Two surfaces that are not parallel have no single distance between
        // them. Refusing and saying so beats recording a number nobody can
        // check — the start stays placed so the second pick can be retried.
        this.deps.onMessage?.(resolved.reason);
        this.deps.requestRender?.();
        return;
      }

      // `from` always belongs to the first pick, so the ends map straight
      // across — one of the things that fell out of making order carry the
      // intent rather than trying to infer it.
      const startSnapEnd = this.startEnd;
      const endSnapEnd = endFrom(snap);

      const modelIds = [this.startModelId, modelId].filter((id): id is string => id !== null);
      this.store.add(resolved.from, resolved.to, modelIds, {
        mode: resolved.mode,
        startSnap: startSnapEnd ?? undefined,
        endSnap: endSnapEnd ?? undefined,
        anchor: resolved.anchor,
      });
      this.clearPendingStart();
      this.view.hidePreview();
      this.enterPickStart();
    }
    this.deps.requestRender?.();
  }

  private onPointerMove(e: PointerEvent): void {
    this.updateMouse(e);
    const hit = raycastVisible(this.mouse, this.deps.camera, this.deps.scene, this.deps.renderer);

    this.snap.refresh(e, hit);
    this.showActiveSnap(hit);

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

  // ── Snapping ───────────────────────────────────────────────

  /**
   * Put the hover glyph on whatever is currently snapped, and keep the
   * preview line attached to it. The glyph is the only thing that tells the
   * user a snap happened at all, so it goes wherever the point goes.
   */
  private showActiveSnap(hit: THREE.Intersection | null): void {
    const snap = this.snap.active();
    const point = snap?.position ?? hit?.point ?? null;

    if (!point) {
      this.view.hideHoverMarker();
      if (this.pickingEnd) this.view.hidePreview();
      return;
    }

    this.view.showHoverMarker(point, endFrom(snap), snap?.planeNormal);
    if (!this.pickingEnd || !this.startSnap) return;

    // Preview what will actually be recorded, not a line between the two
    // clicks. With the first pick as the reference, a surface picked first
    // means the measurement runs perpendicular from it and lands somewhere
    // the cursor never was — so a straight line from click to cursor would
    // show the wrong shape AND the wrong number, right up until the click
    // replaced it with something else.
    const resolved = resolveMeasurement(this.startSnap, {
      position: point,
      planeNormal: snap?.planeNormal,
    });

    if (resolved.ok) {
      this.view.showPreview(resolved.from, resolved.to, resolved.anchor);
    } else {
      // Two surfaces that are not parallel. Showing nothing says "this pick
      // will not work" before the click does; the reason follows on click.
      this.view.hidePreview();
    }
  }

  /** The snap keys — Tab, `S`, `1` `2` `3`. See `SnapCursor.onKeyDown`. */
  private onKeyDown(e: KeyboardEvent): void {
    if (this.snap.onKeyDown(e) !== 'cycled') return;
    this.showActiveSnap(null);
    this.deps.requestRender?.();
  }

  // ── Helpers ────────────────────────────────────────────────

  private updateMouse(e: MouseEvent): void {
    const rect = this.deps.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }
}
