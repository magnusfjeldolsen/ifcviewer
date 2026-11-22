import type { ToolManager } from '../tools/Tool';

export interface ToolButton {
  name: string;
  icon: string;
  title: string;
  disabled?: boolean;
  /** Called when clicking the button while this tool is already active */
  onReactivate?: () => void;
  /** If provided, button fires this action instead of toggling a tool */
  onClick?: () => void;
  /**
   * A mode switch rather than a tool or an action (flying): clicking runs
   * `onClick` WITHOUT aborting the active tool, the button shows its state
   * through `setPressed`, and tool changes leave that state alone.
   */
  toggle?: boolean;
}

export class Toolbar {
  private container: HTMLElement;
  private toolManager: ToolManager;
  private buttons = new Map<string, HTMLButtonElement>();
  private reactivateHandlers = new Map<string, () => void>();
  /** Mode buttons, whose pressed state is not the active tool's. */
  private toggles = new Set<string>();
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
        if (this.toggles.has(name)) continue;
        btn.classList.toggle('active', active?.name === name);
      }
    });

  }

  addButton(config: ToolButton): void {
    const btn = document.createElement('button');
    btn.className = 'toolbar-btn';
    btn.title = config.title;
    btn.textContent = config.icon;
    btn.disabled = config.disabled ?? false;

    if (config.onReactivate) {
      this.reactivateHandlers.set(config.name, config.onReactivate);
    }

    if (config.toggle) {
      this.toggles.add(config.name);
      btn.setAttribute('aria-pressed', 'false');
    }

    if (!config.disabled) {
      if (config.toggle && config.onClick) {
        const action = config.onClick;
        btn.addEventListener('click', () => {
          action();
          // Off the button, so the keys that drive the mode (Space among
          // them) never press it again.
          btn.blur();
        });
      } else if (config.onClick) {
        const action = config.onClick;
        btn.addEventListener('click', () => {
          this.toolManager.abort();
          action();
        });
      } else {
        btn.addEventListener('click', () => {
          if (this.toolManager.isActive(config.name)) {
            // Already active — call reactivate handler instead of toggling off
            const handler = this.reactivateHandlers.get(config.name);
            if (handler) handler();
          } else {
            this.toolManager.activate(config.name);
          }
        });
      }
    }

    this.buttons.set(config.name, btn);
    this.container.appendChild(btn);
  }

  /** Show a mode button as on or off. */
  setPressed(name: string, pressed: boolean): void {
    const btn = this.buttons.get(name);
    if (!btn) return;
    btn.classList.toggle('active', pressed);
    btn.setAttribute('aria-pressed', String(pressed));
  }

  /** Call after all buttons are added to append the abort button at the end */
  finalize(): void {
    this.container.appendChild(this.abortButton);
  }

  dispose(): void {
    this.container.remove();
  }
}
