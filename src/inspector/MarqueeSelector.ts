import * as THREE from 'three';
import type { Viewer } from '../viewer/Viewer';
import type { ModelManager } from '../viewer/ModelManager';
import type { ToolManager } from '../tools/Tool';
import type { SelectionManager } from './SelectionManager';
import type { ElementIdentity, SelectionMode } from './types';

/**
 * Alt-drag marquee (window / crossing) selection.
 *
 * Holding `Alt` and dragging the left mouse button across the canvas
 * builds a screen-space rectangle. On release the rectangle is unprojected
 * into a 3D frustum prism and every mesh in every loaded model is
 * classified as `outside`, `crossing`, or `window`:
 *
 *  - Right→left drag = **crossing**: include every element whose world-space
 *    AABB intersects the prism. Green dashed visual.
 *  - Left→right drag = **window**: include every element whose AABB has
 *    all 8 corners inside the prism. Blue solid visual.
 *
 * Modifier composition (locked at pointerdown — releasing Alt mid-drag
 * still completes the marquee, matching AutoCAD):
 *
 *  - Alt           → `replace`
 *  - Alt + Ctrl/⌘  → `add`
 *  - Alt + Shift   → `remove` (shift wins over ctrl)
 *
 * The selector bails (silently no-ops) when any tool is active or pivot
 * picking is on; we don't want to compete with the section-cut placement
 * or measurement clicks.
 *
 * Clipping: any element whose AABB lies entirely on the cut-side of any
 * active clipping plane is excluded. Partially-clipped elements remain
 * selectable — same convention as single-click `raycastVisible`.
 *
 * Visibility: hidden model groups (`entry.visible === false`) and
 * `mesh.visible === false` skip classification entirely.
 *
 * Identity dedup: a single IFC element can have multiple meshes sharing
 * one `expressID` (different render geometries). We bucket per
 * `(modelId, expressId)` and emit one identity per bucket.
 *
 * Performance: ~10 ms for 50k meshes at this complexity level. The mesh
 * iteration walks `modelManager.getAllModels()` directly so we don't
 * traverse pivot/clip/measurement helpers parented to the scene root.
 *
 * See `dev/plans/phase-marquee-selection.md` for the full design.
 */

export interface MarqueeSelectorDeps {
  viewer: Viewer;
  modelManager: ModelManager;
  toolManager: ToolManager;
  selectionManager: SelectionManager;
  /** Test override — when omitted, the viewer's canvas is used. */
  canvas?: HTMLCanvasElement;
  /** Test override — when omitted, document.body is used as marquee parent. */
  marqueeRoot?: HTMLElement;
}

/** Movement threshold (CSS px) before a pointerdown is treated as a drag. */
const CLICK_THRESHOLD = 3;

/** Direction of the marquee in screen space → which mode is active. */
type Direction = 'window' | 'crossing';

interface ModifierSnapshot {
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

type DragState =
  | { kind: 'idle' }
  | {
      kind: 'pending';
      pointerId: number;
      startClient: { x: number; y: number };
      modifiers: ModifierSnapshot;
    }
  | {
      kind: 'dragging';
      pointerId: number;
      startClient: { x: number; y: number };
      currentClient: { x: number; y: number };
      modifiers: ModifierSnapshot;
      direction: Direction;
      marqueeEl: HTMLDivElement;
    };

export class MarqueeSelector {
  private deps: MarqueeSelectorDeps;
  private canvas: HTMLCanvasElement;
  private marqueeRoot: HTMLElement;
  private state: DragState = { kind: 'idle' };

  // Bound handlers — stable refs for add/removeEventListener.
  private boundOnPointerDown: (e: PointerEvent) => void;
  private boundOnPointerMove: (e: PointerEvent) => void;
  private boundOnPointerUp: (e: PointerEvent) => void;
  private boundOnKeyDown: (e: KeyboardEvent) => void;

  /** Whether the Esc listener is currently installed (dragging only). */
  private escListenerInstalled = false;

  constructor(deps: MarqueeSelectorDeps) {
    this.deps = deps;
    this.canvas = deps.canvas ?? deps.viewer.getCanvas();
    this.marqueeRoot = deps.marqueeRoot ?? document.body;

    this.boundOnPointerDown = this.onPointerDown.bind(this);
    this.boundOnPointerMove = this.onPointerMove.bind(this);
    this.boundOnPointerUp = this.onPointerUp.bind(this);
    this.boundOnKeyDown = this.onKeyDown.bind(this);

    // Capture phase: we MUST receive the event before OrbitControls'
    // bubble-phase listener so we can stopPropagation when Alt is held.
    this.canvas.addEventListener('pointerdown', this.boundOnPointerDown, { capture: true });
    this.canvas.addEventListener('pointermove', this.boundOnPointerMove);
    this.canvas.addEventListener('pointerup', this.boundOnPointerUp);
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.boundOnPointerDown, { capture: true });
    this.canvas.removeEventListener('pointermove', this.boundOnPointerMove);
    this.canvas.removeEventListener('pointerup', this.boundOnPointerUp);
    this.removeEscListener();
    this.removeMarqueeEl();
    // Restore controls in case we disposed mid-drag.
    this.deps.viewer.setControlsEnabled(true);
    this.canvas.style.cursor = '';
    this.state = { kind: 'idle' };
  }

  // ── Event handlers ────────────────────────────────────────

  private onPointerDown(e: PointerEvent): void {
    // Only react to left-button Alt-drag. Everything else passes through
    // untouched (OrbitControls, SelectionManager click, etc.).
    if (e.button !== 0) return;
    if (!e.altKey) return;

    // Bail when any tool or pivot picking owns the canvas.
    if (this.deps.toolManager.getActiveTool() !== null) return;
    if (this.deps.viewer.isPivotPicking()) return;

    // Already dragging (pointer-capture lost?): cancel and start fresh.
    if (this.state.kind !== 'idle') {
      this.cancelDrag();
    }

    // Claim the event so OrbitControls (bubble phase) doesn't see it.
    e.preventDefault();
    e.stopPropagation();

    this.deps.viewer.setControlsEnabled(false);

    this.state = {
      kind: 'pending',
      pointerId: e.pointerId,
      startClient: { x: e.clientX, y: e.clientY },
      modifiers: {
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        meta: e.metaKey,
      },
    };
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.state.kind === 'idle') return;
    if (e.pointerId !== this.state.pointerId) return;

    const dx = e.clientX - this.state.startClient.x;
    const dy = e.clientY - this.state.startClient.y;
    const dist = Math.hypot(dx, dy);

    if (this.state.kind === 'pending') {
      if (dist < CLICK_THRESHOLD) return; // Below threshold — wait.

      // Transition to dragging: create marquee div, install Esc listener.
      const direction: Direction = e.clientX >= this.state.startClient.x ? 'window' : 'crossing';
      const marqueeEl = this.createMarqueeEl(direction);
      this.marqueeRoot.appendChild(marqueeEl);
      this.canvas.style.cursor = 'crosshair';
      this.installEscListener();

      this.state = {
        kind: 'dragging',
        pointerId: this.state.pointerId,
        startClient: this.state.startClient,
        currentClient: { x: e.clientX, y: e.clientY },
        modifiers: this.state.modifiers,
        direction,
        marqueeEl,
      };
      this.updateMarqueeEl();
      return;
    }

    // kind === 'dragging' — update geometry and live-flip direction.
    this.state.currentClient = { x: e.clientX, y: e.clientY };
    const newDirection: Direction =
      e.clientX >= this.state.startClient.x ? 'window' : 'crossing';
    if (newDirection !== this.state.direction) {
      this.state.direction = newDirection;
      this.state.marqueeEl.className =
        newDirection === 'window' ? 'marquee-window' : 'marquee-crossing';
    }
    this.updateMarqueeEl();
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.state.kind === 'idle') return;
    if (e.button !== 0) return;
    if (e.pointerId !== this.state.pointerId) return;

    if (this.state.kind === 'pending') {
      // Below click threshold — never created the marquee. Let the
      // normal click path (SelectionManager) handle it.
      this.cleanupGesture();
      return;
    }

    // Dragging: commit the selection.
    const dragging = this.state;
    this.commitSelection(dragging);
    this.cleanupGesture();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    if (this.state.kind === 'idle') return;

    // Cancel the drag with no selection change.
    // stopPropagation so the global Esc shortcut (App.setupKeyboardShortcuts)
    // doesn't also fire and e.g. clear the existing selection.
    e.stopPropagation();
    this.cancelDrag();
  }

  // ── Commit / cancel ───────────────────────────────────────

  private commitSelection(state: Extract<DragState, { kind: 'dragging' }>): void {
    const camera = this.deps.viewer.getCamera();
    const scene = this.deps.viewer.getScene();
    const startNDC = this.clientToNDC(state.startClient.x, state.startClient.y);
    const endNDC = this.clientToNDC(state.currentClient.x, state.currentClient.y);

    // Build the frustum prism in world space.
    const sceneBox = new THREE.Box3().setFromObject(scene);
    const deep = computeDeep(camera, sceneBox);
    const frustum = buildSelectionFrustum(startNDC, endNDC, camera, deep);

    // Active clipping planes (renderer-level).
    const clipPlanes = this.deps.viewer.getRenderer().clippingPlanes ?? [];

    // Walk visible meshes under loaded models, classify, bucket per element.
    // Single pass: every visible mesh of an element bumps `all`; only
    // touching meshes bump `touches`; only fully-inside meshes bump `window`.
    const buckets = new Map<string, ElementBucket>();
    const tmpBox = new THREE.Box3();
    for (const entry of this.deps.modelManager.getAllModels()) {
      if (!entry.visible) continue;
      for (const child of entry.group.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        if (typeof child.userData.expressID !== 'number') continue;
        if (!child.visible) continue;

        const expressId = child.userData.expressID as number;
        const key = `${entry.id}:${expressId}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            all: 0,
            window: 0,
            touches: 0,
            sample: {
              modelId: entry.id,
              expressId,
              ifcClass: '',
              ifcTypeCode: 0,
            },
          };
          buckets.set(key, bucket);
        }
        bucket.all += 1;

        const classification = classifyMesh(child, frustum, clipPlanes, tmpBox);
        if (classification === 'outside') continue;
        bucket.touches += 1;
        if (classification === 'window') bucket.window += 1;
      }
    }

    const identities = bucketResults(buckets, state.direction);
    const mode = modeFromModifiers(state.modifiers);

    this.deps.selectionManager.applyMany(mode, identities);
  }

  private cancelDrag(): void {
    this.cleanupGesture();
  }

  private cleanupGesture(): void {
    this.removeMarqueeEl();
    this.removeEscListener();
    this.deps.viewer.setControlsEnabled(true);
    this.canvas.style.cursor = '';
    this.state = { kind: 'idle' };
  }

  // ── DOM marquee element ───────────────────────────────────

  private createMarqueeEl(direction: Direction): HTMLDivElement {
    const el = document.createElement('div');
    el.className = direction === 'window' ? 'marquee-window' : 'marquee-crossing';
    return el;
  }

  private updateMarqueeEl(): void {
    if (this.state.kind !== 'dragging') return;
    const { startClient, currentClient, marqueeEl } = this.state;
    const left = Math.min(startClient.x, currentClient.x);
    const top = Math.min(startClient.y, currentClient.y);
    const width = Math.abs(currentClient.x - startClient.x);
    const height = Math.abs(currentClient.y - startClient.y);
    marqueeEl.style.left = `${left}px`;
    marqueeEl.style.top = `${top}px`;
    marqueeEl.style.width = `${width}px`;
    marqueeEl.style.height = `${height}px`;
  }

  private removeMarqueeEl(): void {
    if (this.state.kind === 'dragging' && this.state.marqueeEl.parentNode) {
      this.state.marqueeEl.parentNode.removeChild(this.state.marqueeEl);
    }
  }

  // ── Esc listener (dragging only) ──────────────────────────

  private installEscListener(): void {
    if (this.escListenerInstalled) return;
    window.addEventListener('keydown', this.boundOnKeyDown, { capture: true });
    this.escListenerInstalled = true;
  }

  private removeEscListener(): void {
    if (!this.escListenerInstalled) return;
    window.removeEventListener('keydown', this.boundOnKeyDown, { capture: true });
    this.escListenerInstalled = false;
  }

  // ── Helpers ───────────────────────────────────────────────

  private clientToNDC(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }
}

// ═══════════════════════════════════════════════════════════
// Pure functions — exported for unit-test isolation
// ═══════════════════════════════════════════════════════════

interface ElementBucket {
  /** Total meshes for this element across the model (visible only). */
  all: number;
  /** Meshes whose AABB is fully inside the frustum. */
  window: number;
  /** Meshes whose AABB touches (intersects or is fully inside) the frustum. */
  touches: number;
  /** A representative identity for emission. */
  sample: ElementIdentity;
}

/**
 * Build the 3D frustum prism for a screen-space rectangle. Technique
 * copied from `three/examples/jsm/interactive/SelectionBox.js:158-200`
 * (perspective-camera branch only — we don't ship orthographic).
 *
 * Inputs are NDC coordinates (x and y in [-1, 1]). Order of `start`/`end`
 * does not matter; this function normalises corners internally so a
 * right-to-left and left-to-right pair yield the same frustum.
 *
 * `deep` is the prism extent into the scene along each side ray. Use
 * `computeDeep(camera, sceneBox)` rather than `Number.MAX_VALUE` (the
 * stock SelectionBox uses MAX_VALUE which suffers numerical precision
 * loss for normalize+multiply at far distances).
 */
export function buildSelectionFrustum(
  startNDC: THREE.Vector2,
  endNDC: THREE.Vector2,
  camera: THREE.PerspectiveCamera,
  deep: number,
): THREE.Frustum {
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  // Normalise corners — order-independent.
  const left = Math.min(startNDC.x, endNDC.x);
  const right = Math.max(startNDC.x, endNDC.x);
  const top = Math.max(startNDC.y, endNDC.y);
  const bottom = Math.min(startNDC.y, endNDC.y);

  // Avoid degenerate planes when the rectangle collapses to a line.
  const effLeft = left === right ? left - Number.EPSILON : left;
  const effRight = left === right ? right + Number.EPSILON : right;
  const effTop = top === bottom ? top + Number.EPSILON : top;
  const effBottom = top === bottom ? bottom - Number.EPSILON : bottom;

  const near = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);

  const tl = new THREE.Vector3(effLeft, effTop, 0).unproject(camera);
  const tr = new THREE.Vector3(effRight, effTop, 0).unproject(camera);
  const br = new THREE.Vector3(effRight, effBottom, 0).unproject(camera);
  const bl = new THREE.Vector3(effLeft, effBottom, 0).unproject(camera);

  // Far-face corners along each side ray.
  const farTL = tl.clone().sub(near).normalize().multiplyScalar(deep).add(near);
  const farTR = tr.clone().sub(near).normalize().multiplyScalar(deep).add(near);
  const farBR = br.clone().sub(near).normalize().multiplyScalar(deep).add(near);

  const frustum = new THREE.Frustum();
  const p = frustum.planes;
  // Side planes (inward-facing). Winding chosen to match SelectionBox.js.
  p[0].setFromCoplanarPoints(near, tl, tr); // top
  p[1].setFromCoplanarPoints(near, tr, br); // right
  p[2].setFromCoplanarPoints(br, bl, near); // bottom
  p[3].setFromCoplanarPoints(bl, tl, near); // left
  // Near face (uses the near corners).
  p[4].setFromCoplanarPoints(tr, br, bl);
  // Far face. With the winding (farBR, farTR, farTL) the normal computed
  // by `setFromCoplanarPoints` already points inward (toward the camera),
  // so we do NOT flip — flipping just the normal (as stock SelectionBox.js
  // does) would leave the constant on the wrong side and put the plane
  // behind the camera.
  p[5].setFromCoplanarPoints(farBR, farTR, farTL);

  return frustum;
}

/**
 * Sensible value for the prism extent in `buildSelectionFrustum`.
 *
 * Stock SelectionBox uses `Number.MAX_VALUE` here; that's mathematically
 * fine but numerically lossy when we then `setFromCoplanarPoints` two
 * far-face corners. We pick the larger of the camera's far plane and
 * twice the scene's longest diagonal, which is always enough to fully
 * enclose visible geometry without sacrificing plane-coefficient precision.
 */
export function computeDeep(camera: THREE.PerspectiveCamera, sceneBox: THREE.Box3): number {
  if (sceneBox.isEmpty()) return Math.max(camera.far, 1000);
  const size = sceneBox.getSize(new THREE.Vector3()).length();
  return Math.max(camera.far, size * 2);
}

/**
 * Classify a single mesh against a frustum and a set of active clip planes.
 *
 * Returns:
 *  - `'outside'` when the AABB lies entirely on the cut-side of any active
 *    clip plane, or when the AABB doesn't touch the frustum at all.
 *  - `'window'` when all 8 corners of the world-space AABB are inside the
 *    frustum (conservative for rotated meshes; their AABB overstates the
 *    real footprint, so window mode may slightly under-select rotated
 *    elements — accepted for v1).
 *  - `'crossing'` when the AABB intersects the frustum but at least one
 *    corner is outside.
 *
 * `tmpBox` is reused across calls to avoid allocating a Box3 per mesh.
 */
export function classifyMesh(
  mesh: THREE.Mesh,
  frustum: THREE.Frustum,
  clipPlanes: readonly THREE.Plane[],
  tmpBox: THREE.Box3,
): 'outside' | 'crossing' | 'window' {
  if (mesh.geometry.boundingBox === null) {
    mesh.geometry.computeBoundingBox();
  }
  const local = mesh.geometry.boundingBox;
  if (!local) return 'outside'; // Empty geometry.

  tmpBox.copy(local).applyMatrix4(mesh.matrixWorld);

  // Clipping respect: a plane fully clips this AABB when every corner has
  // distanceToPoint < 0 (i.e. on the cut-side, matching `raycastVisible`'s
  // convention of plane.distanceToPoint(point) >= 0 for visible points).
  for (const plane of clipPlanes) {
    if (boxFullyClippedByPlane(tmpBox, plane)) return 'outside';
  }

  // Frustum tests.
  if (!frustum.intersectsBox(tmpBox)) return 'outside';

  // Window: all 8 corners inside every frustum plane.
  if (boxFullyInsideFrustum(tmpBox, frustum)) return 'window';
  return 'crossing';
}

/**
 * Bucket dedup → ElementIdentity[] depending on direction:
 *
 *  - `'crossing'`: include every element with at least one touching mesh.
 *  - `'window'`: include only elements where ALL meshes are fully inside.
 *
 * Buckets are keyed by `"<modelId>:<expressId>"`.
 */
export function bucketResults(
  buckets: ReadonlyMap<string, ElementBucket>,
  direction: Direction,
): ElementIdentity[] {
  const out: ElementIdentity[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.all === 0) continue;
    if (direction === 'crossing') {
      if (bucket.touches > 0) out.push(bucket.sample);
    } else {
      // window — all meshes fully inside.
      if (bucket.window === bucket.all) out.push(bucket.sample);
    }
  }
  return out;
}

/** Map a modifier snapshot to a SelectionMode (shift > ctrl/meta > default). */
export function modeFromModifiers(mods: ModifierSnapshot): SelectionMode {
  if (mods.shift) return 'remove';
  if (mods.ctrl || mods.meta) return 'add';
  return 'replace';
}

// ── Geometry helpers ──────────────────────────────────────

const _corner = new THREE.Vector3();

function boxFullyClippedByPlane(box: THREE.Box3, plane: THREE.Plane): boolean {
  // For each of the 8 corners of `box`, if any corner is on the visible
  // side (distanceToPoint >= 0), the AABB is not fully clipped.
  for (let i = 0; i < 8; i++) {
    _corner.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    );
    if (plane.distanceToPoint(_corner) >= 0) return false;
  }
  return true;
}

function boxFullyInsideFrustum(box: THREE.Box3, frustum: THREE.Frustum): boolean {
  for (let i = 0; i < 8; i++) {
    _corner.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    );
    if (!frustum.containsPoint(_corner)) return false;
  }
  return true;
}

// Re-export `ElementBucket` shape for testability without exposing the field.
export type { ElementBucket };
