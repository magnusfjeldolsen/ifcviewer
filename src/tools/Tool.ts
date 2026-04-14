export interface Tool {
  readonly name: string;
  activate(): void;
  deactivate(): void;
  dispose(): void;
}

export class ToolManager {
  private tools = new Map<string, Tool>();
  private activeTool: Tool | null = null;
  private onChangeCallbacks: Array<(active: Tool | null) => void> = [];

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  activate(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;

    // Deactivate current tool first
    if (this.activeTool) {
      this.activeTool.deactivate();
    }

    // If clicking the same tool, just deactivate (toggle off)
    if (this.activeTool === tool) {
      this.activeTool = null;
      this.notifyChange();
      return true;
    }

    this.activeTool = tool;
    tool.activate();
    this.notifyChange();
    return true;
  }

  abort(): void {
    if (this.activeTool) {
      this.activeTool.deactivate();
      this.activeTool = null;
      this.notifyChange();
    }
  }

  getActiveTool(): Tool | null {
    return this.activeTool;
  }

  isActive(name: string): boolean {
    return this.activeTool?.name === name;
  }

  onChange(callback: (active: Tool | null) => void): void {
    this.onChangeCallbacks.push(callback);
  }

  dispose(): void {
    this.abort();
    for (const tool of this.tools.values()) {
      tool.dispose();
    }
    this.tools.clear();
    this.onChangeCallbacks = [];
  }

  private notifyChange(): void {
    for (const cb of this.onChangeCallbacks) {
      cb(this.activeTool);
    }
  }
}
