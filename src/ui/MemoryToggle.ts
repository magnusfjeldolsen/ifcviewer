import { SessionStore } from '../services/SessionStore';

export class MemoryToggle {
  private container: HTMLElement;
  private checkbox: HTMLInputElement;
  private changeCallbacks: Array<(enabled: boolean) => void> = [];

  constructor(parent: HTMLElement, private store: SessionStore) {
    this.container = document.createElement('div');
    this.container.className = 'memory-toggle';

    const label = document.createElement('span');
    label.className = 'memory-toggle-label';
    label.textContent = 'Remember';
    this.container.appendChild(label);

    const switchLabel = document.createElement('label');
    switchLabel.className = 'memory-toggle-switch';

    this.checkbox = document.createElement('input');
    this.checkbox.type = 'checkbox';
    this.checkbox.checked = this.store.isMemoryEnabled();
    this.checkbox.addEventListener('change', () => this.handleToggle());

    const slider = document.createElement('span');
    slider.className = 'memory-toggle-slider';

    switchLabel.appendChild(this.checkbox);
    switchLabel.appendChild(slider);
    this.container.appendChild(switchLabel);

    parent.appendChild(this.container);
  }

  onChange(cb: (enabled: boolean) => void): void {
    this.changeCallbacks.push(cb);
  }

  private handleToggle(): void {
    const enabled = this.checkbox.checked;
    this.store.setMemoryEnabled(enabled);
    if (!enabled) {
      this.store.clearSession();
    }
    for (const cb of this.changeCallbacks) cb(enabled);
  }

  dispose(): void {
    this.container.remove();
  }
}
