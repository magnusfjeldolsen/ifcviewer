import type { CandidateResolver } from './CandidateResolver';
import type { ScreenPoint } from './candidateMath';

/**
 * Pointer and keyboard wiring for the candidate system.
 *
 * Split from `CandidateResolver` so the resolver stays free of DOM: this owns
 * the canvas listeners, the once-per-frame hover throttle, and the `Tab`
 * guards. No WebGL, so it is testable in jsdom.
 */

export interface CandidateInputDeps {
  canvas: HTMLCanvasElement;
  resolver: CandidateResolver;
  /**
   * Whether picking may act right now. App wires the existing ownership
   * gates — no active tool, no pivot picking, no marquee drag — because a
   * second pick path that ignores them is how gestures start fighting.
   */
  canPick: () => boolean;
  /**
   * D10 — whether to show the pre-highlight. When false the resolver still
   * runs (a click and `Tab` must work either way) but nothing is lit.
   */
  showHover: () => boolean;
  /**
   * Skip the hover resolve entirely when there is nothing to arbitrate. With
   * no measurements placed there is exactly one candidate kind, so the whole
   * system can stay dormant and cost nothing on a 100k-mesh model.
   */
  isActive: () => boolean;
  /** Called when a hover or cycle changed what is highlighted. */
  requestRender?: () => void;
  /** Injectable for tests; defaults to `requestAnimationFrame`. */
  scheduleFrame?: (cb: () => void) => void;
}

export class CandidateInput {
  private deps: CandidateInputDeps;

  /** Latest cursor position, in CSS pixels relative to the canvas. */
  private cursor: ScreenPoint | null = null;
  /** True between a pointermove over the canvas and the pointer leaving it. */
  private pointerInside = false;
  /** Set while a hover resolve is already queued for the next frame. */
  private framePending = false;

  private boundPointerMove: (e: PointerEvent) => void;
  private boundPointerLeave: () => void;
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(deps: CandidateInputDeps) {
    this.deps = deps;
    this.boundPointerMove = (e) => this.onPointerMove(e);
    this.boundPointerLeave = () => this.onPointerLeave();
    this.boundKeyDown = (e) => this.onKeyDown(e);

    this.deps.canvas.addEventListener('pointermove', this.boundPointerMove);
    this.deps.canvas.addEventListener('pointerleave', this.boundPointerLeave);
    document.addEventListener('keydown', this.boundKeyDown);
  }

  /** The candidate a click at the current cursor would act on. */
  activeAt(clientX: number, clientY: number): ReturnType<CandidateResolver['getActive']> {
    if (!this.deps.canPick()) return null;
    this.deps.resolver.resolve(this.toCanvas(clientX, clientY));
    return this.deps.resolver.getActive();
  }

  /**
   * Re-run the hover for the current cursor — for a state change that did not
   * move the pointer (a measurement removed, the hover setting toggled).
   */
  refresh(): void {
    if (!this.deps.showHover() || !this.deps.canPick() || !this.deps.isActive()) {
      this.deps.resolver.clear();
      this.deps.requestRender?.();
      return;
    }
    if (this.cursor) this.resolveHover(this.cursor);
  }

  dispose(): void {
    this.deps.canvas.removeEventListener('pointermove', this.boundPointerMove);
    this.deps.canvas.removeEventListener('pointerleave', this.boundPointerLeave);
    document.removeEventListener('keydown', this.boundKeyDown);
    this.deps.resolver.clear();
  }

  // ── Hover ──────────────────────────────────────────────────

  private onPointerMove(e: PointerEvent): void {
    this.pointerInside = true;
    this.cursor = this.toCanvas(e.clientX, e.clientY);

    if (!this.deps.isActive() || !this.deps.canPick() || !this.deps.showHover()) return;

    // One resolve per frame at most. Pointermove fires far faster than the
    // renderer draws, and the resolve raycasts.
    if (this.framePending) return;
    this.framePending = true;
    const schedule = this.deps.scheduleFrame ?? ((cb: () => void) => requestAnimationFrame(cb));
    schedule(() => {
      this.framePending = false;
      if (this.cursor && this.pointerInside) this.resolveHover(this.cursor);
    });
  }

  private onPointerLeave(): void {
    this.pointerInside = false;
    this.cursor = null;
    this.deps.resolver.clear();
    this.deps.requestRender?.();
  }

  private resolveHover(cursor: ScreenPoint): void {
    this.deps.resolver.resolve(cursor);
    this.deps.resolver.refreshHighlight();
    this.deps.requestRender?.();
  }

  // ── Tab cycling ────────────────────────────────────────────

  /**
   * `Tab` cycles the candidates under the cursor — but it is also how keyboard
   * users move through the inspector, the model tree and the toolbar, which
   * are all real DOM. Every guard below exists to make sure we only take `Tab`
   * when the browser's own behaviour has nothing better to do with it: the
   * pointer must be over the viewport, focus must not be inside a panel, and
   * there must be at least two things to cycle between.
   */
  private onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!this.pointerInside || !this.cursor) return;
    if (!this.deps.canPick() || !this.deps.isActive()) return;

    // Focus anywhere other than the page body or the canvas belongs to a
    // control the user is tabbing through. Leave them alone.
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== this.deps.canvas) return;

    this.deps.resolver.resolve(this.cursor);
    if (this.deps.resolver.count() < 2) return;

    e.preventDefault();
    this.deps.resolver.cycle(e.shiftKey ? -1 : 1);
    this.deps.resolver.refreshHighlight();
    this.deps.requestRender?.();
  }

  // ── Helpers ────────────────────────────────────────────────

  private toCanvas(clientX: number, clientY: number): ScreenPoint {
    const rect = this.deps.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
}
