import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Tool } from './Tool';
import { raycastVisible } from '../utils/raycast';
import { formatDistance } from './measureMath';
import {
  MeasurementStore,
  type MeasurementRecord,
  type SerializedMeasurement,
} from './MeasurementStore';
import { measurementCandidatesAt } from './measurementPicking';
import type { Candidate, ScreenPoint } from '../inspector/candidateMath';

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
 * States:
 *   IDLE       — tool is not active
 *   PICK_START — crosshair cursor, waiting for click on a surface
 *   PICK_END   — start point placed, waiting for second click
 *
 * A "click" is a pointerdown + pointerup where the mouse moved < 3px,
 * so orbit drags never accidentally place points.
 *
 * The tool draws; `MeasurementStore` decides. Everything about which
 * measurements exist, which is selected and which are visible lives in the
 * store, because this class needs a WebGLRenderer and a 2D canvas context and
 * so cannot be constructed under test.
 */

/** Yellow — a measurement nobody is pointing at. */
const LINE_COLOR = 0xfacc15;
/** Pale yellow — the cursor is on this measurement; a click would take it. */
const LINE_COLOR_HOVER = 0xfef9c3;
/** Brand blue — selected; `Delete` would remove this one. */
const LINE_COLOR_SELECTED = 0x3b82f6;

/**
 * Drawn width in screen pixels. `THREE.LineBasicMaterial.linewidth` cannot do
 * this — WebGL guarantees only a 1-pixel line, and on ANGLE/D3D11 (most
 * Windows machines, this one included) `ALIASED_LINE_WIDTH_RANGE` really is
 * `[1, 1]`, so the old hairline could not be widened at all. `Line2` draws
 * screen-space quads instead, which is why it is worth the extra draw path.
 */
const LINE_WIDTH_PX = 3;
const LINE_WIDTH_PX_ACTIVE = 4;

export class MeasurementTool implements Tool {
  readonly name = 'measurement';

  private deps: MeasurementToolDeps;
  private mouse = new THREE.Vector2();

  /** What measurements exist, which is selected, which models hide them. */
  private store = new MeasurementStore();
  /** Scene group per measurement id. Mirrors `store.list()`. */
  private groups = new Map<string, THREE.Group>();
  /** The line of each measurement, so hover / selection can restyle it. */
  private lines = new Map<string, Line2>();
  /** The measurement the cursor is over, per the candidate system. */
  private hoveredId: string | null = null;

  // State
  private pickingStart = false;
  private pickingEnd = false;
  private startPoint: THREE.Vector3 | null = null;
  private startModelId: string | null = null;
  private startMarkerGroup: THREE.Group | null = null;

  // Click-vs-drag detection
  private pointerDownPos = { x: 0, y: 0 };
  private static readonly CLICK_THRESHOLD = 3; // px

  // Hover dot
  private hoverMarker: THREE.Group | null = null;

  // Live preview (shown during PICK_END)
  private previewLine: Line2 | null = null;
  private previewLabel: THREE.Sprite | null = null;

  private readonly MARKER_SCREEN_SIZE = 0.006;
  private readonly HOVER_MARKER_SCREEN_SIZE = 0.005;

  // Bound handlers
  private boundOnPointerDown: (e: PointerEvent) => void;
  private boundOnPointerUp: (e: PointerEvent) => void;
  private boundOnPointerMove: (e: PointerEvent) => void;
  private boundOnContextMenu: (e: MouseEvent) => void;

  constructor(deps: MeasurementToolDeps) {
    this.deps = deps;
    this.boundOnPointerDown = this.onPointerDown.bind(this);
    this.boundOnPointerUp = this.onPointerUp.bind(this);
    this.boundOnPointerMove = this.onPointerMove.bind(this);
    this.boundOnContextMenu = this.onContextMenu.bind(this);
    // The store is the source of truth; the scene follows it. Every path that
    // adds, removes, selects, restores or hides a measurement goes through the
    // store and lands here, so there is one place the visuals can drift from.
    this.store.onChange(() => this.syncScene());
  }

  activate(): void {
    this.enterPickStart();
  }

  deactivate(): void {
    this.removeListeners();
    this.removePendingStart();
    this.removePreview();
    this.removeHoverMarker();
    this.pickingStart = false;
    this.pickingEnd = false;
    this.startPoint = null;
    this.deps.canvas.style.cursor = '';
  }

  /** Call every frame to keep markers at constant screen size. */
  update(): void {
    for (const group of this.groups.values()) {
      this.scaleMarkers(group);
    }
    if (this.startMarkerGroup) {
      this.scaleMarkers(this.startMarkerGroup);
    }
    if (this.hoverMarker) {
      const dist = this.deps.camera.position.distanceTo(this.hoverMarker.position);
      this.hoverMarker.scale.setScalar(dist * this.HOVER_MARKER_SCREEN_SIZE);
    }
    this.syncLineResolution();
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
    this.removePendingStart();
    this.deps.requestRender?.();
  }

  /** Select a measurement so `Delete` knows what to take, or `null` to clear. */
  selectMeasurement(id: string | null): void {
    this.store.select(id);
  }

  getSelectedMeasurementId(): string | null {
    return this.store.getSelectedId();
  }

  /** `Delete` / `Backspace`. Returns whether anything was removed. */
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
    this.restyleLines();
    this.deps.requestRender?.();
  }

  dispose(): void {
    this.deactivate();
    this.store.clear();
    // clear() only notifies when there was something to drop; tear the scene
    // down unconditionally so an empty store still releases its groups.
    this.syncScene();
    this.store.dispose();
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
      this.startMarkerGroup = this.createPointMarker(this.startPoint, 0x22c55e);
      this.deps.scene.add(this.startMarkerGroup);
      this.enterPickEnd();
    } else if (this.pickingEnd && this.startPoint) {
      const modelIds = [this.startModelId, modelId].filter((id): id is string => id !== null);
      this.store.add(this.startPoint, hit.point, modelIds);
      this.removePendingStart();
      this.removePreview();
      this.enterPickStart();
    }
    this.deps.requestRender?.();
  }

  private onPointerMove(e: PointerEvent): void {
    this.updateMouse(e);
    const hit = raycastVisible(this.mouse, this.deps.camera, this.deps.scene, this.deps.renderer);

    // Update hover dot
    if (hit) {
      this.showHoverMarker(hit.point);
    } else {
      this.removeHoverMarker();
    }

    // Update live preview line while picking end point
    if (this.pickingEnd && this.startPoint && hit) {
      this.updatePreview(this.startPoint, hit.point);
    } else if (this.pickingEnd) {
      this.removePreview();
    }
    // Hover marker and preview line track the cursor; every move mutates
    // scene state without touching the camera, so OrbitControls won't fire.
    this.deps.requestRender?.();
  }

  private onContextMenu(e: MouseEvent): void {
    if (this.pickingEnd) {
      // Right-click cancels the current start point, back to PICK_START
      e.preventDefault();
      this.removePendingStart();
      this.removePreview();
      this.pickingStart = true;
      this.pickingEnd = false;
      this.startPoint = null;
      this.startModelId = null;
      this.deps.requestRender?.();
    }
  }

  // ── Hover marker ───────────────────────────────────────────

  private showHoverMarker(position: THREE.Vector3): void {
    if (!this.hoverMarker) {
      const group = new THREE.Group();
      group.userData.isMeasurement = true;
      group.userData.isMeasurementMarker = true;

      const geom = new THREE.SphereGeometry(1, 8, 8);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        depthTest: false,
        transparent: true,
        opacity: 0.6,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 1002;
      mesh.userData.isMeasurement = true;
      group.add(mesh);

      this.hoverMarker = group;
      this.deps.scene.add(this.hoverMarker);
    }

    this.hoverMarker.position.copy(position);
  }

  private removeHoverMarker(): void {
    if (this.hoverMarker) {
      this.disposeGroup(this.hoverMarker);
      this.hoverMarker = null;
    }
  }

  // ── Live preview ───────────────────────────────────────────

  private updatePreview(start: THREE.Vector3, end: THREE.Vector3): void {
    const distance = start.distanceTo(end);

    if (this.previewLine) {
      this.setLinePoints(this.previewLine, start, end);
    } else {
      this.previewLine = this.createLine(start, end, LINE_COLOR, LINE_WIDTH_PX, true);
      this.deps.scene.add(this.previewLine);
    }

    // Update or recreate preview label
    this.removePreviewLabel();
    this.previewLabel = this.createLabel(distance);
    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    this.previewLabel.position.copy(midpoint);
    const labelScale = Math.max(0.15, Math.min(2.0, distance * 0.15));
    this.previewLabel.scale.set(labelScale, labelScale * 0.5, 1);
    this.deps.scene.add(this.previewLabel);
  }

  private removePreview(): void {
    if (this.previewLine) {
      this.deps.scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      this.previewLine.material.dispose();
      this.previewLine = null;
    }
    this.removePreviewLabel();
  }

  private removePreviewLabel(): void {
    if (this.previewLabel) {
      this.deps.scene.remove(this.previewLabel);
      this.previewLabel.material.map?.dispose();
      this.previewLabel.material.dispose();
      this.previewLabel = null;
    }
  }

  // ── Scene synchronisation ──────────────────────────────────

  /**
   * Bring the scene in line with the store: build groups for new records, drop
   * groups for records that are gone, and apply visibility and styling. Runs
   * on every store change, so add / delete / clear / restore / model-hide all
   * share one code path.
   */
  private syncScene(): void {
    const live = new Set<string>();

    for (const record of this.store.list()) {
      live.add(record.id);
      if (!this.groups.has(record.id)) {
        this.buildMeasurementGroup(record);
      }
      const group = this.groups.get(record.id);
      if (group) group.visible = this.store.isVisible(record);
    }

    for (const [id, group] of [...this.groups]) {
      if (live.has(id)) continue;
      this.disposeGroup(group);
      this.groups.delete(id);
      this.lines.delete(id);
      if (this.hoveredId === id) this.hoveredId = null;
    }

    this.restyleLines();
    this.deps.requestRender?.();
  }

  private buildMeasurementGroup(record: MeasurementRecord): void {
    const group = new THREE.Group();
    group.userData.isMeasurement = true;
    group.userData.measurementId = record.id;

    const distance = record.start.distanceTo(record.end);

    group.add(this.createPointMarker(record.start, 0x22c55e));
    group.add(this.createPointMarker(record.end, 0xef4444));

    const line = this.createLine(record.start, record.end, LINE_COLOR, LINE_WIDTH_PX, false);
    group.add(line);
    this.lines.set(record.id, line);

    const label = this.createLabel(distance);
    label.position.addVectors(record.start, record.end).multiplyScalar(0.5);
    // Scale the label proportional to measurement length, with min/max clamp.
    const labelScale = Math.max(0.15, Math.min(2.0, distance * 0.15));
    label.scale.set(labelScale, labelScale * 0.5, 1);
    group.add(label);

    this.deps.scene.add(group);
    this.groups.set(record.id, group);
  }

  /** Apply the normal / hovered / selected colour to every measurement line. */
  private restyleLines(): void {
    const selectedId = this.store.getSelectedId();
    for (const [id, line] of this.lines) {
      const selected = id === selectedId;
      const hovered = id === this.hoveredId;
      const color = selected ? LINE_COLOR_SELECTED : hovered ? LINE_COLOR_HOVER : LINE_COLOR;
      line.material.color.setHex(color);
      line.material.linewidth = selected || hovered ? LINE_WIDTH_PX_ACTIVE : LINE_WIDTH_PX;
    }
  }

  // ── Geometry builders ──────────────────────────────────────

  /**
   * A fat line. `LineMaterial.resolution` has to track the canvas or the
   * apparent thickness drifts after a resize — `syncLineResolution` does that
   * from `update()`, which the render loop calls before every draw.
   */
  private createLine(
    start: THREE.Vector3,
    end: THREE.Vector3,
    color: number,
    width: number,
    dashed: boolean,
  ): Line2 {
    const geometry = new LineGeometry();
    geometry.setPositions([start.x, start.y, start.z, end.x, end.y, end.z]);

    const material = new LineMaterial({
      color,
      linewidth: width,
      depthTest: false,
      transparent: true,
      dashed,
      dashSize: 0.1,
      gapSize: 0.05,
    });
    material.resolution.set(this.canvasWidth(), this.canvasHeight());

    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.renderOrder = 1000;
    // Line2 extends THREE.Mesh, so without this flag `raycastVisible` would
    // collect it and a measurement could steal clicks from the geometry it
    // annotates — the exact regression the screen-space pick path avoids.
    line.userData.isMeasurement = true;
    return line;
  }

  private setLinePoints(line: Line2, start: THREE.Vector3, end: THREE.Vector3): void {
    line.geometry.setPositions([start.x, start.y, start.z, end.x, end.y, end.z]);
    line.computeLineDistances();
  }

  /** Keep every fat line's resolution matched to the canvas (see `createLine`). */
  private syncLineResolution(): void {
    const width = this.canvasWidth();
    const height = this.canvasHeight();
    for (const line of this.lines.values()) {
      line.material.resolution.set(width, height);
    }
    this.previewLine?.material.resolution.set(width, height);
  }

  private canvasWidth(): number {
    return this.deps.canvas.clientWidth || this.deps.canvas.width || 1;
  }

  private canvasHeight(): number {
    return this.deps.canvas.clientHeight || this.deps.canvas.height || 1;
  }

  private createPointMarker(position: THREE.Vector3, color: number): THREE.Group {
    const markerGroup = new THREE.Group();
    markerGroup.userData.isMeasurement = true;
    markerGroup.userData.isMeasurementMarker = true;
    markerGroup.position.copy(position);

    const geom = new THREE.SphereGeometry(1, 10, 10);
    const mat = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 1000;
    mesh.userData.isMeasurement = true;
    markerGroup.add(mesh);

    return markerGroup;
  }

  private createLabel(distance: number): THREE.Sprite {
    const text = formatDistance(distance);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Size canvas to fit text
    const fontSize = 64;
    ctx.font = `bold ${fontSize}px sans-serif`;
    const metrics = ctx.measureText(text);
    const padding = 20;
    canvas.width = metrics.width + padding * 2;
    canvas.height = fontSize + padding * 2;

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    const radius = 12;
    this.roundRect(ctx, 0, 0, canvas.width, canvas.height, radius);
    ctx.fill();

    // Text
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const mat = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 1001;
    sprite.userData.isMeasurement = true;
    // Never a pick target (D9): it is the only part of a measurement with real
    // screen area, and it grows without bound as the camera closes in.
    sprite.userData.isMeasurementLabel = true;

    return sprite;
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ── Helpers ────────────────────────────────────────────────

  private updateMouse(e: MouseEvent): void {
    const rect = this.deps.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private scaleMarkers(group: THREE.Group): void {
    group.traverse((child) => {
      if (child instanceof THREE.Group && child.userData.isMeasurementMarker) {
        const dist = this.deps.camera.position.distanceTo(child.position);
        const scale = dist * this.MARKER_SCREEN_SIZE;
        child.scale.setScalar(scale);
      }
    });
  }

  private removePendingStart(): void {
    if (this.startMarkerGroup) {
      this.disposeGroup(this.startMarkerGroup);
      this.startMarkerGroup = null;
    }
    this.startPoint = null;
    this.startModelId = null;
  }

  private disposeGroup(group: THREE.Group): void {
    this.deps.scene.remove(group);
    group.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        const mat = child.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
      if (child instanceof THREE.Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    });
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
