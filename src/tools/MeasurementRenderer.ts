import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { formatDistance } from './measureMath';
import type { MeasurementView } from './measurementViews';

/**
 * Everything a measurement looks like, and nothing about what it means.
 *
 * Split out of `MeasurementTool`, which had grown to six jobs — pointer
 * handling, placement state, preview geometry, label sprites, marker scaling
 * and store synchronisation — in one class that cannot be constructed under
 * test. Snapping adds three glyph kinds and orthogonal drawing on top of that,
 * so the two halves were separated first.
 *
 * The boundary is deliberately narrow: this class is handed a list of
 * `MeasurementView`s and makes the scene match. It knows nothing about the
 * store, the selection vocabulary or the placement state machine, so there is
 * no path by which a rendering change can alter what a measurement *is*.
 *
 * It still needs WebGL and a 2D canvas context, so it has no unit tests. That
 * is the point of moving it here: it is now the only part that does.
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

const MARKER_SCREEN_SIZE = 0.006;
const HOVER_MARKER_SCREEN_SIZE = 0.005;

const START_MARKER_COLOR = 0x22c55e;
const END_MARKER_COLOR = 0xef4444;

export interface MeasurementRendererDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
}

export class MeasurementRenderer {
  private deps: MeasurementRendererDeps;

  /** Scene group per measurement id. Mirrors the views last synced. */
  private groups = new Map<string, THREE.Group>();
  /** The line of each measurement, so hover / selection can restyle it. */
  private lines = new Map<string, Line2>();

  /** The dot that follows the cursor over geometry. */
  private hoverMarker: THREE.Group | null = null;
  /** The marker on a placed first point, before the second is picked. */
  private pendingStartMarker: THREE.Group | null = null;

  /** Live preview, shown while the second point is being chosen. */
  private previewLine: Line2 | null = null;
  private previewLabel: THREE.Sprite | null = null;

  constructor(deps: MeasurementRendererDeps) {
    this.deps = deps;
  }

  /**
   * Make the scene match `views`: build what is new, drop what is gone, and
   * apply visibility and colour. The single entry point for committed
   * measurements — add, delete, clear, restore and model-hide all arrive here,
   * so there is one place the visuals can drift from.
   */
  sync(views: readonly MeasurementView[]): void {
    const live = new Set<string>();

    for (const view of views) {
      live.add(view.id);
      if (!this.groups.has(view.id)) this.build(view);
      const group = this.groups.get(view.id);
      if (group) group.visible = view.visible;
    }

    for (const [id, group] of [...this.groups]) {
      if (live.has(id)) continue;
      this.disposeGroup(group);
      this.groups.delete(id);
      this.lines.delete(id);
    }

    this.restyle(views);
  }

  /** Show the cursor dot at a world position. */
  showHoverMarker(position: THREE.Vector3): void {
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

  hideHoverMarker(): void {
    if (!this.hoverMarker) return;
    this.disposeGroup(this.hoverMarker);
    this.hoverMarker = null;
  }

  /** Mark a placed first point while the second is being chosen. */
  showPendingStart(position: THREE.Vector3): void {
    this.hidePendingStart();
    this.pendingStartMarker = this.createPointMarker(position, START_MARKER_COLOR);
    this.deps.scene.add(this.pendingStartMarker);
  }

  hidePendingStart(): void {
    if (!this.pendingStartMarker) return;
    this.disposeGroup(this.pendingStartMarker);
    this.pendingStartMarker = null;
  }

  /** The dashed line and live distance between a placed point and the cursor. */
  showPreview(start: THREE.Vector3, end: THREE.Vector3): void {
    const distance = start.distanceTo(end);

    if (this.previewLine) {
      this.setLinePoints(this.previewLine, start, end);
    } else {
      this.previewLine = this.createLine(start, end, LINE_COLOR, LINE_WIDTH_PX, true);
      this.deps.scene.add(this.previewLine);
    }

    this.removePreviewLabel();
    this.previewLabel = this.createLabel(distance);
    this.previewLabel.position.addVectors(start, end).multiplyScalar(0.5);
    applyLabelScale(this.previewLabel, distance);
    this.deps.scene.add(this.previewLabel);
  }

  hidePreview(): void {
    if (this.previewLine) {
      this.deps.scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      this.previewLine.material.dispose();
      this.previewLine = null;
    }
    this.removePreviewLabel();
  }

  /**
   * Per-frame upkeep: markers hold a constant screen size, and every fat line's
   * resolution tracks the canvas or its apparent thickness drifts after a
   * resize. Called from the render loop before each draw.
   */
  updateScales(): void {
    for (const group of this.groups.values()) this.scaleMarkers(group);
    if (this.pendingStartMarker) this.scaleMarkers(this.pendingStartMarker);
    if (this.hoverMarker) {
      const dist = this.deps.camera.position.distanceTo(this.hoverMarker.position);
      this.hoverMarker.scale.setScalar(dist * HOVER_MARKER_SCREEN_SIZE);
    }

    const width = this.canvasWidth();
    const height = this.canvasHeight();
    for (const line of this.lines.values()) line.material.resolution.set(width, height);
    this.previewLine?.material.resolution.set(width, height);
  }

  dispose(): void {
    this.hidePreview();
    this.hideHoverMarker();
    this.hidePendingStart();
    for (const group of this.groups.values()) this.disposeGroup(group);
    this.groups.clear();
    this.lines.clear();
  }

  // ── Building ───────────────────────────────────────────────

  private build(view: MeasurementView): void {
    const group = new THREE.Group();
    group.userData.isMeasurement = true;
    group.userData.measurementId = view.id;

    const distance = view.start.distanceTo(view.end);

    group.add(this.createPointMarker(view.start, START_MARKER_COLOR));
    group.add(this.createPointMarker(view.end, END_MARKER_COLOR));

    const line = this.createLine(view.start, view.end, LINE_COLOR, LINE_WIDTH_PX, false);
    group.add(line);
    this.lines.set(view.id, line);

    const label = this.createLabel(distance);
    label.position.addVectors(view.start, view.end).multiplyScalar(0.5);
    applyLabelScale(label, distance);
    group.add(label);

    this.deps.scene.add(group);
    this.groups.set(view.id, group);
  }

  /** Apply the normal / hovered / selected colour to every measurement line. */
  private restyle(views: readonly MeasurementView[]): void {
    for (const view of views) {
      const line = this.lines.get(view.id);
      if (!line) continue;
      const active = view.selected || view.hovered;
      line.material.color.setHex(
        view.selected ? LINE_COLOR_SELECTED : view.hovered ? LINE_COLOR_HOVER : LINE_COLOR,
      );
      line.material.linewidth = active ? LINE_WIDTH_PX_ACTIVE : LINE_WIDTH_PX;
    }
  }

  /**
   * A fat line. See `LINE_WIDTH_PX` for why `Line2` rather than a plain line.
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
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 12);
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

  private removePreviewLabel(): void {
    if (!this.previewLabel) return;
    this.deps.scene.remove(this.previewLabel);
    this.previewLabel.material.map?.dispose();
    this.previewLabel.material.dispose();
    this.previewLabel = null;
  }

  private scaleMarkers(group: THREE.Group): void {
    group.traverse((child) => {
      if (child instanceof THREE.Group && child.userData.isMeasurementMarker) {
        const dist = this.deps.camera.position.distanceTo(child.position);
        child.scale.setScalar(dist * MARKER_SCREEN_SIZE);
      }
    });
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

/** Label size follows the measured length, clamped at both ends. */
function applyLabelScale(sprite: THREE.Sprite, distance: number): void {
  const scale = Math.max(0.15, Math.min(2.0, distance * 0.15));
  sprite.scale.set(scale, scale * 0.5, 1);
}

function roundRect(
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
