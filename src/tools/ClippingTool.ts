import * as THREE from 'three';
import type { Tool } from './Tool';
import { raycastVisible } from '../utils/raycast';

export interface ClippingToolDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
}

/**
 * States:
 *   IDLE     — tool is not active
 *   PLACING  — tool is active, crosshair cursor, waiting for mousedown on a surface
 *   CLIPPING — a clip plane exists, user can drag handle but must press C/✂ to re-place
 */

export class ClippingTool implements Tool {
  readonly name = 'clipping';

  private deps: ClippingToolDeps;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  // Clipping state
  private placing = false;
  private clipPlane: THREE.Plane | null = null;
  private planeNormal = new THREE.Vector3();
  private planePoint = new THREE.Vector3();
  private handleGroup: THREE.Group | null = null;

  // Drag state
  private dragging = false;
  private dragPrevY = 0;

  // Constant screen-size factor
  private readonly HANDLE_SCREEN_SIZE = 0.03;

  // Bound handlers
  private boundOnPlaceDown: (e: MouseEvent) => void;
  private boundOnPointerDown: (e: PointerEvent) => void;
  private boundOnPointerMove: (e: PointerEvent) => void;
  private boundOnPointerUp: (e: PointerEvent) => void;

  constructor(deps: ClippingToolDeps) {
    this.deps = deps;
    this.boundOnPlaceDown = this.onPlaceDown.bind(this);
    this.boundOnPointerDown = this.onPointerDown.bind(this);
    this.boundOnPointerMove = this.onPointerMove.bind(this);
    this.boundOnPointerUp = this.onPointerUp.bind(this);
  }

  activate(): void {
    this.enterPlacingMode();
  }

  deactivate(): void {
    this.exitPlacingMode();
    this.removeDragListeners();
    this.removeClipPlane();
    this.deps.canvas.style.cursor = '';
  }

  /**
   * Enter placement mode. Called on first activate, and again when
   * user presses C/✂ while a clip plane already exists.
   */
  enterPlacingMode(): void {
    this.placing = true;
    this.deps.canvas.style.cursor = 'crosshair';
    this.deps.canvas.addEventListener('mousedown', this.boundOnPlaceDown);
  }

  private exitPlacingMode(): void {
    this.placing = false;
    this.deps.canvas.removeEventListener('mousedown', this.boundOnPlaceDown);
  }

  /** Call every frame to keep handle at constant screen size */
  update(): void {
    if (!this.handleGroup) return;

    const handleWorldPos = this.handleGroup.getWorldPosition(new THREE.Vector3());
    const distance = this.deps.camera.position.distanceTo(handleWorldPos);
    const scale = distance * this.HANDLE_SCREEN_SIZE;
    this.handleGroup.scale.setScalar(scale);
  }

  dispose(): void {
    this.deactivate();
  }

  // ── Placing (mousedown) ────────────────────────────────────

  private updateMouse(e: MouseEvent): void {
    const rect = this.deps.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private onPlaceDown(e: MouseEvent): void {
    if (e.button !== 0) return;

    this.updateMouse(e);

    const visibleHit = raycastVisible(this.mouse, this.deps.camera, this.deps.scene, this.deps.renderer);
    if (!visibleHit || !visibleHit.face) return;

    // World-space normal, negated so clipping removes the camera-facing side
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(visibleHit.object.matrixWorld);
    this.planeNormal.copy(visibleHit.face.normal).applyMatrix3(normalMatrix).normalize().negate();
    this.planePoint.copy(visibleHit.point);

    // Remove old plane if re-placing
    this.removeDragListeners();
    this.removeClipPlane();

    // Create new plane and exit placing mode
    this.createClipPlane();
    this.exitPlacingMode();
    this.deps.canvas.style.cursor = '';

    // Prevent this mousedown from triggering orbit controls
    e.stopPropagation();
  }

  // ── Clipping phase ─────────────────────────────────────────

  private createClipPlane(): void {
    this.clipPlane = new THREE.Plane();
    this.clipPlane.setFromNormalAndCoplanarPoint(this.planeNormal, this.planePoint);

    this.deps.renderer.clippingPlanes = [this.clipPlane];
    this.deps.renderer.localClippingEnabled = true;

    this.createHandle();
    this.addDragListeners();
  }

  private removeClipPlane(): void {
    this.deps.renderer.clippingPlanes = [];

    if (this.handleGroup) {
      this.deps.scene.remove(this.handleGroup);
      this.handleGroup.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
          child.geometry.dispose();
          const mat = child.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      });
      this.handleGroup = null;
    }

    this.clipPlane = null;
    this.dragging = false;
  }

  // ── Visual handle ──────────────────────────────────────────

  private createHandle(): void {
    this.handleGroup = new THREE.Group();
    this.handleGroup.userData.isClipHelper = true;
    this.handleGroup.position.copy(this.planePoint);

    // Ring to mark the clip location (unit-sized, scaled by update())
    const ringGeom = new THREE.RingGeometry(0.6, 1.0, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      side: THREE.DoubleSide,
      depthTest: false,
      transparent: true,
      opacity: 0.8,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.renderOrder = 999;
    ring.userData.isClipHelper = true;

    const target = new THREE.Vector3().copy(this.planePoint).add(this.planeNormal);
    ring.lookAt(target);

    this.handleGroup.add(ring);

    // Arrow showing clip direction (unit-sized)
    const arrowHelper = new THREE.ArrowHelper(
      this.planeNormal.clone(),
      new THREE.Vector3(0, 0, 0),
      2.0,
      0x3b82f6,
      0.6,
      0.3,
    );
    arrowHelper.traverse((child) => {
      child.userData.isClipHelper = true;
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.renderOrder = 999;
        const mat = child.material as THREE.Material;
        mat.depthTest = false;
      }
    });
    this.handleGroup.add(arrowHelper);

    this.deps.scene.add(this.handleGroup);
  }

  private updateHandlePosition(): void {
    if (!this.handleGroup || !this.clipPlane) return;

    const offset = this.clipPlane.distanceToPoint(this.planePoint);
    this.handleGroup.position.copy(this.planePoint).addScaledVector(this.planeNormal, -offset);
  }

  // ── Drag to move plane ─────────────────────────────────────

  private addDragListeners(): void {
    this.deps.canvas.addEventListener('pointerdown', this.boundOnPointerDown);
    this.deps.canvas.addEventListener('pointermove', this.boundOnPointerMove);
    this.deps.canvas.addEventListener('pointerup', this.boundOnPointerUp);
  }

  private removeDragListeners(): void {
    this.deps.canvas.removeEventListener('pointerdown', this.boundOnPointerDown);
    this.deps.canvas.removeEventListener('pointermove', this.boundOnPointerMove);
    this.deps.canvas.removeEventListener('pointerup', this.boundOnPointerUp);
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.handleGroup || !this.clipPlane) return;
    if (e.button !== 0) return;
    if (this.placing) return;

    this.updateMouse(e);
    this.raycaster.setFromCamera(this.mouse, this.deps.camera);

    const handlePos = this.handleGroup.getWorldPosition(new THREE.Vector3());
    const dist = this.deps.camera.position.distanceTo(handlePos);
    const hitRadius = dist * this.HANDLE_SCREEN_SIZE * 1.5;
    const hitSphere = new THREE.Sphere(handlePos, hitRadius);

    const ray = this.raycaster.ray;
    if (!ray.intersectsSphere(hitSphere)) return;

    this.dragging = true;
    this.dragPrevY = e.clientY;
    this.deps.canvas.style.cursor = 'ns-resize';
    this.deps.canvas.setPointerCapture(e.pointerId);

    e.preventDefault();
    e.stopPropagation();
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.clipPlane || !this.handleGroup) return;
    if (this.placing) return;

    if (this.dragging) {
      const deltaY = e.clientY - this.dragPrevY;
      this.dragPrevY = e.clientY;

      const speed = this.getModelSize() * 0.002;
      const movement = -deltaY * speed;

      this.clipPlane.constant -= movement;
      this.updateHandlePosition();

      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Hover cursor when near handle
    this.updateMouse(e);
    this.raycaster.setFromCamera(this.mouse, this.deps.camera);

    const handlePos = this.handleGroup.getWorldPosition(new THREE.Vector3());
    const dist = this.deps.camera.position.distanceTo(handlePos);
    const hitRadius = dist * this.HANDLE_SCREEN_SIZE * 1.5;
    const hoverSphere = new THREE.Sphere(handlePos, hitRadius);

    const ray = this.raycaster.ray;
    this.deps.canvas.style.cursor = ray.intersectsSphere(hoverSphere) ? 'ns-resize' : '';
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.dragging) {
      this.dragging = false;
      this.deps.canvas.style.cursor = '';
      this.deps.canvas.releasePointerCapture(e.pointerId);
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private getModelSize(): number {
    const box = new THREE.Box3();
    this.deps.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && !obj.userData.isClipHelper) {
        box.expandByObject(obj);
      }
    });
    if (box.isEmpty()) return 10;
    const size = box.getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z);
  }
}
