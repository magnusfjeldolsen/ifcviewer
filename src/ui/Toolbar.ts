import type { ToolManager } from '../tools/Tool';

export interface ToolButton {
  name: string;
  icon: string;
  title: string;
  disabled?: boolean;
}

export class Toolbar {
  private container: HTMLElement;
  private toolManager: ToolManager;
  private buttons = new Map<string, HTMLButtonElement>();
  private abortButton: HTMLButtonElement;

  constructor(parent: HTMLElement, toolManager: ToolManager) {
    this.toolManager = toolManager;

    this.container = document.createElement('div');
    this.container.id = 'toolbar';
    parent.appendChild(this.container);

    // Abort button — hidden by default, shown when a tool is active
    this.abortButton = document.createElement('button');
    this.abortButton.className = 'toolbar-btn abort-btn';
    this.abortButton.title = 'Cancel (Esc)';
    this.abortButton.textContent = '✕';
    this.abortButton.style.display = 'none';
    this.abortButton.addEventListener('click', () => this.toolManager.abort());

    // Listen for tool changes to update button states
    this.toolManager.onChange((active) => {
      this.abortButton.style.display = active ? '' : 'none';
      for (const [name, btn] of this.buttons) {
        btn.classList.toggle('active', active?.name === name);
      }
    });

    // Escape key aborts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.toolManager.abort();
    });
  }

  addButton(config: ToolButton): void {
    const btn = document.createElement('button');
    btn.className = 'toolbar-btn';
    btn.title = config.title;
    btn.textContent = config.icon;
    btn.disabled = config.disabled ?? false;

    if (!config.disabled) {
      btn.addEventListener('click', () => this.toolManager.activate(config.name));
    }

    this.buttons.set(config.name, btn);
    this.container.appendChild(btn);
  }

  /** Call after all buttons are added to append the abort button at the end */
  finalize(): void {
    this.container.appendChild(this.abortButton);
  }

  dispose(): void {
    this.container.remove();
  }
}
