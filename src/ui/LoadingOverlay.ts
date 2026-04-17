export class LoadingOverlay {
  private container: HTMLElement;
  private svg: SVGSVGElement;
  private track: SVGCircleElement;
  private fill: SVGCircleElement;
  private percentText: SVGTextElement;
  private labelEl: HTMLElement;
  private readonly radius = 40;
  private readonly strokeWidth = 6;
  private readonly circumference: number;

  constructor(parent: HTMLElement) {
    this.circumference = 2 * Math.PI * this.radius;

    this.container = document.createElement('div');
    this.container.className = 'loading-overlay';
    this.container.style.display = 'none';

    const svgNS = 'http://www.w3.org/2000/svg';
    const size = (this.radius + this.strokeWidth) * 2;

    this.svg = document.createElementNS(svgNS, 'svg');
    this.svg.setAttribute('width', String(size));
    this.svg.setAttribute('height', String(size));
    this.svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    this.svg.classList.add('loading-spinner-svg');

    const cx = size / 2;
    const cy = size / 2;

    // Background track
    this.track = document.createElementNS(svgNS, 'circle');
    this.track.setAttribute('cx', String(cx));
    this.track.setAttribute('cy', String(cy));
    this.track.setAttribute('r', String(this.radius));
    this.track.classList.add('loading-spinner-track');

    // Progress fill
    this.fill = document.createElementNS(svgNS, 'circle');
    this.fill.setAttribute('cx', String(cx));
    this.fill.setAttribute('cy', String(cy));
    this.fill.setAttribute('r', String(this.radius));
    this.fill.classList.add('loading-spinner-fill');
    this.fill.style.strokeDasharray = String(this.circumference);
    this.fill.style.strokeDashoffset = String(this.circumference);

    // Percentage text
    this.percentText = document.createElementNS(svgNS, 'text');
    this.percentText.setAttribute('x', String(cx));
    this.percentText.setAttribute('y', String(cy));
    this.percentText.classList.add('loading-spinner-text');
    this.percentText.textContent = '0%';

    this.svg.appendChild(this.track);
    this.svg.appendChild(this.fill);
    this.svg.appendChild(this.percentText);
    this.container.appendChild(this.svg);

    // Label below the circle
    this.labelEl = document.createElement('div');
    this.labelEl.className = 'loading-overlay-label';
    this.container.appendChild(this.labelEl);

    parent.appendChild(this.container);
  }

  show(label?: string): void {
    this.container.style.display = 'flex';
    this.setProgress(0);
    this.labelEl.textContent = label || '';
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  setProgress(percent: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const offset = this.circumference - (clamped / 100) * this.circumference;
    this.fill.style.strokeDashoffset = String(offset);
    this.percentText.textContent = `${clamped}%`;
  }

  setLabel(text: string): void {
    this.labelEl.textContent = text;
  }

  dispose(): void {
    this.container.remove();
  }
}
