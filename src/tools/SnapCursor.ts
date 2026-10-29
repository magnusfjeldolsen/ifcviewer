import * as THREE from 'three';
import {
  orderSnapCandidates,
  snapCandidatesAt,
  snapPayload,
  type SnapPayload,
  type SnapTarget,
} from './snapCandidates';
import type { MeasurementEnd } from './MeasurementStore';
import { cycleIndex } from '../inspector/candidateMath';
import type { Candidate, ScreenPoint } from '../inspector/candidateMath';

/**
 * How far the cursor may drift before a Tab cycle is treated as a new
 * gesture. Matches the resolver's own hold radius.
 */
const SNAP_HOLD_RADIUS_PX = 4;

export interface SnapCursorDeps {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /**
   * Whether snapping is on. Read on every resolve rather than cached, so the
   * `S` toggle takes effect on the next pointer move without the tool having
   * to subscribe to anything.
   */
  snappingEnabled?: () => boolean;
  /** Which targets are currently offered. Omitted means all of them. */
  allowedSnapTargets?: () => ReadonlySet<SnapTarget>;
  /** Flip one target on or off. The app persists it and reports what happened. */
  onToggleSnapTarget?: (target: SnapTarget) => void;
  /** Called when `S` flips snapping, so the app can persist and report it. */
  onToggleSnapping?: () => void;
}

/** What a key press did to the snap state, so the tool knows whether to redraw now. */
export type SnapKeyResult = 'cycled' | 'toggled' | null;

/**
 * What the cursor is snapped to, and the keys that change it.
 *
 * Extracted from `MeasurementTool` so every tool that places a point in the
 * model resolves it the same way: the same targets, the same distance-aware
 * ordering, the same Tab cycle and the same `S` / `1` `2` `3` toggles. A
 * second tool with its own copy would drift, and a corner that snaps when
 * measuring but not when marking a position is a tool nobody trusts.
 *
 * The tool owns this rather than registering with `CandidateResolver`. The
 * resolver's input layer is gated on no tool being active — that gate is what
 * stops element selection fighting point placement — so a provider registered
 * there would never be consulted while a tool is active. The pure ranking and
 * cycling helpers are reused directly instead, which is the part that mattered.
 */
export class SnapCursor {
  private deps: SnapCursorDeps;
  /** Snap targets under the cursor, best first. */
  private snaps: Candidate[] = [];
  /** Which one Tab has landed on. */
  private index = 0;
  /** Where the cursor was when `snaps` was last rebuilt, for the Tab hold radius. */
  private cursor: ScreenPoint | null = null;

  constructor(deps: SnapCursorDeps) {
    this.deps = deps;
  }

  /**
   * Rebuild the snap candidates under the cursor.
   *
   * The Tab position survives small movements so a cycle is not undone by
   * hand tremor, and resets once the cursor has clearly moved on — the same
   * bargain `CandidateResolver` strikes, for the same reason.
   */
  refresh(e: MouseEvent, hit: THREE.Intersection | null): void {
    const mesh = hit?.object;
    if (!hit || !(mesh instanceof THREE.Mesh) || hit.faceIndex == null) {
      this.clear();
      return;
    }

    const rect = this.deps.canvas.getBoundingClientRect();
    const cursor: ScreenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    const moved =
      !this.cursor || Math.hypot(cursor.x - this.cursor.x, cursor.y - this.cursor.y) > SNAP_HOLD_RADIUS_PX;

    const features = this.deps.snappingEnabled?.() ?? true;

    this.snaps = orderSnapCandidates(
      snapCandidatesAt({
        featuresEnabled: features,
        allowed: this.deps.allowedSnapTargets?.(),
        mesh,
        faceIndex: hit.faceIndex,
        hitPoint: hit.point,
        cursor,
        camera: this.deps.camera,
        canvas: { width: this.deps.canvas.clientWidth, height: this.deps.canvas.clientHeight },
      }),
    );

    if (moved) {
      this.index = 0;
      this.cursor = cursor;
    } else if (this.index >= this.snaps.length) {
      this.index = 0;
    }
  }

  /** The snap Tab has landed on, or the best one. */
  active(): SnapPayload | null {
    const candidate = this.snaps[this.index];
    return candidate ? snapPayload(candidate) : null;
  }

  /** Forget everything under the cursor, e.g. when it leaves the geometry. */
  clear(): void {
    this.snaps = [];
    this.index = 0;
    this.cursor = null;
  }

  /**
   * The snap keys. Tab steps to the next snap under the cursor: corner, then
   * edge, then surface, then the raw point. That last one is why snapping
   * needs no suppression modifier — "off" is simply the final alternative.
   *
   * A toggle only resets the cycle; the new set of targets shows on the next
   * pointer move, which is when there is a cursor position to resolve it at.
   */
  onKeyDown(e: KeyboardEvent): SnapKeyResult {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;

    const byNumber: Record<string, SnapTarget> = { '1': 'vertex', '2': 'edge', '3': 'face' };
    const target = byNumber[e.key];
    if (target) {
      this.deps.onToggleSnapTarget?.(target);
      this.index = 0;
      this.cursor = null;
      return 'toggled';
    }

    if (e.key === 's' || e.key === 'S') {
      this.deps.onToggleSnapping?.();
      this.index = 0;
      this.cursor = null;
      return 'toggled';
    }

    if (e.key !== 'Tab' || this.snaps.length < 2) return null;
    e.preventDefault();
    this.index = cycleIndex(this.index, this.snaps.length, e.shiftKey ? -1 : 1);
    return 'cycled';
  }
}

/**
 * The model a hit mesh belongs to. `ModelManager` names each model group with
 * the app's model UUID and parents the meshes directly under it, so the
 * parent's name is the id — the same lookup `SelectionManager.identityFromHit`
 * does. Null for anything not under a model group.
 */
export function modelIdOf(object: THREE.Object3D): string | null {
  const parent = object.parent;
  return parent && parent.name ? parent.name : null;
}

/** What an end caught, in the vocabulary the glyphs are drawn from. */
export function endFrom(snap: SnapPayload | null): MeasurementEnd {
  if (!snap) return { target: 'point' };
  return {
    target: snap.target,
    direction: snap.edgeDirection?.clone(),
  };
}
