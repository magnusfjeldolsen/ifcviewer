import { recentFps } from './perfMath';

export interface OverlaySample {
  /** Timestamps (performance.now) of recent frames drawn. */
  frames: readonly number[];
  lastRenderCpuMs: number | null;
  drawCalls: number;
  triangles: number;
  meshes: number;
}

/**
 * The on-screen readout for `?stats`. Refreshes four times a second rather
 * than every frame, so writing the numbers costs next to nothing and they stay
 * still long enough to read.
 */
export class StatsOverlay {
  private el: HTMLElement;
  private rows = new Map<string, HTMLElement>();
  private timer: ReturnType<typeof setInterval>;

  constructor(parent: HTMLElement, private sample: () => OverlaySample) {
    this.el = document.createElement('div');
    this.el.className = 'stats-overlay';
    Object.assign(this.el.style, {
      position: 'fixed',
      // Bottom-left, above the cookie button: the toolbar, model tree,
      // inspector and action tray hold the other corners.
      bottom: '64px',
      left: '12px',
      zIndex: '1000',
      padding: '6px 10px',
      background: 'rgba(17, 24, 39, 0.85)',
      color: '#f9fafb',
      font: '13px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
      borderRadius: '6px',
      pointerEvents: 'none',
      display: 'grid',
      gridTemplateColumns: 'auto auto',
      columnGap: '12px',
    } satisfies Partial<CSSStyleDeclaration>);
    for (const label of ['fps', 'frame', 'render cpu', 'draw calls', 'triangles', 'meshes']) {
      const name = document.createElement('span');
      name.textContent = label;
      name.style.opacity = '0.7';
      const value = document.createElement('span');
      value.style.textAlign = 'right';
      this.el.append(name, value);
      this.rows.set(label, value);
    }
    parent.appendChild(this.el);
    this.update();
    this.timer = setInterval(() => this.update(), 250);
  }

  private set(label: string, text: string): void {
    const el = this.rows.get(label);
    if (el && el.textContent !== text) el.textContent = text;
  }

  update(): void {
    const s = this.sample();
    const fps = recentFps(s.frames, performance.now());
    this.set('fps', fps === null ? 'idle' : fps.toFixed(0));
    this.set('frame', fps === null ? '—' : `${(1000 / fps).toFixed(1)} ms`);
    this.set('render cpu', s.lastRenderCpuMs === null ? '—' : `${s.lastRenderCpuMs.toFixed(1)} ms`);
    this.set('draw calls', s.drawCalls.toLocaleString());
    this.set('triangles', s.triangles.toLocaleString());
    this.set('meshes', s.meshes.toLocaleString());
  }

  dispose(): void {
    clearInterval(this.timer);
    this.el.remove();
  }
}
