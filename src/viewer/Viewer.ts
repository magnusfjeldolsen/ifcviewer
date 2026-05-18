import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { raycastVisible } from '../utils/raycast';
import { computeFitPosition } from './cameraUtils';
import { CameraAnimator } from './CameraAnimator';

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
  private _controlsMode: 'user' | 'animating' | 'pivot-transition' = 'user';
  private mouse = new THREE.Vector2();
  private pivotMarker: THREE.Mesh | null = null;
  private defaultTarget = new THREE.Vector3();
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
    this.controls.addEventListener('start', () => {
      this.setControlsMode('user');
    });
    // OrbitControls 'change' fires whenever camera or target moves —
    // including programmatic moves through controls.update(). Hooking
    // it here covers most user interactions (orbit/pan/zoom), the tail
    // of an inertial drag, and fitToBox / restoreCameraState which both
    // call controls.update().
    this.controls.addEventListener('change', this.boundRequestRender);

    this.setupLights();
    this.setupGrid();
    this.setupPivotClick();

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

  setControlsMode(mode: 'user' | 'animating' | 'pivot-transition'): void {
    this._controlsMode = mode;
  }

  getControlsMode(): 'user' | 'animating' | 'pivot-transition' {
    return this._controlsMode;
  }

  /**
   * Temporarily enable / disable the OrbitControls. Used by the marquee
   * selector to suspend orbit-drag while the user is Alt-dragging a
   * selection rectangle. Callers MUST restore the previous value when
   * their gesture ends (pointerup, Esc).
   */
  setControlsEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
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
    this.updatePivotMarkerScale();
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

  resetPivot(): void {
    this._controlsMode = 'user';
    this.controls.target.copy(this.defaultTarget);
    this.controls.update();
    this.removePivotMarker();
    this.needsRender = true;
  }

  clearPivot(): void {
    this._controlsMode = 'user';
    if (this.pickingPivot) this.cancelPivotPicking();
    this.removePivotMarker();
    this.needsRender = true;
  }

  dispose(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('click', this.boundPivotClick);
    this.removePivotMarker();
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

  // ── Pivot picking ───────────────���────────────────────────

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
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const hit = raycastVisible(this.mouse, this.camera, this.scene, this.renderer);
    if (!hit) {
      this.cancelPivotPicking();
      return;
    }

    const point = hit.point;
    this.controls.target.copy(point);
    this._controlsMode = 'pivot-transition';

    this.showPivotMarker(point);
    this.cancelPivotPicking();
    this.needsRender = true;
  }

  private showPivotMarker(point: THREE.Vector3): void {
    this.removePivotMarker();

    const geom = new THREE.SphereGeometry(1, 12, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      depthTest: false,
      transparent: true,
      opacity: 0.6,
    });
    this.pivotMarker = new THREE.Mesh(geom, mat);
    this.pivotMarker.position.copy(point);
    this.pivotMarker.renderOrder = 998;
    this.pivotMarker.userData.isPivotMarker = true;
    this.scene.add(this.pivotMarker);
  }

  private updatePivotMarkerScale = (): void => {
    if (!this.pivotMarker) return;
    const dist = this.camera.position.distanceTo(this.pivotMarker.position);
    const scale = dist * 0.008;
    this.pivotMarker.scale.setScalar(scale);
  };

  private removePivotMarker(): void {
    if (this.pivotMarker) {
      this.scene.remove(this.pivotMarker);
      this.pivotMarker.geometry.dispose();
      (this.pivotMarker.material as THREE.Material).dispose();
      this.pivotMarker = null;
    }
  }
}
