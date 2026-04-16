import { Viewer } from '../viewer/Viewer';
import { ModelManager } from '../viewer/ModelManager';
import { FileLoader } from '../loader/FileLoader';
import { IfcParser } from '../parser/IfcParser';
import { ToolManager } from '../tools/Tool';
import { ClippingTool } from '../tools/ClippingTool';
import { MeasurementTool } from '../tools/MeasurementTool';
import { Toolbar } from '../ui/Toolbar';
import { MemoryToggle } from '../ui/MemoryToggle';
import { SessionStore } from '../services/SessionStore';
import type { LoadedFile } from '../loader/FileLoader';

export class App {
  private viewer: Viewer;
  private modelManager: ModelManager;
  private fileLoader: FileLoader;
  private parser: IfcParser;
  private toolManager: ToolManager;
  private toolbar: Toolbar;
  private sessionStore: SessionStore;
  private memoryToggle: MemoryToggle;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private statusEl: HTMLElement | null;

  constructor(canvas: HTMLCanvasElement) {
    this.viewer = new Viewer(canvas);
    this.modelManager = new ModelManager(this.viewer.getScene());
    this.fileLoader = new FileLoader();
    this.parser = new IfcParser();
    this.statusEl = document.getElementById('status');

    // Tools
    this.toolManager = new ToolManager();

    const clippingTool = new ClippingTool({
      renderer: this.viewer.getRenderer(),
      scene: this.viewer.getScene(),
      camera: this.viewer.getCamera(),
      canvas: this.viewer.getCanvas(),
    });
    this.toolManager.register(clippingTool);

    const measurementTool = new MeasurementTool({
      renderer: this.viewer.getRenderer(),
      scene: this.viewer.getScene(),
      camera: this.viewer.getCamera(),
      canvas: this.viewer.getCanvas(),
    });
    this.toolManager.register(measurementTool);

    // Keep clipping handle and measurement markers at constant screen size
    this.viewer.onUpdate(() => {
      clippingTool.update();
      measurementTool.update();
    });

    // Toolbar UI
    const appEl = document.getElementById('app')!;
    this.toolbar = new Toolbar(appEl, this.toolManager);
    this.toolbar.addButton({
      name: 'clipping',
      icon: '✂',
      title: 'Section Cut (C)',
      onReactivate: () => clippingTool.enterPlacingMode(),
    });
    this.toolbar.addButton({
      name: 'measurement',
      icon: '📏',
      title: 'Measure (M)',
    });
    this.toolbar.addButton({ name: 'transparify', icon: '◻', title: 'Transparify All', disabled: true });
    this.toolbar.addButton({ name: 'reset', icon: '↺', title: 'Reset View', disabled: true });
    this.toolbar.finalize();

    // Session persistence
    this.sessionStore = new SessionStore();
    this.memoryToggle = new MemoryToggle(appEl, this.sessionStore);
    this.memoryToggle.onChange((enabled) => {
      if (!enabled && this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
    });

    this.setupKeyboardShortcuts();
  }

  private setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'c' || e.key === 'C') {
        if (this.toolManager.isActive('clipping')) {
          // Already active — re-enter placement mode for a new clip
          const tool = this.toolManager.getActiveTool() as ClippingTool;
          tool.enterPlacingMode();
        } else {
          this.toolManager.activate('clipping');
        }
      }

      if (e.key === 'm' || e.key === 'M') {
        if (!this.toolManager.isActive('measurement')) {
          this.toolManager.activate('measurement');
        }
      }
    });
  }

  async start(): Promise<void> {
    this.setStatus('Initializing IFC engine...');
    await this.parser.init();
    this.setStatus('');

    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input') as HTMLInputElement | null;

    if (dropZone) this.fileLoader.setupDropZone(dropZone);
    if (fileInput) this.fileLoader.setupFileInput(fileInput);

    this.fileLoader.onLoad((file) => this.handleFile(file));

    this.viewer.animate();
    this.showUploadPrompt(true);

    // Restore session if memory is enabled
    if (this.sessionStore.isMemoryEnabled()) {
      await this.restoreSession();
    }

    // Auto-save camera state on changes (throttled to 1s)
    this.viewer.onUpdate(() => this.scheduleSave());

    // Final save on page unload
    window.addEventListener('beforeunload', this.boundBeforeUnload);
  }

  private boundBeforeUnload = (): void => {
    if (this.sessionStore.isMemoryEnabled()) {
      this.sessionStore.saveSession({
        camera: this.viewer.getCameraState(),
        fileNames: this.modelManager.getModelIds(),
      });
    }
  };

  private scheduleSave(): void {
    if (!this.sessionStore.isMemoryEnabled()) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.sessionStore.saveSession({
        camera: this.viewer.getCameraState(),
        fileNames: this.modelManager.getModelIds(),
      });
    }, 1000);
  }

  private async restoreSession(): Promise<void> {
    const session = this.sessionStore.getSession();
    const files = await this.sessionStore.getFiles();

    if (files.length > 0) {
      this.showUploadPrompt(false);
      for (const file of files) {
        try {
          this.setStatus(`Restoring ${file.name}...`);
          const parsed = await this.parser.parse(file.buffer, file.name);
          this.modelManager.addModel(parsed);
        } catch {
          // skip files that fail to parse on restore
        }
      }
      const box = this.modelManager.getBoundingBox();
      this.viewer.fitToBox(box);
      this.setStatus('');
    }

    // Restore camera after fitToBox so it overrides the auto-fit
    if (session?.camera) {
      this.viewer.restoreCameraState(session.camera);
    }
  }

  private async handleFile(file: LoadedFile): Promise<void> {
    try {
      this.showUploadPrompt(false);
      this.setStatus(`Loading ${file.name}...`);

      const parsed = await this.parser.parse(file.buffer, file.name);
      this.modelManager.addModel(parsed);

      const box = this.modelManager.getBoundingBox();
      this.viewer.fitToBox(box);

      // Persist file to IndexedDB if memory is enabled
      if (this.sessionStore.isMemoryEnabled()) {
        await this.sessionStore.saveFile(file.name, file.buffer);
      }

      this.setStatus(`Loaded ${file.name} (${parsed.meshes.length} objects)`);
      setTimeout(() => this.setStatus(''), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.setStatus(`Error: ${msg}`);
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private showUploadPrompt(show: boolean): void {
    const prompt = document.getElementById('upload-prompt');
    if (prompt) prompt.style.display = show ? 'flex' : 'none';
  }

  dispose(): void {
    window.removeEventListener('beforeunload', this.boundBeforeUnload);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.memoryToggle.dispose();
    this.toolbar.dispose();
    this.toolManager.dispose();
    this.modelManager.dispose();
    this.fileLoader.dispose();
    this.parser.dispose();
    this.viewer.dispose();
  }
}
