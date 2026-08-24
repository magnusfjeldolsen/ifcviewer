import * as THREE from 'three';

/**
 * The orbit pivot the user placed by hand, plus the observers that care when
 * it comes and goes.
 *
 * Split out of `Viewer` because `Viewer` builds a real `WebGLRenderer` and so
 * cannot be constructed under test, while this contract is exactly the kind
 * that breaks quietly: the contextual-action tray offers "Remove pivot" based
 * on `has()`, and re-evaluates only when a subscriber fires. A missed
 * notification leaves a button that lies about the state. Same split as
 * `orbitMath.ts` and `cameraUtils.ts`, and the same surface as
 * `ClippingTool.hasClipPlane` / `onStateChange`, which the tray also consumes.
 */
export class PivotState {
  private point: THREE.Vector3 | null = null;
  private listeners: Array<() => void> = [];

  /** True while a placed pivot is in force. */
  has(): boolean {
    return this.point !== null;
  }

  /** The placed pivot, or null. Callers get the live reference, read-only. */
  get(): THREE.Vector3 | null {
    return this.point;
  }

  /**
   * Record a new pivot. Notifies even when one was already placed — the
   * marker moved, which observers may want to reflect.
   */
  place(point: THREE.Vector3): void {
    this.point = point.clone();
    this.notify();
  }

  /**
   * Forget the pivot. Returns true if there was one to forget.
   *
   * Only a real transition notifies: `clear()` runs on paths like resetView
   * where nothing was ever placed, and waking every observer for a no-op is
   * how trays start flickering.
   */
  clear(): boolean {
    if (this.point === null) return false;
    this.point = null;
    this.notify();
    return true;
  }

  /**
   * Subscribe to place / clear transitions. The listener fires after the
   * transition is applied. Returns an unsubscribe callback.
   */
  onChange(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  /** Drop every observer. For `Viewer.dispose`. */
  dispose(): void {
    this.listeners = [];
  }

  private notify(): void {
    // Copy first: a listener that unsubscribes itself must not shift the
    // array out from under this loop.
    for (const cb of [...this.listeners]) cb();
  }
}
