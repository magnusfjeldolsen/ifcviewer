import * as THREE from 'three';
import type { Tool } from './Tool';
import { raycastVisible } from '../utils/raycast';

export interface ClippingToolDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /**
   * Optional render-on-demand hook. The tool calls this whenever it
   * mutates visible state (creating / removing the clip plane, dragging
   * the handle, etc.) so the viewer's animate loop draws the next frame.
   * No-op if not provided — viewer falls back to its previous always-render
   * behaviour.
   */
  requestRender?: () => void;
  /**
   * Stop a camera fly-to in progress. Grabbing the handle claims the press
   * before the animation's own interrupt listener sees it, so without this the
   * camera would keep gliding under the drag.
   */
  cancelCameraAnimation?: () => void;
}

/**
 * Compute the signed world-units to advance the clip plane along its normal
 * for a given cursor pixel delta.
 *
 * Strategy: project the plane normal into screen space (in pixels), project
 * the cursor delta onto that screen direction, then convert pixels-along-normal
 * to world units using the perspective-correct world-per-pixel factor at the
 * handle's depth.
 *
 * Apply with `clipPlane.constant -= computePlaneDelta(...)`. In THREE.Plane the
 * signed distance from the origin to the plane along the normal is `-constant`,
 * so subtracting a positive delta moves the plane forward along its normal.
 *
 * Returns 0 when the normal projects to a near-zero screen vector (i.e. the
 * normal is roughly parallel to the view direction and dragging it has no
 * visible meaning). No NaN, no crash.
 */
export function computePlaneDelta(args: {
  handlePos: THREE.Vector3;
  planeNormal: THREE.Vector3;
  camera: THREE.PerspectiveCamera;
  canvasRect: { width: number; height: number };
  cursorDeltaPx: { x: number; y: number };
}): number {
  const { handlePos, planeNormal, camera, canvasRect, cursorDeltaPx } = args;

  // Step 1: project handle and (handle + normal) to NDC, then to pixel offsets.
  const hNdc = handlePos.clone().project(camera);
  const nNdc = handlePos.clone().add(planeNormal).project(camera);

  const halfW = canvasRect.width / 2;
  const halfH = canvasRect.height / 2;

  const nPxX = (nNdc.x - hNdc.x) * halfW;
  // NDC-Y is +up; screen-Y is +down. Flip so the result is in screen-pixel space.
  const nPxY = -(nNdc.y - hNdc.y) * halfH;

  const len = Math.sqrt(nPxX * nPxX + nPxY * nPxY);
  if (len < 1e-3) {
    // Normal parallel to view direction — no meaningful screen direction.
    return 0;
  }

  // Step 2: project cursor delta onto the (un-normalized) normal direction,
  // dividing by the length to get pixels along the unit screen direction.
  const pixelsAlongNormal = (cursorDeltaPx.x * nPxX + cursorDeltaPx.y * nPxY) / len;

  // Step 3: perspective-aware world-per-pixel at the handle's depth.
  const dist = camera.position.distanceTo(handlePos);
  const fovRad = (camera.fov * Math.PI) / 180;
  const worldPerPx = (2 * dist * Math.tan(fovRad / 2)) / canvasRect.height;

  // Step 4: combined world delta along the plane normal.
  return pixelsAlongNormal * worldPerPx;
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

  // Drag state. Only the pointer that grabbed the handle moves the plane; a
  // second finger must neither move it too nor start navigating underneath.
  private dragPointerId: number | null = null;
  private dragPrev = new THREE.Vector2();

  // State-change listeners for the contextual-action tray (and any other
  // observer that wants to react to clip-plane create/remove transitions).
  // Pattern mirrors SelectionManager.onChange — pure additive surface.
  private stateListeners: Array<() => void> = [];

  // Constant screen-size factor
  private readonly HANDLE_SCREEN_SIZE = 0.03;

  // Bound handlers
  private boundOnPlaceDown: (e: MouseEvent) => void;
  private boundOnPointerDown: (e: PointerEvent) => void;
  private boundOnPointerMove: (e: PointerEvent) => void;
  private boundOnPointerUp: (e: PointerEvent) => void;
  private boundOnLostCapture: (e: PointerEvent) => void;

  constructor(deps: ClippingToolDeps) {
    this.deps = deps;
    this.boundOnPlaceDown = this.onPlaceDown.bind(this);
    this.boundOnPointerDown = this.onPointerDown.bind(this);
    this.boundOnPointerMove = this.onPointerMove.bind(this);
    this.boundOnPointerUp = this.onPointerUp.bind(this);
    this.boundOnLostCapture = this.onLostCapture.bind(this);
  }

  activate(): void {
    if (this.clipPlane) {
      // Clip plane already exists — resume drag interaction
      this.addDragListeners();
    } else {
      this.enterPlacingMode();
    }
  }

  deactivate(): void {
    this.exitPlacingMode();
    this.removeDragListeners();
    this.deps.canvas.style.cursor = '';
    // Clip plane and handle persist — only clearClipPlane() removes them
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

  /** Remove the clip plane, handle, and all state. Used by Reset View. */
  clearClipPlane(): void {
    this.removeDragListeners();
    this.removeClipPlane();
  }

  /**
   * Grow `box` to cover the handle as drawn — the ring and the arrow, which
   * keep a constant size on screen. The viewer keeps this box between its
   * clipping planes, so the handle can never be dragged out of sight beyond
   * the far plane, nor cut by the near plane when the camera is beside it.
   */
  expandViewBounds(box: THREE.Box3): void {
    if (!this.handleGroup) return;
    const centre = this.handleGroup.getWorldPosition(new THREE.Vector3());
    // Unit ring of radius 1 and an arrow of length 2, scaled by `update()`.
    const reach = this.handleGroup.scale.x * 2;
    box.expandByPoint(centre.clone().addScalar(reach));
    box.expandByPoint(centre.clone().addScalar(-reach));
  }

  /** True while the handle is being dragged. */
  isDragging(): boolean {
    return this.dragPointerId !== null;
  }

  /** True when a clip plane is currently active. */
  hasClipPlane(): boolean {
    return this.clipPlane !== null;
  }

  /**
   * Subscribe to plane state transitions (create / remove). Listener fires
   * after the transition is fully applied. Returns an unsubscribe callback.
   */
  onStateChange(cb: () => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      this.stateListeners = this.stateListeners.filter((l) => l !== cb);
    };
  }

  /**
   * The clip plane in world space, or null. What lies on its negative side
   * (\distanceToPoint < 0\) is cut away. Read-only: move it with the handle.
   */
  getClipPlane(): Readonly<THREE.Plane> | null {
    return this.clipPlane;
  }

  /** Subscribe to the plane being moved (fires once a handle drag ends). */
  onPlaneMoved(cb: () => void): () => void {
    this.movedListeners.push(cb);
    return () => {
      this.movedListeners = this.movedListeners.filter((l) => l !== cb);
    };
  }

  private movedListeners: Array<() => void> = [];

  private notifyStateChange(): void {
    // The clip-plane create/remove transition affects geometry visibility
    // even when the camera is idle — request a frame before listeners run.
    this.deps.requestRender?.();
    for (const cb of this.stateListeners) cb();
  }

  dispose(): void {
    this.deactivate();
    // clearClipPlane → removeClipPlane fires notifyStateChange before we
    // null out listeners below, so live observers see the final transition.
    this.clearClipPlane();
    this.stateListeners = [];
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

    this.notifyStateChange();
  }

  private removeClipPlane(): void {
    // Only notify on an actual transition. When createClipPlane() calls
    // removeClipPlane() before installing a new plane, this is a no-op
    // (had === false) and the create-side notifier fires the single event.
    const had = this.clipPlane !== null;

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
    this.endDrag();

    if (had) this.notifyStateChange();
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
    // Capture phase: at the target, capturing listeners run before the
    // viewer's own (registered earlier, non-capturing), so a press on the
    // handle can claim the gesture before navigation ever sees it.
    this.deps.canvas.addEventListener('pointerdown', this.boundOnPointerDown, { capture: true });
    this.deps.canvas.addEventListener('pointermove', this.boundOnPointerMove);
    this.deps.canvas.addEventListener('pointerup', this.boundOnPointerUp);
    // A drag can also end without a pointerup: the browser cancels it (a
    // touch turned into a scroll, a palm rejected) or capture is lost.
    this.deps.canvas.addEventListener('pointercancel', this.boundOnPointerUp);
    this.deps.canvas.addEventListener('lostpointercapture', this.boundOnLostCapture);
  }

  private removeDragListeners(): void {
    this.deps.canvas.removeEventListener('pointerdown', this.boundOnPointerDown, { capture: true });
    this.deps.canvas.removeEventListener('pointermove', this.boundOnPointerMove);
    this.deps.canvas.removeEventListener('pointerup', this.boundOnPointerUp);
    this.deps.canvas.removeEventListener('pointercancel', this.boundOnPointerUp);
    this.deps.canvas.removeEventListener('lostpointercapture', this.boundOnLostCapture);
    this.endDrag();
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.handleGroup || !this.clipPlane) return;
    if (this.dragPointerId !== null) {
      // Another finger while the handle is held: keep it away from the plane
      // and from navigation alike, or it would orbit the view under the drag.
      if (e.pointerId !== this.dragPointerId) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
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

    this.dragPointerId = e.pointerId;
    this.dragPrev.set(e.clientX, e.clientY);
    this.deps.canvas.style.cursor = 'ns-resize';
    this.deps.canvas.setPointerCapture(e.pointerId);
    // A fly-to still running would keep moving the camera under the drag.
    this.deps.cancelCameraAnimation?.();

    // Immediate: the viewer's orbit and OrbitControls' pan listen on this same
    // canvas, and plain stopPropagation does not stop listeners on the target.
    // Without it the drag moved the plane and orbited the camera at once.
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.clipPlane || !this.handleGroup) return;
    if (this.placing) return;

    if (this.dragPointerId !== null) {
      if (e.pointerId !== this.dragPointerId) return;
      const cursorDeltaPx = {
        x: e.clientX - this.dragPrev.x,
        y: e.clientY - this.dragPrev.y,
      };
      this.dragPrev.set(e.clientX, e.clientY);

      const handlePos = this.handleGroup.getWorldPosition(new THREE.Vector3());
      const rect = this.deps.canvas.getBoundingClientRect();
      const worldDelta = computePlaneDelta({
        handlePos,
        planeNormal: this.planeNormal,
        camera: this.deps.camera,
        canvasRect: { width: rect.width, height: rect.height },
        cursorDeltaPx,
      });

      this.clipPlane.constant -= worldDelta;
      this.updateHandlePosition();
      // Drag updates mutate plane.constant — the camera hasn't moved, so
      // OrbitControls won't fire 'change'. Request a render explicitly.
      this.deps.requestRender?.();

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
    if (e.pointerId === this.dragPointerId) this.endDrag();
  }

  private onLostCapture(e: PointerEvent): void {
    if (e.pointerId === this.dragPointerId) this.endDrag();
  }

  /** Let go of the handle, however the drag ended. Safe to call when idle. */
  private endDrag(): void {
    const id = this.dragPointerId;
    if (id === null) return;
    this.dragPointerId = null;
    this.deps.canvas.style.cursor = '';
    if (this.deps.canvas.hasPointerCapture?.(id)) this.deps.canvas.releasePointerCapture(id);
    for (const cb of this.movedListeners) cb();
  }
}
