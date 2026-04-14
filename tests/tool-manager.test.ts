import { describe, it, expect, vi } from 'vitest';
import { ToolManager } from '../src/tools/Tool';
import type { Tool } from '../src/tools/Tool';

function createMockTool(name: string): Tool {
  return {
    name,
    activate: vi.fn(),
    deactivate: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('ToolManager', () => {
  it('should register and activate a tool', () => {
    const manager = new ToolManager();
    const tool = createMockTool('test');
    manager.register(tool);

    manager.activate('test');

    expect(tool.activate).toHaveBeenCalledOnce();
    expect(manager.getActiveTool()).toBe(tool);
    expect(manager.isActive('test')).toBe(true);
  });

  it('should return false when activating unregistered tool', () => {
    const manager = new ToolManager();
    expect(manager.activate('nonexistent')).toBe(false);
  });

  it('should deactivate previous tool when activating new one', () => {
    const manager = new ToolManager();
    const toolA = createMockTool('a');
    const toolB = createMockTool('b');
    manager.register(toolA);
    manager.register(toolB);

    manager.activate('a');
    manager.activate('b');

    expect(toolA.deactivate).toHaveBeenCalledOnce();
    expect(toolB.activate).toHaveBeenCalledOnce();
    expect(manager.getActiveTool()).toBe(toolB);
  });

  it('should toggle off when clicking the same tool', () => {
    const manager = new ToolManager();
    const tool = createMockTool('test');
    manager.register(tool);

    manager.activate('test');
    manager.activate('test');

    expect(tool.deactivate).toHaveBeenCalledOnce();
    expect(manager.getActiveTool()).toBeNull();
  });

  it('should abort the active tool', () => {
    const manager = new ToolManager();
    const tool = createMockTool('test');
    manager.register(tool);

    manager.activate('test');
    manager.abort();

    expect(tool.deactivate).toHaveBeenCalledOnce();
    expect(manager.getActiveTool()).toBeNull();
  });

  it('should do nothing when aborting with no active tool', () => {
    const manager = new ToolManager();
    // Should not throw
    manager.abort();
    expect(manager.getActiveTool()).toBeNull();
  });

  it('should notify onChange callbacks', () => {
    const manager = new ToolManager();
    const tool = createMockTool('test');
    manager.register(tool);

    const callback = vi.fn();
    manager.onChange(callback);

    manager.activate('test');
    expect(callback).toHaveBeenCalledWith(tool);

    manager.abort();
    expect(callback).toHaveBeenCalledWith(null);
  });

  it('should dispose all tools', () => {
    const manager = new ToolManager();
    const toolA = createMockTool('a');
    const toolB = createMockTool('b');
    manager.register(toolA);
    manager.register(toolB);

    manager.activate('a');
    manager.dispose();

    expect(toolA.deactivate).toHaveBeenCalled();
    expect(toolA.dispose).toHaveBeenCalled();
    expect(toolB.dispose).toHaveBeenCalled();
    expect(manager.getActiveTool()).toBeNull();
  });
});
