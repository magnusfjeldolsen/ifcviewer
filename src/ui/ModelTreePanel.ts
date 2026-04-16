export interface ModelTreeCallbacks {
  onVisibilityToggle: (id: string, visible: boolean) => void;
  onRemoveModel: (id: string) => void;
  onAddModel: () => void;
}

interface ModelRow {
  id: string;
  name: string;
  objectCount: number;
  visible: boolean;
  element: HTMLElement;
  checkbox: HTMLInputElement;
}

export class ModelTreePanel {
  private container: HTMLElement;
  private header: HTMLElement;
  private list: HTMLElement;
  private collapseBtn: HTMLButtonElement;
  private rows = new Map<string, ModelRow>();
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
    addBtn.title = 'Add model';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => this.callbacks.onAddModel());

    this.collapseBtn = document.createElement('button');
    this.collapseBtn.className = 'model-panel-collapse-btn';
    this.collapseBtn.title = 'Collapse panel';
    this.collapseBtn.textContent = '◀';
    this.collapseBtn.addEventListener('click', () => this.toggleCollapse());

    headerActions.appendChild(addBtn);
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
