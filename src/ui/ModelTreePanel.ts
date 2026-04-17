export interface ModelTreeCallbacks {
  onVisibilityToggle: (id: string, visible: boolean) => void;
  onRemoveModel: (id: string) => void;
  onAddModel: () => void;
  onAddRemoteModel?: () => void;
}

interface ModelRow {
  id: string;
  name: string;
  objectCount: number;
  visible: boolean;
  element: HTMLElement;
  checkbox: HTMLInputElement;
}

interface LoadingRow {
  id: string;
  element: HTMLElement;
  progressFill: SVGCircleElement;
  percentText: SVGTextElement;
  statusEl: HTMLElement;
  circumference: number;
}

export class ModelTreePanel {
  private container: HTMLElement;
  private header: HTMLElement;
  private list: HTMLElement;
  private collapseBtn: HTMLButtonElement;
  private rows = new Map<string, ModelRow>();
  private loadingRows = new Map<string, LoadingRow>();
  private collapsed = false;
  private callbacks: ModelTreeCallbacks;

  constructor(parent: HTMLElement, callbacks: ModelTreeCallbacks) {
    this.callbacks = callbacks;

    // Panel container
    this.container = document.createElement('div');
    this.container.className = 'model-panel';
    parent.appendChild(this.container);

    // Header
    this.header = document.createElement('div');
    this.header.className = 'model-panel-header';

    const title = document.createElement('span');
    title.className = 'model-panel-title';
    title.textContent = 'Models';

    const headerActions = document.createElement('div');
    headerActions.className = 'model-panel-header-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'model-panel-add-btn';
    addBtn.title = 'Add local model';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => this.callbacks.onAddModel());

    const addRemoteBtn = document.createElement('button');
    addRemoteBtn.className = 'model-panel-add-btn';
    addRemoteBtn.title = 'Add remote model';
    addRemoteBtn.textContent = '\u2601'; // cloud symbol ☁
    addRemoteBtn.addEventListener('click', () => this.callbacks.onAddRemoteModel?.());

    this.collapseBtn = document.createElement('button');
    this.collapseBtn.className = 'model-panel-collapse-btn';
    this.collapseBtn.title = 'Collapse panel';
    this.collapseBtn.textContent = '◀';
    this.collapseBtn.addEventListener('click', () => this.toggleCollapse());

    headerActions.appendChild(addBtn);
    headerActions.appendChild(addRemoteBtn);
    headerActions.appendChild(this.collapseBtn);
    this.header.appendChild(title);
    this.header.appendChild(headerActions);
    this.container.appendChild(this.header);

    // Model list
    this.list = document.createElement('div');
    this.list.className = 'model-panel-list';
    this.container.appendChild(this.list);
  }

  addModel(id: string, name: string, objectCount: number): void {
    if (this.rows.has(id)) return;

    const el = document.createElement('div');
    el.className = 'model-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.className = 'model-row-checkbox';
    checkbox.title = 'Toggle visibility';
    checkbox.addEventListener('change', () => {
      const visible = checkbox.checked;
      row.visible = visible;
      el.classList.toggle('model-row-hidden', !visible);
      this.callbacks.onVisibilityToggle(id, visible);
    });

    const info = document.createElement('div');
    info.className = 'model-row-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'model-row-name';
    nameEl.textContent = name;
    nameEl.title = name;

    const countEl = document.createElement('span');
    countEl.className = 'model-row-count';
    countEl.textContent = `${objectCount} objects`;

    info.appendChild(nameEl);
    info.appendChild(countEl);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'model-row-remove';
    removeBtn.title = 'Remove model';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      this.callbacks.onRemoveModel(id);
    });

    el.appendChild(checkbox);
    el.appendChild(info);
    el.appendChild(removeBtn);
    this.list.appendChild(el);

    const row: ModelRow = { id, name, objectCount, visible: true, element: el, checkbox };
    this.rows.set(id, row);

    // Auto-expand when a model is added
    if (this.collapsed) this.toggleCollapse();
  }

  removeModel(id: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.element.remove();
    this.rows.delete(id);
  }

  addLoadingModel(id: string, name: string): void {
    if (this.loadingRows.has(id)) return;

    const el = document.createElement('div');
    el.className = 'model-row model-row-loading';

    // Mini SVG spinner with progress
    const svgNS = 'http://www.w3.org/2000/svg';
    const radius = 10;
    const stroke = 3;
    const size = (radius + stroke) * 2;
    const circumference = 2 * Math.PI * radius;

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.classList.add('model-row-spinner');

    const cx = size / 2;
    const cy = size / 2;

    const track = document.createElementNS(svgNS, 'circle');
    track.setAttribute('cx', String(cx));
    track.setAttribute('cy', String(cy));
    track.setAttribute('r', String(radius));
    track.classList.add('model-row-spinner-track');

    const fill = document.createElementNS(svgNS, 'circle');
    fill.setAttribute('cx', String(cx));
    fill.setAttribute('cy', String(cy));
    fill.setAttribute('r', String(radius));
    fill.classList.add('model-row-spinner-fill');
    fill.style.strokeDasharray = String(circumference);
    fill.style.strokeDashoffset = String(circumference);

    const percentText = document.createElementNS(svgNS, 'text');
    percentText.setAttribute('x', String(cx));
    percentText.setAttribute('y', String(cy));
    percentText.classList.add('model-row-spinner-text');
    percentText.textContent = '';

    svg.appendChild(track);
    svg.appendChild(fill);
    svg.appendChild(percentText);

    const info = document.createElement('div');
    info.className = 'model-row-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'model-row-name';
    nameEl.textContent = name;
    nameEl.title = name;

    const statusEl = document.createElement('span');
    statusEl.className = 'model-row-count model-row-status';
    statusEl.textContent = 'Connecting...';

    info.appendChild(nameEl);
    info.appendChild(statusEl);

    el.appendChild(svg);
    el.appendChild(info);
    this.list.appendChild(el);

    this.loadingRows.set(id, { id, element: el, progressFill: fill, percentText, statusEl, circumference });

    if (this.collapsed) this.toggleCollapse();
  }

  updateLoadingProgress(id: string, loaded: number, total: number): void {
    const row = this.loadingRows.get(id);
    if (!row) return;

    const pct = Math.round((loaded / total) * 100);
    const offset = row.circumference - (pct / 100) * row.circumference;
    row.progressFill.style.strokeDashoffset = String(offset);
    row.percentText.textContent = `${pct}`;

    const loadedMB = (loaded / 1024 / 1024).toFixed(1);
    const totalMB = (total / 1024 / 1024).toFixed(1);
    row.statusEl.textContent = `${loadedMB} / ${totalMB} MB`;
  }

  setLoadingStatus(id: string, text: string): void {
    const row = this.loadingRows.get(id);
    if (!row) return;
    row.statusEl.textContent = text;
  }

  removeLoadingModel(id: string): void {
    const row = this.loadingRows.get(id);
    if (!row) return;
    row.element.remove();
    this.loadingRows.delete(id);
  }

  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.container.classList.toggle('collapsed', this.collapsed);
    this.collapseBtn.textContent = this.collapsed ? '▶' : '◀';
    this.collapseBtn.title = this.collapsed ? 'Expand panel' : 'Collapse panel';
  }

  getContainer(): HTMLElement {
    return this.container;
  }

  dispose(): void {
    this.container.remove();
    this.rows.clear();
  }
}
