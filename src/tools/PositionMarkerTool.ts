import * as THREE from 'three';
import type { Tool } from './Tool';
import { raycastVisible } from '../utils/raycast';
import { MeasurementRenderer } from './MeasurementRenderer';
import { SnapCursor, endFrom, modelIdOf, type SnapCursorDeps } from './SnapCursor';
import {
  coordinatesAsText,
  formatCoordinates,
  sceneToModel,
  type CoordinateLine,
} from './positionMath';

export interface PositionMarkerToolDeps extends SnapCursorDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** Where the coordinate labels go. Must be positioned, and cover the canvas. */
  overlayParent: HTMLElement;
  /** Render-on-demand hook, called whenever the tool changes the scene. */
  requestRender?: () => void;
  /** The model's length unit symbol, e.g. `"mm"`. Metres when omitted. */
  lengthUnitFor?: (modelId: string) => Promise<string>;
  /** Show the user a short message — used to confirm a copy. */
  onMessage?: (message: string) => void;
}

/** A placed marker: where it is, which model it belongs to, and its label. */
interface PositionMarker {
  id: string;
  /** Scene space — Y-up, metres. Converted only for display. */
  position: THREE.Vector3;
  modelId: string | null;
  /** Length unit of `modelId`, once the worker has said; metres until then. */
  unit: string;
  object: THREE.Mesh;
  label: HTMLElement;
}

/** Cyan, so a position marker is never mistaken for a measurement end. */
const MARKER_COLOR = 0x06b6d4;
const MARKER_SCREEN_SIZE = 0.006;
/** Gap between the point and its label, in CSS pixels. */
const LABEL_OFFSET_PX = 12;

/**
 * Setting out a coordinate: click a point in the model and read its X, Y and
 * Z in the model's own coordinate system and length unit.
 *
 * Places points through `SnapCursor`, so it snaps exactly as the measurement
 * tool does — corners, edges, surfaces, Tab to cycle, `S` and `1` `2` `3` to
 * toggle — and draws the same hover glyph, so the user sees what a click
 * would catch before making it.
 *
 * While the tool is active a live label follows the snapped point; a click
 * pins it. Pinned markers outlive the tool, like measurements do, and follow
 * their model: hidden with it, dropped with it.
 *
 * The labels are HTML rather than sprites. A coordinate is three lines of
 * text that someone will want to read and copy, which a texture can do
 * neither of, and a DOM label keeps a constant size at every zoom — the
 * problem measurement labels still have (#57).
 */
export class PositionMarkerTool implements Tool {
  readonly name = 'position';

  private deps: PositionMarkerToolDeps;
  private mouse = new THREE.Vector2();
  private snap: SnapCursor;
  /** Only the hover glyph is borrowed, so the glyphs cannot drift apart. */
  private glyphs: MeasurementRenderer;

  private markers: PositionMarker[] = [];
  private hiddenModels = new Set<string>();
  private nextId = 1;
  private listeners: Array<() => void> = [];

  private overlay: HTMLElement;
  /** The label that follows the cursor while placing. */
  private preview: HTMLElement;
  private previewPoint: THREE.Vector3 | null = null;
  private previewModelId: string | null = null;

  private active = false;
  private pointerDownPos = { x: 0, y: 0 };
  private static readonly CLICK_THRESHOLD = 3; // px

  private boundOnPointerDown = (e: PointerEvent) => this.onPointerDown(e);
  private boundOnPointerUp = (e: PointerEvent) => this.onPointerUp(e);
  private boundOnPointerMove = (e: PointerEvent) => this.onPointerMove(e);
  private boundOnPointerLeave = () => this.hideHover();
  private boundOnKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);

  /** Units already asked for, so a hover does not post a message per move. */
  private units = new Map<string, string>();

  constructor(deps: PositionMarkerToolDeps) {
    this.deps = deps;
    this.snap = new SnapCursor(deps);
    this.glyphs = new MeasurementRenderer({
      scene: deps.scene,
      camera: deps.camera,
      canvas: deps.canvas,
    });

    this.overlay = document.createElement('div');
    this.overlay.className = 'position-overlay';
    deps.overlayParent.appendChild(this.overlay);

    this.preview = createLabel(true);
    // `style.display`, not `hidden`: the label's own `display: flex` would
    // override the attribute and leave a stale preview on screen.
    this.preview.style.display = 'none';
    this.overlay.appendChild(this.preview);
  }

  activate(): void {
    this.active = true;
    this.deps.canvas.style.cursor = 'crosshair';
    const canvas = this.deps.canvas;
    canvas.addEventListener('pointerdown', this.boundOnPointerDown);
    canvas.addEventListener('pointerup', this.boundOnPointerUp);
    canvas.addEventListener('pointermove', this.boundOnPointerMove);
    canvas.addEventListener('pointerleave', this.boundOnPointerLeave);
    window.addEventListener('keydown', this.boundOnKeyDown);
  }

  deactivate(): void {
    this.active = false;
    const canvas = this.deps.canvas;
    canvas.removeEventListener('pointerdown', this.boundOnPointerDown);
    canvas.removeEventListener('pointerup', this.boundOnPointerUp);
    canvas.removeEventListener('pointermove', this.boundOnPointerMove);
    canvas.removeEventListener('pointerleave', this.boundOnPointerLeave);
    window.removeEventListener('keydown', this.boundOnKeyDown);
    canvas.style.cursor = '';
    this.snap.clear();
    this.hideHover();
  }

  /** Per frame: markers hold a constant screen size and labels follow their points. */
  update(): void {
    this.glyphs.updateScales();
    const camera = this.deps.camera;
    for (const marker of this.markers) {
      marker.object.scale.setScalar(camera.position.distanceTo(marker.position) * MARKER_SCREEN_SIZE);
      this.placeLabel(marker.label, marker.position, marker.object.visible);
    }
    if (this.previewPoint) this.placeLabel(this.preview, this.previewPoint, true);
  }

  // ── Marker lifecycle ───────────────────────────────────────

  hasMarkers(): boolean {
    return this.markers.length > 0;
  }

  /** Subscribe to markers being added or removed. Returns the unsubscribe. */
  onStateChange(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  clearMarkers(): void {
    if (this.markers.length === 0) return;
    for (const marker of [...this.markers]) this.disposeMarker(marker);
    this.markers = [];
    this.changed();
  }

  /** A marker follows its model: gone with it. */
  onModelRemoved(modelId: string): void {
    const doomed = this.markers.filter((m) => m.modelId === modelId);
    if (doomed.length === 0) return;
    for (const marker of doomed) this.disposeMarker(marker);
    this.markers = this.markers.filter((m) => m.modelId !== modelId);
    this.hiddenModels.delete(modelId);
    this.changed();
  }

  /** …and hidden with it. */
  setModelVisible(modelId: string, visible: boolean): void {
    if (visible) this.hiddenModels.delete(modelId);
    else this.hiddenModels.add(modelId);
    for (const marker of this.markers) {
      if (marker.modelId === modelId) marker.object.visible = visible;
    }
    this.update();
    this.deps.requestRender?.();
  }

  dispose(): void {
    this.deactivate();
    for (const marker of this.markers) this.disposeMarker(marker);
    this.markers = [];
    this.glyphs.dispose();
    this.overlay.remove();
    this.listeners = [];
  }

  // ── Pointer handling ───────────────────────────────────────

  private onPointerDown(e: PointerEvent): void {
    if (e.button === 0) this.pointerDownPos = { x: e.clientX, y: e.clientY };
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button !== 0) return;
    const moved = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
    if (moved >= PositionMarkerTool.CLICK_THRESHOLD) return; // an orbit, not a click

    const hit = this.hitAt(e);
    if (!hit) return;
    this.snap.refresh(e, hit);
    const point = this.snap.active()?.position ?? hit.point;
    this.addMarker(point.clone(), modelIdOf(hit.object));
    this.deps.requestRender?.();
  }

  private onPointerMove(e: PointerEvent): void {
    const hit = this.hitAt(e);
    this.snap.refresh(e, hit);
    this.showHover(hit);
    this.deps.requestRender?.();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.snap.onKeyDown(e) !== 'cycled') return;
    this.showHover(null);
    this.deps.requestRender?.();
  }

  /**
   * The glyph and the live label both go wherever the snapped point is: the
   * numbers on screen are always the numbers a click would pin.
   */
  private showHover(hit: THREE.Intersection | null): void {
    const snap = this.snap.active();
    const point = snap?.position ?? hit?.point ?? null;
    if (!point) {
      this.hideHover();
      return;
    }

    this.glyphs.showHoverMarker(point, endFrom(snap), snap?.planeNormal);
    if (hit) this.previewModelId = modelIdOf(hit.object);
    this.previewPoint = point.clone();
    fillLabel(this.preview, this.linesFor(point, this.unitOf(this.previewModelId)));
    this.placeLabel(this.preview, this.previewPoint, true);
  }

  private hideHover(): void {
    this.glyphs.hideHoverMarker();
    this.previewPoint = null;
    this.preview.style.display = 'none';
    this.deps.requestRender?.();
  }

  // ── Markers ────────────────────────────────────────────────

  private addMarker(position: THREE.Vector3, modelId: string | null): void {
    const object = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 12),
      new THREE.MeshBasicMaterial({
        color: MARKER_COLOR,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
      }),
    );
    object.renderOrder = 1000;
    object.userData.isPositionMarker = true;
    object.position.copy(position);
    object.visible = !(modelId && this.hiddenModels.has(modelId));
    this.deps.scene.add(object);

    const label = createLabel(false);
    this.overlay.appendChild(label);

    const marker: PositionMarker = {
      id: `position-${this.nextId++}`,
      position,
      modelId,
      unit: this.unitOf(modelId),
      object,
      label,
    };
    this.markers.push(marker);
    this.renderMarkerLabel(marker);

    label.querySelector('.position-label-copy')?.addEventListener('click', () => this.copy(marker));
    label.querySelector('.position-label-remove')?.addEventListener('click', () => this.removeMarker(marker));

    // The unit may still be on its way; relabel when it lands.
    if (modelId && !this.units.has(modelId)) {
      void this.fetchUnit(modelId).then(() => {
        if (!this.markers.includes(marker)) return;
        marker.unit = this.unitOf(modelId);
        this.renderMarkerLabel(marker);
      });
    }

    this.changed();
  }

  private removeMarker(marker: PositionMarker): void {
    this.disposeMarker(marker);
    this.markers = this.markers.filter((m) => m !== marker);
    this.changed();
  }

  private disposeMarker(marker: PositionMarker): void {
    this.deps.scene.remove(marker.object);
    marker.object.geometry.dispose();
    (marker.object.material as THREE.Material).dispose();
    marker.label.remove();
  }

  private renderMarkerLabel(marker: PositionMarker): void {
    fillLabel(marker.label, this.linesFor(marker.position, marker.unit));
    this.placeLabel(marker.label, marker.position, marker.object.visible);
  }

  private copy(marker: PositionMarker): void {
    const text = coordinatesAsText(this.linesFor(marker.position, marker.unit));
    navigator.clipboard
      ?.writeText(text)
      .then(() => this.deps.onMessage?.('Coordinates copied'))
      .catch(() => this.deps.onMessage?.('Could not copy to the clipboard'));
  }

  private changed(): void {
    this.update();
    this.deps.requestRender?.();
    for (const cb of this.listeners) cb();
  }

  // ── Units and labels ───────────────────────────────────────

  private linesFor(scenePoint: THREE.Vector3, unit: string): CoordinateLine[] {
    return formatCoordinates(sceneToModel(scenePoint), unit);
  }

  /** The model's unit if known; otherwise ask for it and use metres meanwhile. */
  private unitOf(modelId: string | null): string {
    if (!modelId) return 'm';
    const known = this.units.get(modelId);
    if (known) return known;
    void this.fetchUnit(modelId);
    return 'm';
  }

  private pendingUnits = new Map<string, Promise<void>>();

  private fetchUnit(modelId: string): Promise<void> {
    const pending = this.pendingUnits.get(modelId);
    if (pending) return pending;
    const lookup = this.deps.lengthUnitFor;
    if (!lookup) return Promise.resolve();
    const request = lookup(modelId)
      .then((symbol) => {
        this.units.set(modelId, symbol);
      })
      .catch(() => {
        // Metres it stays. The numbers are still right, only in another unit.
        this.units.set(modelId, 'm');
      });
    this.pendingUnits.set(modelId, request);
    return request;
  }

  /** Pin a label beside its point on screen, or hide it when the point is not. */
  private placeLabel(label: HTMLElement, point: THREE.Vector3, visible: boolean): void {
    const ndc = point.clone().project(this.deps.camera);
    const onScreen = visible && ndc.z > -1 && ndc.z < 1;
    label.style.display = onScreen ? '' : 'none';
    if (!onScreen) return;
    const x = ((ndc.x + 1) / 2) * this.deps.canvas.clientWidth + LABEL_OFFSET_PX;
    const y = ((1 - ndc.y) / 2) * this.deps.canvas.clientHeight - LABEL_OFFSET_PX;
    label.style.transform = `translate(${x}px, ${y}px) translateY(-100%)`;
  }

  private hitAt(e: MouseEvent): THREE.Intersection | null {
    const rect = this.deps.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    return raycastVisible(this.mouse, this.deps.camera, this.deps.scene, this.deps.renderer);
  }
}

function createLabel(preview: boolean): HTMLElement {
  const label = document.createElement('div');
  label.className = preview ? 'position-label position-label-preview' : 'position-label';
  const rows = document.createElement('div');
  rows.className = 'position-label-rows';
  label.appendChild(rows);
  if (!preview) {
    const actions = document.createElement('div');
    actions.className = 'position-label-actions';
    const copy = document.createElement('button');
    copy.className = 'position-label-copy';
    copy.title = 'Copy coordinates';
    copy.textContent = '⧉';
    const remove = document.createElement('button');
    remove.className = 'position-label-remove';
    remove.title = 'Remove marker';
    remove.textContent = '✕';
    actions.append(copy, remove);
    label.appendChild(actions);
  }
  return label;
}

function fillLabel(label: HTMLElement, lines: readonly CoordinateLine[]): void {
  const rows = label.querySelector('.position-label-rows');
  if (!rows) return;
  rows.replaceChildren(
    ...lines.map((line) => {
      const row = document.createElement('div');
      row.className = 'position-label-row';
      const axis = document.createElement('span');
      axis.className = 'position-label-axis';
      axis.textContent = `${line.axis} =`;
      const value = document.createElement('span');
      value.className = 'position-label-value';
      value.textContent = line.text;
      row.append(axis, value);
      return row;
    }),
  );
}
