import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { raycastVisible } from '../utils/raycast';
import { clippingPlanesForView, computeFitPosition, maxViewDistance } from './cameraUtils';
import { CameraAnimator } from './CameraAnimator';
import { PivotState } from './PivotState';
import {
  rotateAboutPivot,
  dollyTowardPoint,
  anchorInFront,
  resolvePivot,
  type CameraPose,
  type ResolvedPivot,
} from './orbitMath';
import { FlyController } from './FlyController';
import { exitAnchorDistance } from './flyMath';

/**
 * Who drives the camera. Exactly one at a time — see "Camera Ownership" in
 * CLAUDE.md.
 *
 * - `user`: orbit, zoom and pan; the loop polls `controls.update()`.
 * - `animating`: a `CameraAnimator` tween; the loop leaves the controls alone.
 * - `flying`: `FlyController` moves and turns the camera from keys and drags;
 *   the loop does not poll the controls, and OrbitControls' pan is off.
 */
export type ControlsMode = 'user' | 'animating' | 'flying';

/**
 * Wheel delta, in pixels, that counts as one speed step when a device sends
 * many small deltas (a trackpad). A mouse notch is ~100 px and steps once.
 */
const WHEEL_STEP_PX = 100;
/** A single wheel event at least this large is one notch on its own. */
const WHEEL_NOTCH_PX = 40;

/** Radians of rotation per screen height dragged. Matches OrbitControls' feel. */
const ROTATE_SPEED = 1;

/**
 * Fraction of the distance to the focus point closed by one wheel notch.
 * Geometric, so it brakes as it approaches without ever stalling — see
 * `dollyTowardPoint`.
 */
const WHEEL_ZOOM_STEP = 0.9;

/** Side of the square ground grid, in metres, centred on the origin. */
const GRID_SIZE = 50;

/**
 * Keep the camera this many near-planes away from whatever it is zooming at.
 *
 * Only a sane stop now that the near plane tracks the viewing distance
 * (`clippingPlanesForView`): the limit shrinks as the camera approaches, so a
 * dolly asymptotes towards a surface instead of hitting the wall a fixed near
 * plane used to put 2.26 m in front of it.
 */
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
  /** A flying-mode drag: turns the view in place instead of orbiting. */
  look: boolean;
}

/** Keys typed into these go to the field, never to flying. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private canvas: HTMLCanvasElement;
  private animationId: number | null = null;
  private updateCallbacks: Array<() => void> = [];
  private renderedCallbacks: Array<(timestamp: number, renderCpuMs: number) => void> = [];

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
  private _controlsMode: ControlsMode = 'user';

  /** Flying state; only consulted while `_controlsMode` is 'flying'. */
  private fly = new FlyController();
  private flyingListeners: Array<(flying: boolean) => void> = [];
  /** `performance.now()` of the last flying frame, null when not moving. */
  private lastFlyFrame: number | null = null;
  /** Distance the view anchor rides in front of the camera while flying. */
  private flyAnchorDistance = 1;
  /** OrbitControls' pan setting before flying switched it off. */
  private panBeforeFlying = true;
  /** Small wheel deltas, summed until they make a speed step. */
  private wheelAccumulator = 0;
  private readonly flyForward = new THREE.Vector3();
  private flyKeysSuspended: () => boolean = () => false;
  private mouse = new THREE.Vector2();
  private pivotMarker: THREE.Mesh | null = null;
  private transientMarker: THREE.Mesh | null = null;

  /**
   * The rotation centre the user placed with the pivot tool.
   *
   * Deliberately NOT `controls.target`: that field is also the point
   * OrbitControls makes the camera look at every frame, so putting a pivot
   * there re-centres the view. `controls.target` is only ever a view anchor on
   * the camera's forward axis now — see `orbitMath.ts`.
   */
  private pivot = new PivotState();

  /** Last-resort rotation centre: the centre of the last fit. */
  private defaultTarget = new THREE.Vector3();

  /** The ground grid's extent. The near plane must not cut it either. */
  private readonly gridBox = new THREE.Box3(
    new THREE.Vector3(-GRID_SIZE / 2, 0, -GRID_SIZE / 2),
    new THREE.Vector3(GRID_SIZE / 2, 0, GRID_SIZE / 2),
  );

  /**
   * Bounds of everything loaded, hidden or not. The clipping planes are sized
   * from the camera's distance to this, so the whole model fits between them
   * wherever the camera is. Until something loads the grid is all there is.
   */
  private sceneBox = this.gridBox.clone();

  /** Where `refreshSceneBounds` reads the loaded extent from. Wired by App. */
  private sceneBoundsProvider: (() => THREE.Box3) | null = null;

  /**
   * Things drawn outside the model that must stay between the planes, such as
   * the section handle. Asked on every frame the planes are recomputed.
   */
  private viewBoundsSources: Array<(box: THREE.Box3) => void> = [];

  /** `sceneBox` grown by `viewBoundsSources`, as of the last plane update. */
  private viewBox = new THREE.Box3();

  /**
   * Distance to the geometry last found under the cursor, or null when the
   * cursor was over empty space.
   *
   * It can only pull the near plane in, never push it out (see
   * `clippingPlanesForView`): outside the model it lets the dolly guard reach
   * the surface under the cursor instead of stalling at the camera's
   * clearance, and a miss merely stops it helping. Recorded by `raycastAt`,
   * which every navigation gesture already calls.
   */
  private lastHitDistance: number | null = null;

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
   * Tell the viewer how to measure everything loaded (hidden included), which
   * sizes the far plane. Read on `refreshSceneBounds` and on every fit, never
   * per frame.
   */
  setSceneBoundsProvider(provider: () => THREE.Box3): void {
    this.sceneBoundsProvider = provider;
    this.refreshSceneBounds();
  }

  /**
   * Re-measure the loaded scene. Call when models are added or removed; the
   * fits call it themselves. `fallback` is used when there is no provider.
   */
  refreshSceneBounds(fallback?: THREE.Box3): void {
    const box = this.sceneBoundsProvider?.() ?? fallback;
    if (!box || box.isEmpty()) return;
    this.sceneBox.copy(box);
    this.needsRender = true;
  }

  /**
   * Keep something drawn outside the model between the clipping planes: the
   * source grows the box it is handed to cover it. Returns an unsubscribe.
   */
  addViewBoundsSource(source: (box: THREE.Box3) => void): () => void {
    this.viewBoundsSources.push(source);
    return () => {
      this.viewBoundsSources = this.viewBoundsSources.filter((s) => s !== source);
    };
  }

  /**
   * Stop a fly-to in progress, leaving the camera where it is and in the
   * user's hands. For gestures that claim the pointer before the animation's
   * own interrupt listener can see it, like grabbing the section handle.
   */
  cancelCameraAnimation(): void {
    this.animator.cancel();
    // Flying is not an animation: grabbing the section handle mid-flight must
    // not take the camera away from the fly controls.
    if (this._controlsMode === 'animating') this._controlsMode = 'user';
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

  /**
   * Hand the camera to the user or to an animation. Flying has its own way in
   * and out (`enterFlying` / `exitFlying`), because leaving it has to put the
   * view anchor back; asking for another owner while flying leaves it first.
   */
  setControlsMode(mode: 'user' | 'animating'): void {
    if (this._controlsMode === 'flying') this.exitFlying();
    this._controlsMode = mode;
  }

  getControlsMode(): ControlsMode {
    return this._controlsMode;
  }

  // ── Flying (#98) ───────────────────────────────────────────

  isFlying(): boolean {
    return this._controlsMode === 'flying';
  }

  toggleFlying(): void {
    if (this.isFlying()) this.exitFlying();
    else this.enterFlying();
  }

  /**
   * Take the camera for flying. Leaves the camera exactly where it is; a
   * running fly-to stops where it has got to.
   */
  enterFlying(): void {
    if (this._controlsMode === 'flying') return;
    // The animator's interrupt hands back to 'user'; flying takes it from there.
    this.animator.cancel();
    this.endRotateGesture();
    this._controlsMode = 'flying';
    // OrbitControls' pan is the only gesture it still owns. Its 'start' would
    // claim the camera for 'user' mid-flight, so it sits out.
    this.panBeforeFlying = this.controls.enablePan;
    this.controls.enablePan = false;
    this.flyAnchorDistance = Math.max(this.camera.position.distanceTo(this.controls.target), 1e-3);
    this.lastFlyFrame = null;
    this.wheelAccumulator = 0;
    window.addEventListener('keydown', this.onFlyKeyDown, { capture: true });
    window.addEventListener('keyup', this.onFlyKeyUp, { capture: true });
    window.addEventListener('blur', this.onFlyBlur);
    document.addEventListener('visibilitychange', this.onFlyBlur);
    this.needsRender = true;
    for (const cb of this.flyingListeners) cb(true);
  }

  /**
   * Give the camera back to orbit. The camera does not move; the view anchor
   * goes onto its forward axis at the distance of whatever is straight ahead,
   * so OrbitControls' `lookAt` has nothing to correct and the first orbit
   * afterwards turns from exactly this view. The orbit fallback centre goes
   * there too, so an orbit over empty space turns about something in front of
   * you rather than the centre of a fit you have long since flown away from.
   */
  exitFlying(): void {
    if (this._controlsMode !== 'flying') return;
    this.fly.stop();
    this.endRotateGesture();
    window.removeEventListener('keydown', this.onFlyKeyDown, { capture: true });
    window.removeEventListener('keyup', this.onFlyKeyUp, { capture: true });
    window.removeEventListener('blur', this.onFlyBlur);
    document.removeEventListener('visibilitychange', this.onFlyBlur);
    this.controls.enablePan = this.panBeforeFlying;

    const rect = this.canvas.getBoundingClientRect();
    const hit = this.raycastAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
    this.camera.getWorldDirection(this.flyForward);
    this.controls.target
      .copy(this.camera.position)
      .addScaledVector(this.flyForward, exitAnchorDistance(hit ? hit.distance : null));
    this.defaultTarget.copy(this.controls.target);

    this._controlsMode = 'user';
    this.lastFlyFrame = null;
    this.needsRender = true;
    for (const cb of this.flyingListeners) cb(false);
  }

  /** Hear when flying starts or stops. Returns an unsubscribe. */
  onFlyingChange(cb: (flying: boolean) => void): () => void {
    this.flyingListeners.push(cb);
    return () => {
      this.flyingListeners = this.flyingListeners.filter((l) => l !== cb);
    };
  }

  /** Flying cruising speed, metres per second. Kept for the session. */
  getFlySpeed(): number {
    return this.fly.getSpeed();
  }

  onFlySpeedChange(cb: (speed: number) => void): () => void {
    return this.fly.onSpeedChange(cb);
  }

  /**
   * Whether a key event is aimed at the 3D view rather than at a control.
   * Fly keys act only then: with focus in a panel, on the toolbar or in any
   * other control, Space and the arrows keep doing what that control does.
   */
  private keyIsForView(target: EventTarget | null): boolean {
    // Not an element at all (the window, the document): nothing has focus.
    if (!(target instanceof Element)) return true;
    return target === document.body || target === document.documentElement || target === this.canvas;
  }

  /**
   * Something else is using the keyboard (an open menu or help card, say).
   * Wired by App; fly keys leave every key alone while it answers true.
   */
  setFlyKeysSuspended(isSuspended: () => boolean): void {
    this.flyKeysSuspended = isSuspended;
  }

  private onFlyKeyDown = (e: KeyboardEvent): void => {
    // macOS sends no keyup for a key released while Cmd is held, so a held W
    // would stick. Any Cmd chord lets go of everything instead.
    if (e.metaKey) {
      this.fly.releaseAll();
      return;
    }
    if (!this.keyIsForView(e.target) || isTypingTarget(e.target)) return;
    if (this.flyKeysSuspended()) return;
    // Ctrl / Alt chords are never ours: undo keeps working, and the
    // browser's own Ctrl+W / Alt+D are not something a page should touch.
    if (e.ctrlKey || e.altKey) return;
    if (!this.fly.keyDown(e.code, e.repeat)) return;
    // With focus on the view, fly keys win: no tool shortcut (S toggles
    // snapping while measuring) or page scroll (arrows, Space) sees them.
    // Capture on window runs before every other listener.
    e.preventDefault();
    e.stopPropagation();
  };

  private onFlyKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'MetaLeft' || e.code === 'MetaRight' || e.key === 'Meta') {
      this.fly.releaseAll();
      return;
    }
    // Always let go, wherever focus went in between, so no key sticks.
    if (!this.fly.keyUp(e.code)) return;
    if (e.code === 'Space' && this.keyIsForView(e.target)) e.preventDefault();
  };

  private onFlyBlur = (): void => {
    // Keyups that happen in another window never arrive.
    this.fly.releaseAll();
  };

  /** One frame of flying. Runs only while flying and something is moving. */
  private tickFlying(): void {
    if (!this.fly.isMoving()) {
      this.lastFlyFrame = null;
      return;
    }
    const now = performance.now();
    const dt = this.lastFlyFrame === null ? 1 / 60 : (now - this.lastFlyFrame) / 1000;
    this.lastFlyFrame = now;
    if (this.fly.tick(this.camera, dt)) this.syncFlyAnchor();
  }

  /** Keep the view anchor on the forward axis while the fly controls turn the camera. */
  private syncFlyAnchor(): void {
    this.camera.getWorldDirection(this.flyForward);
    this.controls.target.copy(this.camera.position).addScaledVector(this.flyForward, this.flyAnchorDistance);
    this.needsRender = true;
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
    // Every programmatic camera move leaves flying first: whoever asked for a
    // pose wants that pose, not a flight that carries on from it.
    this.exitFlying();
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
    } else if (this._controlsMode === 'flying') {
      this.tickFlying();
    }
    if (!this.needsRender) return;
    this.needsRender = false;
    for (const cb of this.updateCallbacks) cb();
    // One place, so no camera path can forget: orbit, dolly, pan, fit, a
    // flyTo tween and a session restore all end up here before the draw.
    this.updateClipping();
    this.updateMarkerScales();
    if (this.renderedCallbacks.length === 0) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const start = performance.now();
    this.renderer.render(this.scene, this.camera);
    const end = performance.now();
    for (const cb of this.renderedCallbacks) cb(end, end - start);
  };

  /**
   * Hear about every frame actually drawn, with the CPU time spent inside
   * `renderer.render`. Only the `?stats` debug surface subscribes; with no
   * subscriber the render loop does not even read the clock.
   */
  onRendered(callback: (timestamp: number, renderCpuMs: number) => void): () => void {
    this.renderedCallbacks.push(callback);
    return () => {
      this.renderedCallbacks = this.renderedCallbacks.filter((cb) => cb !== callback);
    };
  }

  fitToBox(box: THREE.Box3): void {
    const fit = computeFitPosition(box);
    if (!fit) return;

    this.exitFlying();
    this.refreshSceneBounds(box);
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

    // Fit View while flying means "show me the whole thing": leave flying and
    // animate out, rather than tween a camera the fly controls also drive.
    this.exitFlying();
    this.refreshSceneBounds(box);

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

  /** True while a pivot placed with the pivot tool is in force. */
  hasPivot(): boolean {
    return this.pivot.has();
  }

  /**
   * Subscribe to pivot place / clear transitions. Same surface as
   * `ClippingTool.onStateChange`, and for the same consumer: the
   * contextual-action tray needs to know when to offer "Remove pivot".
   */
  onPivotChange(cb: () => void): () => void {
    return this.pivot.onChange(cb);
  }

  /** Forget the placed pivot; orbits fall back to the fit centre again. */
  resetPivot(): void {
    if (this._controlsMode !== 'flying') this._controlsMode = 'user';
    this.forgetPivot();
  }

  clearPivot(): void {
    if (this._controlsMode !== 'flying') this._controlsMode = 'user';
    if (this.pickingPivot) this.cancelPivotPicking();
    this.forgetPivot();
  }

  private forgetPivot(): void {
    this.pivot.clear();
    this.removePivotMarker();
    this.needsRender = true;
  }

  dispose(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    this.exitFlying();
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
    this.pivot.dispose();
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
    const grid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE);
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
    const placed = this.pivot.get();
    return resolvePivot({
      hit: hit ? hit.point : null,
      selection,
      selectionOnScreen: selection !== null && this.isOnScreen(selection),
      placed,
      placedOnScreen: placed !== null && this.isOnScreen(placed),
      fallback: this.defaultTarget,
    });
  }

  private raycastAt(clientX: number, clientY: number): THREE.Intersection | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    const hit = raycastVisible(this.mouse, this.camera, this.scene, this.renderer);
    this.lastHitDistance = hit ? hit.distance : null;
    return hit;
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
    // Clicking the view gives the keyboard back to the view. Browsers do this
    // on mousedown by themselves, but not when a pointerdown handler has
    // called preventDefault (middle-drag pan, Alt-drag marquee).
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body && focused !== this.canvas) focused.blur();

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
      // Alt-drag belongs to the marquee selector, flying or not.
      if (e.altKey) return;
      // Ctrl / shift / meta stay with OrbitControls' pan, and are the
      // selection modifiers besides. While flying pan is off and Shift is the
      // boost, so a drag with Shift held still looks around.
      if (!this.isFlying() && (e.ctrlKey || e.metaKey || e.shiftKey)) return;
    }

    if (!this.canNavigate()) return;

    if (this.isFlying()) {
      // Looking turns in place; there is no pivot to find, so no raycast.
      this.rotateGesture = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        pivot: this.defaultTarget,
        transient: false,
        active: false,
        look: true,
      };
      return;
    }

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
      look: false,
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
    if (gesture.look) {
      if (!this.isFlying()) {
        this.endRotateGesture();
        return;
      }
      this.fly.look(this.camera, dx, dy, height);
      this.syncFlyAnchor();
      return;
    }
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

    if (this.isFlying()) {
      this.wheelSpeedStep(e);
      return;
    }

    this.lastPointer = { x: e.clientX, y: e.clientY };
    const { point } = this.pivotFor(e.clientX, e.clientY);
    this.dollyTo(point, e.deltaY > 0 ? 1 / WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP);
  };

  /**
   * The wheel is the gas pedal while flying: wheel up (away from you) is one
   * step faster, down one step slower. A mouse notch is one step; a trackpad's
   * stream of small deltas is summed until it makes one.
   */
  private wheelSpeedStep(e: WheelEvent): void {
    const pixels = e.deltaMode === 0 ? e.deltaY : e.deltaY * WHEEL_STEP_PX;
    if (Math.abs(pixels) >= WHEEL_NOTCH_PX) {
      this.wheelAccumulator = 0;
      this.fly.stepSpeed(pixels < 0 ? 1 : -1);
      return;
    }
    // A change of direction starts the sum afresh.
    if (Math.sign(pixels) !== Math.sign(this.wheelAccumulator)) this.wheelAccumulator = 0;
    this.wheelAccumulator += pixels;
    if (Math.abs(this.wheelAccumulator) >= WHEEL_STEP_PX) {
      this.fly.stepSpeed(this.wheelAccumulator < 0 ? 1 : -1);
      this.wheelAccumulator = 0;
    }
  }

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
    // Refresh the planes first: the guard below reads `camera.near`, and a
    // burst of wheel events within one frame would otherwise all measure
    // against the near plane from before the burst started.
    this.updateClipping();
    this.applyPose(
      dollyTowardPoint({
        position: this.camera.position,
        target: this.controls.target,
        focus,
        scale,
        minDistance: this.camera.near * MIN_FOCUS_NEAR_PLANES,
        // From the scene centre, not the focus: how far out you can get should
        // not depend on what the cursor happens to be over.
        limit: this.zoomOutLimit(),
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
    // Pan is off while flying, so this cannot normally fire then; if it ever
    // did, flying keeps the camera rather than half-handing it back.
    if (this._controlsMode === 'flying') return;
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

  /** The sphere a zoom-out may not leave: `maxViewDistance` about the scene centre. */
  private zoomOutLimit(): THREE.Sphere {
    // `dollyTo` refreshes the planes, and with them `viewBox`, first.
    const sphere = this.viewBox.getBoundingSphere(new THREE.Sphere());
    sphere.radius = maxViewDistance(sphere.radius);
    return sphere;
  }

  /**
   * Re-derive the clipping planes from where the camera actually is.
   *
   * The near plane used to be fixed at fit time, which is what made close-up
   * work impossible — see `clippingPlanesForView`. Skips the projection-matrix
   * rebuild when nothing moved enough to matter.
   */
  private updateClipping(): void {
    this.viewBox.copy(this.sceneBox);
    for (const source of this.viewBoundsSources) source(this.viewBox);
    const { near, far } = clippingPlanesForView({
      position: this.camera.position,
      hitDistance: this.lastHitDistance,
      scene: this.viewBox,
      clearOf: [this.gridBox],
    });
    if (near === this.camera.near && far === this.camera.far) return;
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
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
    this.pivot.place(hit.point);

    this.showPivotMarker(hit.point);
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
