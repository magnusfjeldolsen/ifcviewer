import * as THREE from 'three';
import type { Tool } from './Tool';
import { raycastVisible } from '../utils/raycast';

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
 */

export class MeasurementTool implements Tool {
  readonly name = 'measurement';

  private deps: MeasurementToolDeps;
  private mouse = new THREE.Vector2();

  // State
  private pickingStart = false;
  private pickingEnd = false;
  private startPoint: THREE.Vector3 | null = null;
  private startMarkerGroup: THREE.Group | null = null;

  /** All completed measurement groups (persist until cleared) */
  private measurements: THREE.Group[] = [];

  // Click-vs-drag detection
  private pointerDownPos = { x: 0, y: 0 };
  private static readonly CLICK_THRESHOLD = 3; // px

  // Hover dot
  private hoverMarker: THREE.Group | null = null;

  // Live preview (shown during PICK_END)
  private previewLine: THREE.Line | null = null;
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

  /** Call every frame to keep markers at constant screen size */
  update(): void {
    for (const group of this.measurements) {
      this.scaleMarkers(group);
    }
    if (this.startMarkerGroup) {
      this.scaleMarkers(this.startMarkerGroup);
    }
    if (this.hoverMarker) {
      const dist = this.deps.camera.position.distanceTo(this.hoverMarker.position);
      this.hoverMarker.scale.setScalar(dist * this.HOVER_MARKER_SCREEN_SIZE);
    }
  }

  /**
   * Remove all measurements from the scene.
   *
   * Intended for use by a "Reset View" button or similar bulk-clear action.
   * This is a simple nuke-everything approach — once we have granular
   * undo/redo (Ctrl+Z/Y) or per-measurement deletion, this method may
   * be deprecated in favour of those more targeted APIs.
   *
   * @deprecated Planned for replacement by granular undo/redo controls.
   */
  clearMeasurements(): void {
    for (const group of this.measurements) {
      this.disposeGroup(group);
    }
    this.measurements = [];
    this.removePendingStart();
    this.deps.requestRender?.();
  }

  dispose(): void {
    this.deactivate();
    this.clearMeasurements();
  }

  // ── State transitions ──────────────────────────────────────

  private enterPickStart(): void {
    this.pickingStart = true;
    this.pickingEnd = false;
    this.startPoint = null;
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

    if (this.pickingStart) {
      this.startPoint = hit.point.clone();
      this.startMarkerGroup = this.createPointMarker(this.startPoint, 0x22c55e);
      this.deps.scene.add(this.startMarkerGroup);
      this.enterPickEnd();
    } else if (this.pickingEnd && this.startPoint) {
      const endPoint = hit.point.clone();
      this.createMeasurement(this.startPoint, endPoint);
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

    // Update or create preview line
    if (this.previewLine) {
      const positions = this.previewLine.geometry.attributes.position as THREE.BufferAttribute;
      positions.setXYZ(0, start.x, start.y, start.z);
      positions.setXYZ(1, end.x, end.y, end.z);
      positions.needsUpdate = true;
      this.previewLine.computeLineDistances();
    } else {
      const geom = new THREE.BufferGeometry().setFromPoints([start, end]);
      const mat = new THREE.LineDashedMaterial({
        color: 0xfacc15,
        depthTest: false,
        dashSize: 0.1,
        gapSize: 0.05,
      });
      this.previewLine = new THREE.Line(geom, mat);
      this.previewLine.computeLineDistances();
      this.previewLine.renderOrder = 1000;
      this.previewLine.userData.isMeasurement = true;
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
      (this.previewLine.material as THREE.Material).dispose();
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

  // ── Measurement creation ───────────────────────────────────

  private createMeasurement(start: THREE.Vector3, end: THREE.Vector3): void {
    const group = new THREE.Group();
    group.userData.isMeasurement = true;

    const distance = start.distanceTo(end);

    // Start and end markers
    const startMarker = this.createPointMarker(start, 0x22c55e);
    const endMarker = this.createPointMarker(end, 0xef4444);
    group.add(startMarker);
    group.add(endMarker);

    // Connecting line
    const lineGeom = new THREE.BufferGeometry().setFromPoints([start, end]);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xfacc15,
      depthTest: false,
    });
    const line = new THREE.Line(lineGeom, lineMat);
    line.renderOrder = 1000;
    line.userData.isMeasurement = true;
    group.add(line);

    // Distance label
    const label = this.createLabel(distance);
    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    label.position.copy(midpoint);

    // Scale label proportional to measurement length, with min/max clamp
    const labelScale = Math.max(0.15, Math.min(2.0, distance * 0.15));
    label.scale.set(labelScale, labelScale * 0.5, 1);

    group.add(label);

    this.deps.scene.add(group);
    this.measurements.push(group);
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
    const text = `${distance.toFixed(2)} m`;

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
