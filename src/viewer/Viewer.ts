import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { raycastVisible } from '../utils/raycast';
import { computeFitPosition } from './cameraUtils';
import { CameraAnimator } from './CameraAnimator';
import {
  rotateAboutPivot,
  dollyTowardPoint,
  anchorInFront,
  resolvePivot,
  type CameraPose,
  type ResolvedPivot,
} from './orbitMath';

/** Radians of rotation per screen height dragged. Matches OrbitControls' feel. */
const ROTATE_SPEED = 1;

/**
 * Fraction of the distance to the focus point closed by one wheel notch.
 * Geometric, so it brakes as it approaches without ever stalling — see
 * `dollyTowardPoint`.
 */
const WHEEL_ZOOM_STEP = 0.9;

/** Keep the camera this many near-planes away from whatever it is zooming at. */
const MIN_FOCUS_NEAR_PLANES = 2;

/**
 * Pixels of movement before a left-drag counts as an orbit rather than a click.
 * Mirrors the threshold SelectionManager uses to tell a click from a drag, so
 * the two agree about which gesture the user made.
 */
const DRAG_THRESHOLD = 3;

interface RotateGesture {
  pointerId: number;
  /** Where the gesture began, for the click-vs-drag threshold. */
  startX: number;
  startY: number;
  /** Last position a rotation was applied from. */
  x: number;
  y: number;
  /** Resolved once per gesture — see `resolvePivot`. */
  pivot: THREE.Vector3;
  transient: boolean;
  active: boolean;
}

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private canvas: HTMLCanvasElement;
  private animationId: number | null = null;
  private updateCallbacks: Array<() => void> = [];

  /**
   * Render-on-demand gate. The animate loop still runs at requestAnimationFrame
   * cadence so it can poll `controls.update()` (which dispatches 'change'
   * events at the right times), but we only call `renderer.render` and the
   * `updateCallbacks` when something has actually changed.
   *
   * Initial value `true` so the first frame after construction draws the
   * empty scene. Cleared after each render. Set by `requestRender()`, by
   * the OrbitControls 'change' event, and by every Viewer method that
   * mutates visible state (fit/fly/pivot ops, resize).
   */
  private needsRender = true;

  // Pivot picking state
  private pickingPivot = false;
  private _controlsMode: 'user' | 'animating' = 'user';
  private mouse = new THREE.Vector2();
  private pivotMarker: THREE.Mesh | null = null;
  private transientMarker: THREE.Mesh | null = null;

  /**
   * The rotation centre the user placed with the pivot tool, or null.
   *
   * Deliberately NOT `controls.target`: that field is also the point
   * OrbitControls makes the camera look at every frame, so putting a pivot
   * there re-centres the view. `controls.target` is only ever a view anchor on
   * the camera's forward axis now — see `orbitMath.ts`.
   */
  private placedPivot: THREE.Vector3 | null = null;

  /** Last-resort rotation centre: the centre of the last fit. */
  private defaultTarget = new THREE.Vector3();

  /**
   * Where the current selection sits, when there is one. Wired by App.
   * Used as a fallback pivot for orbits started over empty space, the way
   * Revit and Navisworks centre the pivot on the selection.
   */
  private selectionCenter: (() => THREE.Vector3 | null) | null = null;

  private rotateGesture: RotateGesture | null = null;
  /** Last pointer position over the canvas, in client coords. */
  private lastPointer: { x: number; y: number } | null = null;
  private touchPointers = new Map<number, { x: number; y: number }>();
  private pinchDistance: number | null = null;

  private boundPivotClick!: (e: MouseEvent) => void;
  private animator = new CameraAnimator();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf0f0f0);

    this.camera = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    this.camera.position.set(10, 10, 10);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;

    // Rotate and zoom are ours, so they can happen about the cursor rather
    // than about the view anchor. Pan stays theirs: it already translates
    // camera and anchor together, which is exactly what keeps the anchor on
    // the forward axis.
    //
    // `enableRotate` rather than `mouseButtons.LEFT = null`, because three
    // reaches its rotate handler from several directions — left-drag, but also
    // ctrl/shift + right-drag, and one-finger touch. Leaving any of those live
    // would give us a second orbit that turns about the anchor and quietly
    // ignores the pivot the user aimed at. One flag closes them all; we
    // implement one-finger touch rotate ourselves below, about the same pivot
    // as the mouse. The ctrl/shift + left-drag *pan* path survives, because
    // three checks the modifier before it checks `enableRotate`.
    this.controls.enableRotate = false;
    // `enableZoom` governs the wheel AND the pinch, so switching it off costs
    // us the pinch as well; `updatePinch` implements that gesture instead,
    // aimed at the midpoint of the two fingers. Two-finger drag degrades to
    // OrbitControls' pan, which is exactly what we want it to keep doing.
    this.controls.enableZoom = false;

    // Pan moves to the middle button, the CAD convention (Revit, Navisworks
    // and Fusion all pan with MMB). Right-drag used to pan, but right-click
    // also opens our context menu, so the two gestures were fighting over the
    // same button. Middle was free besides: it defaulted to dolly, which
    // `enableZoom = false` had just switched off.
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = null;

    this.controls.addEventListener('start', this.onControlsStart);
    // OrbitControls 'change' fires whenever camera or target moves —
    // including programmatic moves through controls.update(). Hooking
    // it here covers most user interactions (orbit/pan/zoom), the tail
    // of an inertial drag, and fitToBox / restoreCameraState which both
    // call controls.update().
    this.controls.addEventListener('change', this.boundRequestRender);

    this.setupLights();
    this.setupGrid();
    this.setupPivotClick();
    this.setupNavigation();

    window.addEventListener('resize', this.onResize);
  }

  getScene(): THREE.Scene {
    return this.scene;
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  onUpdate(callback: () => void): void {
    this.updateCallbacks.push(callback);
  }

  /**
   * Tell the viewer where the current selection is, so an orbit started over
   * empty space can fall back to it. Returning null means "no selection".
   */
  setSelectionCenterProvider(provider: () => THREE.Vector3 | null): void {
    this.selectionCenter = provider;
  }

  /**
   * Queue a render for the next animate tick. Cheap and idempotent —
   * setting the flag multiple times in one frame still costs one render.
   *
   * Anything that mutates visible scene state must call this. The
   * OrbitControls 'change' event handles camera-driven mutations
   * automatically; tools, model add/remove, highlights, and scene-level
   * mutations call it explicitly via the wiring in App and module
   * constructors.
   */
  requestRender(): void {
    this.needsRender = true;
  }

  /** Stable bound reference for add/removeEventListener. */
  private boundRequestRender = (): void => {
    this.needsRender = true;
  };

  getCameraState(): { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } } {
    return {
      position: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      target: { x: this.controls.target.x, y: this.controls.target.y, z: this.controls.target.z },
    };
  }

  setControlsMode(mode: 'user' | 'animating'): void {
    this._controlsMode = mode;
  }

  getControlsMode(): 'user' | 'animating' {
    return this._controlsMode;
  }

  /**
   * Temporarily enable / disable the OrbitControls. Used by the marquee
   * selector to suspend orbit-drag while the user is Alt-dragging a
   * selection rectangle. Callers MUST restore the previous value when
   * their gesture ends (pointerup, Esc).
   *
   * Our own rotate/zoom handlers honour the same flag, so one call still
   * suspends every navigation gesture.
   */
  setControlsEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
    if (!enabled) this.endRotateGesture();
  }

  restoreCameraState(state: { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } }): void {
    this._controlsMode = 'user';
    this.camera.position.set(state.position.x, state.position.y, state.position.z);
    this.controls.target.set(state.target.x, state.target.y, state.target.z);
    this.controls.update();
  }

  animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);
    // Always poll OrbitControls in user mode so the 'change' event fires
    // when the camera moves (including inertia/damping if ever enabled).
    // The 'change' listener flips needsRender on, so we render only on
    // frames where something visible actually changed.
    if (this._controlsMode === 'user') {
      this.controls.update();
    }
    if (!this.needsRender) return;
    this.needsRender = false;
    for (const cb of this.updateCallbacks) cb();
    this.updateMarkerScales();
    this.renderer.render(this.scene, this.camera);
  };

  fitToBox(box: THREE.Box3): void {
    const fit = computeFitPosition(box);
    if (!fit) return;

    this.camera.position.copy(fit.position);
    this.camera.near = fit.near;
    this.camera.far = fit.far;
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(fit.center);
    this.controls.update();

    this.defaultTarget.copy(fit.center);
  }

  flyToBox(box: THREE.Box3): Promise<void> {
    const fit = computeFitPosition(box);
    if (!fit) return Promise.resolve();

    return this.animator.flyTo({
      camera: this.camera,
      controls: this.controls,
      canvas: this.canvas,
      targetPosition: fit.position,
      targetLookAt: fit.center,
      near: fit.near,
      far: fit.far,
      onStart: () => this.setControlsMode('animating'),
      onTick: this.boundRequestRender,
      onComplete: () => {
        this.setControlsMode('user');
        this.defaultTarget.copy(fit.center);
      },
      onInterrupt: () => {
        this.setControlsMode('user');
      },
    });
  }

  /** Forget the placed pivot; orbits fall back to the fit centre again. */
  resetPivot(): void {
    this._controlsMode = 'user';
    this.placedPivot = null;
    this.removePivotMarker();
    this.needsRender = true;
  }

  clearPivot(): void {
    this._controlsMode = 'user';
    if (this.pickingPivot) this.cancelPivotPicking();
    this.placedPivot = null;
    this.removePivotMarker();
    this.needsRender = true;
  }

  dispose(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('click', this.boundPivotClick);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.controls.removeEventListener('start', this.onControlsStart);
    this.removePivotMarker();
    this.removeTransientMarker();
    this.controls.dispose();
    this.renderer.dispose();
  }

  private setupLights(): void {
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(10, 20, 10);
    this.scene.add(directional);
  }

  private setupGrid(): void {
    const grid = new THREE.GridHelper(50, 50);
    this.scene.add(grid);
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.needsRender = true;
  };

  // ── Navigation: orbit and zoom about the cursor ────────────

  private setupNavigation(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    // Non-passive so the page doesn't scroll behind the viewer.
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  /** Gather what the scene can offer as a pivot and let `resolvePivot` rank it. */
  private pivotFor(clientX: number, clientY: number): ResolvedPivot {
    const hit = this.raycastAt(clientX, clientY);
    const selection = this.selectionCenter?.() ?? null;
    return resolvePivot({
      hit: hit ? hit.point : null,
      selection,
      selectionOnScreen: selection !== null && this.isOnScreen(selection),
      placed: this.placedPivot,
      placedOnScreen: this.placedPivot !== null && this.isOnScreen(this.placedPivot),
      fallback: this.defaultTarget,
    });
  }

  private raycastAt(clientX: number, clientY: number): THREE.Intersection | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    return raycastVisible(this.mouse, this.camera, this.scene, this.renderer);
  }

  private isOnScreen(point: THREE.Vector3): boolean {
    const ndc = point.clone().project(this.camera);
    return ndc.z > -1 && ndc.z < 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
  }

  /** True when navigation gestures are allowed to act right now. */
  private canNavigate(): boolean {
    return this.controls.enabled && !this.pickingPivot;
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.lastPointer = { x: e.clientX, y: e.clientY };

    if (e.pointerType === 'touch') {
      this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touchPointers.size >= 2) {
        // A second finger turns the gesture into pinch-and-pan; whatever the
        // first one had started is over.
        this.endRotateGesture();
        this.pinchDistance = this.touchPointers.size === 2 ? this.currentPinchDistance() : null;
        return;
      }
      this.pinchDistance = null;
    } else {
      // Middle-drag pans; claim the event so the browser doesn't start its
      // autoscroll instead. OrbitControls never calls preventDefault on
      // pointerdown itself.
      if (e.button === 1) e.preventDefault();
      if (e.button !== 0) return;
      // Alt-drag belongs to the marquee selector; ctrl / shift / meta stay
      // with OrbitControls' pan, and are the selection modifiers besides.
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    }

    if (!this.canNavigate()) return;

    const { point, transient } = this.pivotFor(e.clientX, e.clientY);
    this.rotateGesture = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      pivot: point,
      transient,
      active: false,
    };
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.lastPointer = { x: e.clientX, y: e.clientY };

    if (e.pointerType === 'touch') {
      if (!this.touchPointers.has(e.pointerId)) return;
      this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touchPointers.size >= 2) {
        this.updatePinch();
        return;
      }
      // A single finger falls through to the shared rotate path below.
    }

    const gesture = this.rotateGesture;
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    if (!this.canNavigate()) {
      this.endRotateGesture();
      return;
    }

    if (!gesture.active) {
      const travelled = Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY);
      if (travelled < DRAG_THRESHOLD) return;
      gesture.active = true;
      // Only now is it certainly an orbit and not a click, so only now is it
      // worth telling the user what they are turning about.
      if (gesture.transient) this.showTransientMarker(gesture.pivot);
      // Rotate from here, so crossing the threshold doesn't jump the view.
      gesture.x = e.clientX;
      gesture.y = e.clientY;
      this.canvas.setPointerCapture?.(e.pointerId);
      return;
    }

    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    gesture.x = e.clientX;
    gesture.y = e.clientY;

    const height = this.canvas.clientHeight || this.canvas.height || 1;
    this.applyPose(
      rotateAboutPivot({
        position: this.camera.position,
        target: this.controls.target,
        pivot: gesture.pivot,
        // Both negative so the gesture matches what OrbitControls did: drag
        // right turns the model right, drag down tips the top toward you.
        azimuth: (-2 * Math.PI * dx * ROTATE_SPEED) / height,
        polar: (-2 * Math.PI * dy * ROTATE_SPEED) / height,
        up: this.camera.up,
      }),
    );
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      this.touchPointers.delete(e.pointerId);
      if (this.touchPointers.size < 2) this.pinchDistance = null;
    }
    if (this.rotateGesture && e.pointerId === this.rotateGesture.pointerId) {
      this.canvas.releasePointerCapture?.(e.pointerId);
      this.endRotateGesture();
    }
  };

  private endRotateGesture(): void {
    this.rotateGesture = null;
    this.removeTransientMarker();
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.canNavigate()) return;
    if (e.deltaY === 0) return;
    e.preventDefault();

    this.lastPointer = { x: e.clientX, y: e.clientY };
    const { point } = this.pivotFor(e.clientX, e.clientY);
    this.dollyTo(point, e.deltaY > 0 ? 1 / WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP);
  };

  private currentPinchDistance(): number | null {
    const points = [...this.touchPointers.values()];
    if (points.length !== 2) return null;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  /**
   * Pinch-to-zoom, aimed at the midpoint of the two fingers — the touch
   * equivalent of zooming at the cursor. OrbitControls still handles the
   * two-finger pan alongside this; only its dolly half is switched off.
   */
  private updatePinch(): void {
    if (this.touchPointers.size !== 2 || this.pinchDistance === null) return;
    if (!this.canNavigate()) return;

    const distance = this.currentPinchDistance();
    if (distance === null || distance < 1) return;

    const scale = this.pinchDistance / distance;
    this.pinchDistance = distance;
    if (Math.abs(scale - 1) < 1e-4) return;

    const points = [...this.touchPointers.values()];
    const { point } = this.pivotFor(
      (points[0].x + points[1].x) / 2,
      (points[0].y + points[1].y) / 2,
    );
    this.dollyTo(point, scale);
  }

  private dollyTo(focus: THREE.Vector3, scale: number): void {
    this.applyPose(
      dollyTowardPoint({
        position: this.camera.position,
        target: this.controls.target,
        focus,
        scale,
        minDistance: this.camera.near * MIN_FOCUS_NEAR_PLANES,
        maxDistance: this.camera.far,
      }),
    );
  }

  /**
   * OrbitControls only handles pan now. Its pan speed scales with the depth of
   * `controls.target`, which used to sit on geometry; as a free-floating view
   * anchor it can be at any distance, so re-derive that depth from whatever is
   * under the cursor before the gesture starts. (Blender does the same, for
   * the same reason, under "Auto Depth".)
   */
  private onControlsStart = (): void => {
    this._controlsMode = 'user';
    this.syncAnchorDepth();
  };

  private syncAnchorDepth(): void {
    if (!this.lastPointer) return;
    const hit = this.raycastAt(this.lastPointer.x, this.lastPointer.y);
    if (!hit) return;
    this.controls.target.copy(
      anchorInFront(this.camera.position, this.controls.target, hit.distance),
    );
  }

  /**
   * Camera and anchor move together, by construction, so `lookAt` only ever
   * re-derives the orientation the rotation already implies — it can never
   * snap the view somewhere the user didn't ask for.
   */
  private applyPose(pose: CameraPose): void {
    this.camera.position.copy(pose.position);
    this.controls.target.copy(pose.target);
    this.camera.lookAt(this.controls.target);
    this.needsRender = true;
  }

  // ── Pivot picking ─────────────────────────────────────────

  private setupPivotClick(): void {
    this.boundPivotClick = (e: MouseEvent) => {
      if (!this.pickingPivot) return;
      this.placePivot(e);
    };

    this.canvas.addEventListener('click', this.boundPivotClick);
  }

  togglePivotPicking(): void {
    if (this.pickingPivot) {
      this.cancelPivotPicking();
    } else {
      this.pickingPivot = true;
      this.canvas.style.cursor = 'crosshair';
    }
  }

  cancelPivotPicking(): void {
    this.pickingPivot = false;
    this.canvas.style.cursor = '';
  }

  isPivotPicking(): boolean {
    return this.pickingPivot;
  }

  private placePivot(e: MouseEvent): void {
    const hit = this.raycastAt(e.clientX, e.clientY);
    if (!hit) {
      this.cancelPivotPicking();
      return;
    }

    // Note what has NOT changed: the camera and `controls.target`. Placing a
    // pivot records a rotation centre and nothing else, so the view cannot
    // move — not now, and not on the first orbit afterwards.
    this.placedPivot = hit.point.clone();

    this.showPivotMarker(this.placedPivot);
    this.cancelPivotPicking();
    this.needsRender = true;
  }

  private showPivotMarker(point: THREE.Vector3): void {
    this.removePivotMarker();
    this.pivotMarker = this.createMarker(point, 0xef4444, 0.6);
    this.scene.add(this.pivotMarker);
  }

  /** Marks the cursor pivot for the length of one orbit, then goes away. */
  private showTransientMarker(point: THREE.Vector3): void {
    this.removeTransientMarker();
    this.transientMarker = this.createMarker(point, 0x3b82f6, 0.45);
    this.scene.add(this.transientMarker);
    this.needsRender = true;
  }

  private createMarker(point: THREE.Vector3, color: number, opacity: number): THREE.Mesh {
    const geom = new THREE.SphereGeometry(1, 12, 12);
    const mat = new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity,
    });
    const marker = new THREE.Mesh(geom, mat);
    marker.position.copy(point);
    marker.renderOrder = 998;
    marker.userData.isPivotMarker = true;
    return marker;
  }

  private updateMarkerScales = (): void => {
    for (const marker of [this.pivotMarker, this.transientMarker]) {
      if (!marker) continue;
      const dist = this.camera.position.distanceTo(marker.position);
      marker.scale.setScalar(dist * 0.008);
    }
  };

  private removePivotMarker(): void {
    this.pivotMarker = this.disposeMarker(this.pivotMarker);
  }

  private removeTransientMarker(): void {
    if (this.transientMarker) this.needsRender = true;
    this.transientMarker = this.disposeMarker(this.transientMarker);
  }

  private disposeMarker(marker: THREE.Mesh | null): null {
    if (marker) {
      this.scene.remove(marker);
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
    }
    return null;
  }
}
