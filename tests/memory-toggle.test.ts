/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryToggle } from '../src/ui/MemoryToggle';
import { SessionStore } from '../src/services/SessionStore';

describe('MemoryToggle', () => {
  let parent: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  it('should render with checkbox checked when memory is enabled (default)', () => {
    const store = new SessionStore();
    new MemoryToggle(parent, store);

    const checkbox = parent.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(true);
  });

  it('should render with checkbox unchecked when memory is disabled', () => {
    const store = new SessionStore();
    store.setMemoryEnabled(false);
    new MemoryToggle(parent, store);

    const checkbox = parent.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('should call clearSession when toggled OFF', () => {
    const store = new SessionStore();
    const clearSpy = vi.spyOn(store, 'clearSession');
    new MemoryToggle(parent, store);

    const checkbox = parent.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    expect(clearSpy).toHaveBeenCalledOnce();
  });

  it('should not call clearSession when toggled ON', () => {
    const store = new SessionStore();
    store.setMemoryEnabled(false);
    const clearSpy = vi.spyOn(store, 'clearSession');
    new MemoryToggle(parent, store);

    const checkbox = parent.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('should fire onChange callback with correct value', () => {
    const store = new SessionStore();
    const toggle = new MemoryToggle(parent, store);
    const callback = vi.fn();
    toggle.onChange(callback);

    const checkbox = parent.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    expect(callback).toHaveBeenCalledWith(false);

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    expect(callback).toHaveBeenCalledWith(true);
  });

  it('should remove DOM on dispose', () => {
    const store = new SessionStore();
    const toggle = new MemoryToggle(parent, store);
    expect(parent.querySelector('.memory-toggle')).not.toBeNull();

    toggle.dispose();
    expect(parent.querySelector('.memory-toggle')).toBeNull();
  });
});
