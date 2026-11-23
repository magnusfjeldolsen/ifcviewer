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

/**
 * How the mouse looks around while flying: `mouse` when the pointer is
 * captured (or being captured) and moving it turns the view; `drag` when
 * the lock was refused and looking is a left-drag, as before.
 */
export type FlyLook = 'mouse' | 'drag';

/** Mouse events re-sent at the crosshair while the pointer is captured. */
const LOCKED_REMAP_TYPES = [
  'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
  'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
] as const;

/**
 * Largest look movement one mouse event may carry, px. A fast real flick
 * gives well under this per event; anything larger is a glitch (Firefox and
 * the plain lock report occasional jumps of thousands of pixels).
 */
const MAX_LOOK_DELTA_PX = 250;

function clampLook(delta: number): number {
  return Math.max(-MAX_LOOK_DELTA_PX, Math.min(MAX_LOOK_DELTA_PX, delta));
}

/**
 * How far a release is moved off the centre after a captured press that
 * turned the view, so every click-vs-drag check downstream sees a drag, px.
 */
const LOCKED_DRAG_OFFSET_PX = 50;

/** How long the browser's own contextmenu is swallowed after ours, ms. */
const MENU_SWALLOW_MS = 600;

/** What is under the centre is looked at no more often than this while flying, ms. */
const PROBE_INTERVAL_MS = 100;
/** ...and not on a frame that has already taken this long, ms. */
const PROBE_FRAME_BUDGET_MS = 12;
/** Faster than this the view counts as moving fast (name tags wait), m/s. */
const FAST_MOVE_MPS = 10;
/** Turning faster than this counts as moving fast, rad/s. */
const FAST_TURN_RADPS = 1;

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
  /** The canvas holds pointer lock for flying. */
  private flyLocked = false;
  /** A lock has been asked for and not yet granted or refused. */
  private flyLockPending = false;
  private flyLookListeners: Array<(look: FlyLook) => void> = [];
  private lastFlyLook: FlyLook | null = null;
  /** The re-sent event being dispatched, so the remap does not catch its own. */
  private remapClone: Event | null = null;
  /** The camera moved while flying since the centre was last looked at. */
  private flyViewDirty = false;
  private lastProbe = 0;
  private readonly probePosition = new THREE.Vector3();
  private readonly probeQuaternion = new THREE.Quaternion();
  private flyProbeListeners: Array<(fast: boolean) => void> = [];
  /** OrbitControls' `enabled` before the lock switched it off. */
  private controlsEnabledBeforeLock = true;
  /** The lock request returned a promise, so 'pointerlockerror' is not needed. */
  private lockByPromise = false;
  /** Drop the next look movement: the first after a grant can be a spurious jump. */
  private dropNextLookMove = false;
  /** A button held while captured, and how far the look has turned since. */
  private lockPress: { button: number; travel: number } | null = null;
  /** The last captured press turned the view before release: a drag, not a click. */
  private lockPressDragged = false;
  private swallowMenuTimer: ReturnType<typeof setTimeout> | null = null;
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
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockError);
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
    // G and the fly button are user gestures, which pointer lock needs.
    this.requestFlyLock();
  }

  // ── Pointer lock while flying ──────────────────────────────
  //
  // Flying captures the mouse so moving it looks around with no button held.
  // The browser releases the lock on Esc (without delivering that key to the
  // page), on Alt+Tab and when the window loses focus; losing it leaves
  // flying, which is how Esc leaves in one press. When the lock is refused —
  // Chrome refuses a re-lock for about a second after Esc, and some embedded
  // pages never allow it — flying carries on with drag-to-look, and the next
  // click in the view asks again. The mouse never ends up doing nothing.

  /** How the mouse looks around right now: captured, or by dragging. */
  getFlyLook(): FlyLook {
    return this.flyLocked || this.flyLockPending ? 'mouse' : 'drag';
  }

  /** Hear when looking switches between captured mouse and drag. */
  onFlyLookChange(cb: (look: FlyLook) => void): () => void {
    this.flyLookListeners.push(cb);
    return () => {
      this.flyLookListeners = this.flyLookListeners.filter((l) => l !== cb);
    };
  }

  private notifyFlyLook(): void {
    const look = this.getFlyLook();
    if (look === this.lastFlyLook) return;
    this.lastFlyLook = look;
    for (const cb of this.flyLookListeners) cb(look);
  }

  private requestFlyLock(): void {
    if (!this.isFlying() || this.flyLocked) return;
    const canvas = this.canvas;
    if (typeof canvas.requestPointerLock !== 'function') {
      this.flyLockPending = false;
      this.notifyFlyLook();
      return;
    }
    this.flyLockPending = true;
    this.notifyFlyLook();
    const attempt = (options?: PointerLockOptions): Promise<void> | undefined => {
      try {
        // Older browsers return undefined and report through 'pointerlockerror'.
        return canvas.requestPointerLock(options) as Promise<void> | undefined;
      } catch (err) {
        return Promise.reject(err);
      }
    };
    const refused = (): void => {
      if (!this.isFlying() || this.flyLocked) return;
      this.flyLockPending = false;
      this.notifyFlyLook();
    };
    // A grant that arrives after flying was left (G twice quickly, Fit or a
    // load while the request was pending) is let go at once.
    const granted = (): void => this.releaseStrayLock();
    // Raw mouse counts where the platform has them, so the OS pointer
    // acceleration does not make turning uneven; otherwise a plain lock.
    this.lockByPromise = false;
    const first = attempt({ unadjustedMovement: true });
    if (first && typeof first.then === 'function') {
      // The promises say how it went; 'pointerlockerror' for the refused
      // first try must not flash drag mode while the plain retry runs.
      this.lockByPromise = true;
      first.then(granted, () => {
        if (!this.isFlying() || this.flyLocked) return;
        const second = attempt();
        if (second && typeof second.then === 'function') second.then(granted, refused);
        else refused();
      });
    }
  }

  /** The canvas holds the lock but flying is over: release it. */
  private releaseStrayLock(): void {
    if (!this.isFlying() && document.pointerLockElement === this.canvas) document.exitPointerLock?.();
  }

  /**
   * Listens for the whole life of the viewer, not only while flying: a lock
   * asked for while flying can be granted after flying has ended, and must
   * then be released rather than leave a hidden, captured cursor in orbit.
   */
  private onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.canvas;
    if (locked) {
      if (!this.isFlying()) {
        this.releaseStrayLock();
        return;
      }
      if (this.flyLocked) return;
      this.flyLocked = true;
      // The first movement after a grant can be a spurious jump (seen with
      // the plain lock and in Firefox): it is dropped.
      this.dropNextLookMove = true;
      this.lockPress = null;
      this.lockPressDragged = false;
      this.flyLockPending = false;
      // A drag-to-look in progress ends: from here the mouse looks by itself.
      this.endRotateGesture();
      // OrbitControls asks for pointer capture on every pointerdown, which a
      // locked pointer refuses with an exception. It has nothing to do while
      // the mouse is captured, so it sits out until the lock goes.
      this.controlsEnabledBeforeLock = this.controls.enabled;
      this.controls.enabled = false;
      this.installLockedRemap();
      // Look at what is under the centre straight away.
      this.lastProbe = -Infinity;
      this.flyViewDirty = true;
      this.notifyFlyLook();
    } else if (this.flyLocked) {
      // Esc, Alt+Tab or the window losing focus: leave flying.
      this.releaseLockState();
      this.exitFlying();
    }
  };

  /** Undo what holding the lock changed. Safe to call when not locked. */
  private releaseLockState(): void {
    this.removeLockedRemap();
    if (this.flyLocked) this.controls.enabled = this.controlsEnabledBeforeLock;
    this.flyLocked = false;
  }

  private onPointerLockError = (): void => {
    if (this.lockByPromise || !this.isFlying() || this.flyLocked) return;
    this.flyLockPending = false;
    this.notifyFlyLook();
  };

  private installLockedRemap(): void {
    for (const type of LOCKED_REMAP_TYPES) window.addEventListener(type, this.remapLockedEvent, { capture: true });
  }

  private removeLockedRemap(): void {
    for (const type of LOCKED_REMAP_TYPES) window.removeEventListener(type, this.remapLockedEvent, { capture: true });
  }

  /** Centre of the view, in client coordinates: where the crosshair is. */
  private viewCentre(): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /**
   * While the mouse is captured the cursor is frozen wherever it was, so
   * every mouse event on the view is re-sent as if it happened at the
   * crosshair in the centre. Selection, hover, snapping, measuring, section
   * cuts and the parameter picker all read `clientX/Y`, so they all work from
   * the crosshair without knowing about flying. Modifiers and movement are
   * kept, so Ctrl/Shift-click keep their meaning and the look still turns.
   */
  private remapLockedEvent = (e: Event): void => {
    if (e === this.remapClone || e.target !== this.canvas || !this.flyLocked) return;
    // The browser has already let go (Esc) and 'pointerlockchange' is on its
    // way: this event is an ordinary one, and its movement is the cursor
    // reappearing, which must not turn the view on the way out.
    if (document.pointerLockElement !== this.canvas) {
      if (e.type === 'pointermove' || e.type === 'mousemove') e.stopImmediatePropagation();
      return;
    }
    e.stopImmediatePropagation();
    const m = e as MouseEvent;

    // A press held while the view turned is a drag, as with a cursor: no
    // click at the centre, and no menu, after it.
    if (e.type === 'pointerdown') {
      this.lockPress = { button: m.button, travel: 0 };
      this.lockPressDragged = false;
    } else if (e.type === 'pointermove' && this.lockPress) {
      this.lockPress.travel += Math.hypot(clampLook(m.movementX || 0), clampLook(m.movementY || 0));
    }
    const dragged = this.lockPress !== null && this.lockPress.travel >= DRAG_THRESHOLD;
    if (e.type === 'pointerup') {
      this.lockPressDragged = dragged;
      this.lockPress = null;
    }
    if (this.lockPressDragged && (e.type === 'click' || e.type === 'auxclick' || e.type === 'contextmenu')) {
      // The browser's own click or menu after a drag: not a click at all.
      e.preventDefault();
      return;
    }
    // Consumers judge click against drag by how far the pointer went between
    // press and release; the cursor is frozen, so tell them through the
    // release position how far the look travelled.
    const release = e.type === 'pointerup' || e.type === 'mouseup';
    const offset = release && this.lockPressDragged ? LOCKED_DRAG_OFFSET_PX : 0;

    const { x, y } = this.viewCentre();
    const init: PointerEventInit = {
      bubbles: m.bubbles,
      cancelable: m.cancelable,
      composed: m.composed,
      clientX: x + offset,
      clientY: y,
      screenX: m.screenX,
      screenY: m.screenY,
      button: m.button,
      buttons: m.buttons,
      ctrlKey: m.ctrlKey,
      shiftKey: m.shiftKey,
      altKey: m.altKey,
      metaKey: m.metaKey,
      movementX: m.movementX,
      movementY: m.movementY,
      detail: m.detail,
    };
    let clone: MouseEvent;
    if (typeof PointerEvent !== 'undefined' && e instanceof PointerEvent) {
      init.pointerId = e.pointerId;
      init.pointerType = e.pointerType;
      init.isPrimary = e.isPrimary;
      init.width = e.width;
      init.height = e.height;
      init.pressure = e.pressure;
      clone = new PointerEvent(e.type, init);
    } else {
      clone = new MouseEvent(e.type, init);
    }
    // Some engines drop movement from the init dictionary; carry it over.
    if (clone.movementX !== m.movementX) Object.defineProperty(clone, 'movementX', { value: m.movementX });
    if (clone.movementY !== m.movementY) Object.defineProperty(clone, 'movementY', { value: m.movementY });
    this.remapClone = clone;
    try {
      this.canvas.dispatchEvent(clone);
    } finally {
      this.remapClone = null;
    }
    if (clone.defaultPrevented) e.preventDefault();
    // Chrome sends no 'contextmenu' while the pointer is locked, so a right
    // button released is the menu: send one at the crosshair ourselves.
    if (e.type === 'pointerup' && m.button === 2 && !this.lockPressDragged) {
      const menu = new MouseEvent('contextmenu', { ...init, clientX: x, button: 2, buttons: 0 });
      this.remapClone = menu;
      try {
        this.canvas.dispatchEvent(menu);
      } finally {
        this.remapClone = null;
      }
      this.exitFlying();
      // Some browsers (Firefox on Windows) send their own contextmenu after
      // the release, even while locked; by then flying is over and it would
      // open the menu a second time at the frozen cursor. Swallow it.
      this.swallowNextMenu();
      return;
    }
    if (e.type === 'contextmenu') {
      // A menu needs a cursor: it opens for what is under the crosshair, and
      // flying ends so the mouse comes back.
      e.preventDefault();
      this.exitFlying();
    }
  };

  /** Eat the browser's own contextmenu for a moment after we opened the menu ourselves. */
  private swallowNextMenu(): void {
    this.stopSwallowingMenu();
    window.addEventListener('contextmenu', this.swallowMenu, { capture: true });
    this.swallowMenuTimer = setTimeout(() => this.stopSwallowingMenu(), MENU_SWALLOW_MS);
  }

  private swallowMenu = (e: Event): void => {
    if (e === this.remapClone) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.stopSwallowingMenu();
  };

  private stopSwallowingMenu(): void {
    window.removeEventListener('contextmenu', this.swallowMenu, { capture: true });
    if (this.swallowMenuTimer !== null) clearTimeout(this.swallowMenuTimer);
    this.swallowMenuTimer = null;
  }

  /**
   * Hear when it is time to look at what is under the centre of the view
   * while flying with the mouse captured. `fast` is true while the view is
   * turning or moving quickly. Called only after the camera has moved, at
   * most every `PROBE_INTERVAL_MS`, and never on a frame already over
   * `PROBE_FRAME_BUDGET_MS`; never outside flying.
   */
  onFlyProbe(cb: (fast: boolean) => void): () => void {
    this.flyProbeListeners.push(cb);
    return () => {
      this.flyProbeListeners = this.flyProbeListeners.filter((l) => l !== cb);
    };
  }

  /** Centre of the view in client coordinates, where clicks land while captured. */
  getViewCentre(): { x: number; y: number } {
    return this.viewCentre();
  }

  private maybeProbeCentre(frameStart: number): void {
    if (!this.flyLocked) return;
    const now = performance.now();
    if (now - this.lastProbe < PROBE_INTERVAL_MS) return;
    // This frame has used its budget already; the next one will do.
    if (now - frameStart > PROBE_FRAME_BUDGET_MS) return;
    const elapsed = Math.min(Math.max((now - this.lastProbe) / 1000, 1e-3), 1);
    const speed = this.camera.position.distanceTo(this.probePosition) / elapsed;
    const turn = this.camera.quaternion.angleTo(this.probeQuaternion) / elapsed;
    const fast = Number.isFinite(this.lastProbe) && (speed > FAST_MOVE_MPS || turn > FAST_TURN_RADPS);
    this.lastProbe = now;
    // After a fast look, look once more when the next interval is up: if the
    // view has come to rest by then, that is what lets the name tag appear.
    this.flyViewDirty = fast;
    this.probePosition.copy(this.camera.position);
    this.probeQuaternion.copy(this.camera.quaternion);
    // Hover and snapping feedback follow the centre as the view moves, not
    // only when the mouse does: a still pointermove there (re-sent by the
    // remap like any other).
    if (typeof PointerEvent !== 'undefined') {
      const { x, y } = this.viewCentre();
      this.canvas.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true }),
      );
    }
    for (const cb of this.flyProbeListeners) cb(fast);
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
    // Lock state off first, so the 'pointerlockchange' from releasing the
    // lock below finds nothing left to do. The lock listeners themselves stay:
    // a request still pending is released when (if) it is granted.
    this.releaseLockState();
    this.lockPress = null;
    this.lockPressDragged = false;
    this.flyLockPending = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.();
    this.lastFlyLook = null;
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
    this.flyViewDirty = true;
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
    const flying = this._controlsMode === 'flying';
    // Read only while flying: the probe below must not start on a frame that
    // has already used its budget.
    const probing = flying && this.flyLocked && this.flyViewDirty;
    const frameStart = probing ? performance.now() : 0;
    if (this._controlsMode === 'user') {
      this.controls.update();
    } else if (flying) {
      this.tickFlying();
    }
    if (this.needsRender) this.drawFrame();
    if (probing) this.maybeProbeCentre(frameStart);
  };

  private drawFrame(): void {
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
  }

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
    this.releaseStrayLock();
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockError);
    this.stopSwallowingMenu();
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
      // With the mouse captured, moving it looks; a press is a click at the
      // crosshair for selection and the tools, never a gesture of ours.
      if (this.flyLocked) return;
      // Drag-to-look (the lock was refused). Looking turns in place; there
      // is no pivot to find, so no raycast.
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
    if (this.flyLocked && this.isFlying()) {
      // Captured mouse: its movement turns the view, no button needed. The
      // position is the crosshair's and never changes, so it is not recorded.
      const dx = clampLook(e.movementX || 0);
      const dy = clampLook(e.movementY || 0);
      if (dx === 0 && dy === 0) return;
      if (this.dropNextLookMove) {
        this.dropNextLookMove = false;
        return;
      }
      const height = this.canvas.clientHeight || this.canvas.height || 1;
      this.fly.look(this.camera, dx, dy, height);
      this.syncFlyAnchor();
      return;
    }
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
      // A locked pointer refuses capture with an exception (and needs none).
      if (document.pointerLockElement !== this.canvas) this.canvas.setPointerCapture?.(e.pointerId);
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
      const wasClick = !this.rotateGesture.active;
      const wasLook = this.rotateGesture.look;
      this.canvas.releasePointerCapture?.(e.pointerId);
      this.endRotateGesture();
      // Drag-to-look fallback: a click in the view (a user gesture) asks for
      // the mouse again — Chrome refuses a re-lock for a second after Esc.
      if (wasLook && wasClick && e.pointerType !== 'touch' && this.isFlying() && !this.flyLocked) {
        this.requestFlyLock();
      }
    }
  };

  private endRotateGesture(): void {
    this.rotateGesture = null;
    this.removeTransientMarker();
  }

  private onWheel = (e: WheelEvent): void => {
    // While the mouse is captured the wheel is the gas pedal, whatever else
    // has the controls switched off (the lock itself does).
    if (this.flyLocked && this.isFlying()) {
      if (e.deltaY !== 0) {
        e.preventDefault();
        this.wheelSpeedStep(e);
      }
      return;
    }
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
