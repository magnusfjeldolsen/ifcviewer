// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyboardShortcuts } from '../src/ui/KeyboardShortcuts';
import { HelpOverlay } from '../src/ui/HelpOverlay';

describe('HelpOverlay', () => {
  let parent: HTMLElement;
  let shortcuts: KeyboardShortcuts;
  let overlay: HelpOverlay;

  beforeEach(() => {
    parent = document.createElement('div');
    document.body.appendChild(parent);
    shortcuts = new KeyboardShortcuts();
    shortcuts.register({ key: 'c', label: 'Section Cut', action: vi.fn() });
    shortcuts.register({ key: 'm', label: 'Measure', action: vi.fn() });
    overlay = new HelpOverlay(parent, shortcuts);
  });

  afterEach(() => {
    overlay.dispose();
    shortcuts.dispose();
    parent.remove();
  });

  it('should render a ? button', () => {
    const btn = parent.querySelector('.help-button');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('?');
  });

  it('should not show overlay initially', () => {
    expect(parent.querySelector('.help-overlay')).toBeNull();
    expect(overlay.isOpen()).toBe(false);
  });

  it('should show overlay when button is clicked', () => {
    const btn = parent.querySelector('.help-button') as HTMLElement;
    btn.click();

    expect(parent.querySelector('.help-overlay')).not.toBeNull();
    expect(overlay.isOpen()).toBe(true);
  });

  it('should hide overlay when button is clicked again', () => {
    const btn = parent.querySelector('.help-button') as HTMLElement;
    btn.click();
    btn.click();

    expect(parent.querySelector('.help-overlay')).toBeNull();
    expect(overlay.isOpen()).toBe(false);
  });

  it('should list all registered keyboard shortcuts', () => {
    const btn = parent.querySelector('.help-button') as HTMLElement;
    btn.click();

    const labels = parent.querySelectorAll('.help-overlay-label');
    const texts = Array.from(labels).map((el) => el.textContent);

    expect(texts).toContain('Section Cut');
    expect(texts).toContain('Measure');
  });

  it('should list mouse controls', () => {
    const btn = parent.querySelector('.help-button') as HTMLElement;
    btn.click();

    const labels = parent.querySelectorAll('.help-overlay-label');
    const texts = Array.from(labels).map((el) => el.textContent);

    expect(texts).toContain('Orbit');
    expect(texts).toContain('Pan');
    expect(texts).toContain('Zoom');
  });

  it('should format key labels correctly', () => {
    const btn = parent.querySelector('.help-button') as HTMLElement;
    btn.click();

    const keys = parent.querySelectorAll('.help-overlay-key');
    const texts = Array.from(keys).map((el) => el.textContent);

    expect(texts).toContain('C');
    expect(texts).toContain('M');
  });

  it('should toggle via public toggle method', () => {
    overlay.toggle();
    expect(overlay.isOpen()).toBe(true);

    overlay.toggle();
    expect(overlay.isOpen()).toBe(false);
  });

  it('should clean up on dispose', () => {
    overlay.toggle();
    overlay.dispose();

    expect(parent.querySelector('.help-button')).toBeNull();
    expect(parent.querySelector('.help-overlay')).toBeNull();
    expect(overlay.isOpen()).toBe(false);
  });
});
