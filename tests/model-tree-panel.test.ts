// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { ModelTreePanel } from '../src/ui/ModelTreePanel';
import type { ModelTreeCallbacks } from '../src/ui/ModelTreePanel';

function createPanel(overrides: Partial<ModelTreeCallbacks> = {}) {
  const parent = document.createElement('div');
  const callbacks: ModelTreeCallbacks = {
    onVisibilityToggle: overrides.onVisibilityToggle ?? vi.fn(),
    onRemoveModel: overrides.onRemoveModel ?? vi.fn(),
    onAddModel: overrides.onAddModel ?? vi.fn(),
  };
  const panel = new ModelTreePanel(parent, callbacks);
  return { parent, panel, callbacks };
}

describe('ModelTreePanel', () => {
  it('should create the panel DOM structure', () => {
    const { parent } = createPanel();
    const container = parent.querySelector('.model-panel');
    expect(container).not.toBeNull();
    expect(container!.querySelector('.model-panel-header')).not.toBeNull();
    expect(container!.querySelector('.model-panel-list')).not.toBeNull();
  });

  it('should add a model row', () => {
    const { parent, panel } = createPanel();
    panel.addModel('m1', 'Architecture.ifc', 42);

    const rows = parent.querySelectorAll('.model-row');
    expect(rows).toHaveLength(1);

    const name = rows[0].querySelector('.model-row-name');
    expect(name?.textContent).toBe('Architecture.ifc');

    const count = rows[0].querySelector('.model-row-count');
    expect(count?.textContent).toBe('42 objects');
  });

  it('should not add duplicate model rows', () => {
    const { parent, panel } = createPanel();
    panel.addModel('m1', 'Arch.ifc', 10);
    panel.addModel('m1', 'Arch.ifc', 10);

    expect(parent.querySelectorAll('.model-row')).toHaveLength(1);
  });

  it('should remove a model row', () => {
    const { parent, panel } = createPanel();
    panel.addModel('m1', 'Arch.ifc', 10);
    panel.addModel('m2', 'Struct.ifc', 20);

    panel.removeModel('m1');

    const rows = parent.querySelectorAll('.model-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('.model-row-name')?.textContent).toBe('Struct.ifc');
  });

  it('should fire onVisibilityToggle when checkbox is toggled', () => {
    const onVisibilityToggle = vi.fn();
    const { parent, panel } = createPanel({ onVisibilityToggle });
    panel.addModel('m1', 'Arch.ifc', 10);

    const checkbox = parent.querySelector('.model-row-checkbox') as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    expect(onVisibilityToggle).toHaveBeenCalledWith('m1', false);
  });

  it('should dim the row when visibility is toggled off', () => {
    const { parent, panel } = createPanel();
    panel.addModel('m1', 'Arch.ifc', 10);

    const checkbox = parent.querySelector('.model-row-checkbox') as HTMLInputElement;
    const row = parent.querySelector('.model-row') as HTMLElement;

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect(row.classList.contains('model-row-hidden')).toBe(true);

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(row.classList.contains('model-row-hidden')).toBe(false);
  });

  it('should fire onRemoveModel when remove button is clicked', () => {
    const onRemoveModel = vi.fn();
    const { parent, panel } = createPanel({ onRemoveModel });
    panel.addModel('m1', 'Arch.ifc', 10);

    const removeBtn = parent.querySelector('.model-row-remove') as HTMLButtonElement;
    removeBtn.click();

    expect(onRemoveModel).toHaveBeenCalledWith('m1');
  });

  it('should fire onAddModel when add button is clicked', () => {
    const onAddModel = vi.fn();
    const { parent } = createPanel({ onAddModel });

    const addBtn = parent.querySelector('.model-panel-add-btn') as HTMLButtonElement;
    addBtn.click();

    expect(onAddModel).toHaveBeenCalled();
  });

  it('should toggle collapse state', () => {
    const { parent } = createPanel();
    const container = parent.querySelector('.model-panel') as HTMLElement;
    const collapseBtn = parent.querySelector('.model-panel-collapse-btn') as HTMLButtonElement;

    expect(container.classList.contains('collapsed')).toBe(false);

    collapseBtn.click();
    expect(container.classList.contains('collapsed')).toBe(true);

    collapseBtn.click();
    expect(container.classList.contains('collapsed')).toBe(false);
  });

  it('should auto-expand when a model is added while collapsed', () => {
    const { parent, panel } = createPanel();
    const container = parent.querySelector('.model-panel') as HTMLElement;
    const collapseBtn = parent.querySelector('.model-panel-collapse-btn') as HTMLButtonElement;

    collapseBtn.click();
    expect(container.classList.contains('collapsed')).toBe(true);

    panel.addModel('m1', 'Arch.ifc', 10);
    expect(container.classList.contains('collapsed')).toBe(false);
  });

  it('should clean up on dispose', () => {
    const { parent, panel } = createPanel();
    panel.addModel('m1', 'Arch.ifc', 10);

    panel.dispose();

    expect(parent.querySelector('.model-panel')).toBeNull();
  });
});
