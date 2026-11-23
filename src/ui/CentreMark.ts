/**
 * A calm "dot in a ring" at the exact centre of a view, for when there is no
 * cursor (flying with the mouse captured): it shows where a click will land.
 *
 * The ring turns blue while something is under it; after the mark has rested
 * on the same thing for `TAG_REST_MS` a one-line name tag appears under it.
 * This module knows nothing about flying or about IFC: the caller says what
 * is under the mark (`setTarget`), whether the view is moving fast
 * (`setMoving`), and supplies the name lazily, once per rested target.
 */

/** Switch the name tag off here; the ring still reacts. */
export const SHOW_NAME_TAG = true;

/** How long the mark rests on the same target before its name shows, ms. */
export const TAG_REST_MS = 300;

/** What is under the mark. `key` says whether it is still the same thing. */
export interface CentreMarkTarget {
  key: string;
  /**
   * The name for the tag, asked for once when the mark has rested on this
   * target. The signal aborts when the mark moves on before it answers.
   */
  name?: (signal: AbortSignal) => Promise<string | null> | string | null;
}

export interface CentreMarkOptions {
  /** The element the mark is centred on (the 3D canvas), not the window. */
  anchor: HTMLElement;
  showNameTag?: boolean;
  restMs?: number;
}

export interface CentreMarkState {
  shown: boolean;
  onTarget: boolean;
  tag: string | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export class CentreMark {
  private el: HTMLElement;
  private tagEl: HTMLElement;
  private readonly anchor: HTMLElement;
  private readonly showNameTag: boolean;
  private readonly restMs: number;

  private target: CentreMarkTarget | null = null;
  private moving = false;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: AbortController | null = null;
  private tag: string | null = null;

  constructor(parent: HTMLElement, options: CentreMarkOptions) {
    this.anchor = options.anchor;
    this.showNameTag = options.showNameTag ?? SHOW_NAME_TAG;
    this.restMs = options.restMs ?? TAG_REST_MS;

    this.el = document.createElement('div');
    this.el.className = 'centre-mark';
    this.el.hidden = true;
    this.el.setAttribute('aria-hidden', 'true');

    // SVG so the ring and dot stay crisp at any device pixel ratio. Each
    // shape is drawn twice: a dark edge under a white stroke, so it reads on
    // light and dark backgrounds alike.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'centre-mark-svg');
    svg.setAttribute('viewBox', '-12 -12 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    const circle = (cls: string, r: number): SVGCircleElement => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('r', String(r));
      return c;
    };
    svg.append(
      circle('centre-mark-ring-edge', 10),
      circle('centre-mark-ring', 10),
      circle('centre-mark-dot', 2),
    );

    this.tagEl = document.createElement('div');
    this.tagEl.className = 'centre-mark-tag';
    this.tagEl.hidden = true;

    this.el.append(svg, this.tagEl);
    parent.appendChild(this.el);
  }

  show(): void {
    if (!this.el.hidden) return;
    this.el.hidden = false;
    this.reposition();
    window.addEventListener('resize', this.reposition);
  }

  hide(): void {
    this.el.hidden = true;
    window.removeEventListener('resize', this.reposition);
    this.setTarget(null);
    this.moving = false;
  }

  isShown(): boolean {
    return !this.el.hidden;
  }

  /** What is under the mark now; null over empty space. */
  setTarget(target: CentreMarkTarget | null): void {
    const same = target !== null && this.target !== null && target.key === this.target.key;
    this.target = target;
    if (same) return;
    // Another thing, or nothing: the tag goes at once.
    this.cancelTag();
    this.el.classList.toggle('on-target', target !== null);
    this.scheduleTag();
  }

  /** While the view moves fast the tag stays hidden; it may come back once it slows. */
  setMoving(fast: boolean): void {
    if (fast === this.moving) return;
    this.moving = fast;
    if (fast) this.cancelTag();
    else this.scheduleTag();
  }

  state(): CentreMarkState {
    return { shown: this.isShown(), onTarget: this.target !== null, tag: this.tag };
  }

  /** Keep the mark on the centre of the anchor (the canvas, not the window). */
  reposition = (): void => {
    const rect = this.anchor.getBoundingClientRect();
    this.el.style.left = `${rect.left + rect.width / 2}px`;
    this.el.style.top = `${rect.top + rect.height / 2}px`;
  };

  dispose(): void {
    this.hide();
    this.el.remove();
  }

  private scheduleTag(): void {
    if (!this.showNameTag || this.moving || !this.isShown()) return;
    if (!this.target?.name || this.restTimer !== null || this.tag !== null || this.pending) return;
    // By key: the caller hands a fresh target object on every look.
    const key = this.target.key;
    this.restTimer = setTimeout(() => {
      this.restTimer = null;
      const target = this.target;
      if (!target?.name || target.key !== key || this.moving) return;
      const ask = target.name;
      const controller = new AbortController();
      this.pending = controller;
      void Promise.resolve()
        .then(() => ask(controller.signal))
        .then((name) => {
          if (controller.signal.aborted || this.target?.key !== key || this.moving) return;
          this.pending = null;
          if (!name) return;
          this.tag = name;
          this.tagEl.textContent = name;
          this.tagEl.hidden = false;
        })
        .catch(() => {
          if (this.pending === controller) this.pending = null;
        });
    }, this.restMs);
  }

  private cancelTag(): void {
    if (this.restTimer !== null) {
      clearTimeout(this.restTimer);
      this.restTimer = null;
    }
    this.pending?.abort();
    this.pending = null;
    this.tag = null;
    this.tagEl.hidden = true;
    this.tagEl.textContent = '';
  }
}
