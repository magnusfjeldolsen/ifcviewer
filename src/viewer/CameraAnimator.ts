import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface FlyToParams {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  targetPosition: THREE.Vector3;
  targetLookAt: THREE.Vector3;
  near: number;
  far: number;
  durationMs?: number;
  onStart?: () => void;
  /**
   * Fires once per animation frame after camera + controls have been
   * updated. Used by the viewer in render-on-demand mode to flip
   * `needsRender = true` so each tick draws — controls.update() already
   * dispatches 'change' on each tick, but tying onTick to the animator
   * directly makes the contract explicit and survives any future
   * refactor that stops calling controls.update().
   */
  onTick?: () => void;
  onComplete?: () => void;
  onInterrupt?: () => void;
}

/** Ease-out cubic: decelerates to zero velocity */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export class CameraAnimator {
  private active = false;
  private rafId: number | null = null;
  private interruptHandler: (() => void) | null = null;

  /**
   * Smoothly animate the camera and orbit target to new positions.
   * Resolves when animation completes or is interrupted by user input.
   */
  flyTo(params: FlyToParams): Promise<void> {
    // Cancel any in-progress animation
    this.cancel();

    const {
      camera,
      controls,
      canvas,
      targetPosition,
      targetLookAt,
      near,
      far,
      durationMs = 400,
      onStart,
      onTick,
      onComplete,
      onInterrupt,
    } = params;

    return new Promise<void>((resolve) => {
      const startPosition = camera.position.clone();
      const startTarget = controls.target.clone();
      const startNear = camera.near;
      const startFar = camera.far;
      const startTime = performance.now();

      this.active = true;
      onStart?.();

      const interrupt = (): void => {
        if (!this.active) return;
        this.active = false;
        if (this.rafId !== null) {
          cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
        this.removeInterruptListeners(canvas);
        onInterrupt?.();
        resolve();
      };

      this.interruptHandler = interrupt;
      this.addInterruptListeners(canvas);

      const tick = (now: number): void => {
        if (!this.active) return;

        const elapsed = now - startTime;
        const rawT = Math.min(elapsed / durationMs, 1);
        const t = easeOutCubic(rawT);

        camera.position.lerpVectors(startPosition, targetPosition, t);
        controls.target.lerpVectors(startTarget, targetLookAt, t);
        camera.near = startNear + (near - startNear) * t;
        camera.far = startFar + (far - startFar) * t;
        camera.updateProjectionMatrix();
        controls.update();
        onTick?.();

        if (rawT < 1) {
          this.rafId = requestAnimationFrame(tick);
        } else {
          this.active = false;
          this.removeInterruptListeners(canvas);
          onComplete?.();
          resolve();
        }
      };

      this.rafId = requestAnimationFrame(tick);
    });
  }

  cancel(): void {
    if (this.active && this.interruptHandler) {
      this.interruptHandler();
    }
  }

  isAnimating(): boolean {
    return this.active;
  }

  private addInterruptListeners(canvas: HTMLCanvasElement): void {
    if (!this.interruptHandler) return;
    canvas.addEventListener('pointerdown', this.interruptHandler);
    canvas.addEventListener('wheel', this.interruptHandler);
  }

  private removeInterruptListeners(canvas: HTMLCanvasElement): void {
    if (!this.interruptHandler) return;
    canvas.removeEventListener('pointerdown', this.interruptHandler);
    canvas.removeEventListener('wheel', this.interruptHandler);
    this.interruptHandler = null;
  }
}
