import { Viewer } from '../viewer/Viewer';
import { ModelManager } from '../viewer/ModelManager';
import { FileLoader } from '../loader/FileLoader';
import { IfcParser } from '../parser/IfcParser';
import { UrlInput } from '../ui/UrlInput';
import { RemoteLoader } from '../loader/RemoteLoader';
import { ToolManager } from '../tools/Tool';
import { ClippingTool } from '../tools/ClippingTool';
import { MeasurementTool } from '../tools/MeasurementTool';
import { Toolbar } from '../ui/Toolbar';
import { ModelTreePanel } from '../ui/ModelTreePanel';
import { MemoryToggle } from '../ui/MemoryToggle';
import { Footer } from '../ui/Footer';
import { CookieBanner } from '../ui/CookieBanner';
import { CookieConsent } from '../services/CookieConsent';
import { Analytics } from '../services/Analytics';
import { SessionStore } from '../services/SessionStore';
import type { LoadedFile } from '../loader/FileLoader';

export class App {
  private viewer: Viewer;
  private modelManager: ModelManager;
  private fileLoader: FileLoader;
  private parser: IfcParser;
  private toolManager: ToolManager;
  private toolbar: Toolbar;
  private modelTreePanel: ModelTreePanel;
  private sessionStore: SessionStore;
  private memoryToggle: MemoryToggle;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private clippingTool: ClippingTool;
  private measurementTool: MeasurementTool;
  private footer: Footer;
  private cookieBanner: CookieBanner;
  private urlInput: UrlInput;
  private remoteLoader: RemoteLoader;
  private loadedFiles = new Map<string, ArrayBuffer>();
  private statusEl: HTMLElement | null;

  constructor(canvas: HTMLCanvasElement) {
    this.viewer = new Viewer(canvas);
    this.modelManager = new ModelManager(this.viewer.getScene());
    this.fileLoader = new FileLoader();
    this.parser = new IfcParser();
    this.statusEl = document.getElementById('status');

    // Tools
    this.toolManager = new ToolManager();

    this.clippingTool = new ClippingTool({
      renderer: this.viewer.getRenderer(),
      scene: this.viewer.getScene(),
      camera: this.viewer.getCamera(),
      canvas: this.viewer.getCanvas(),
    });
    this.toolManager.register(this.clippingTool);

    this.measurementTool = new MeasurementTool({
      renderer: this.viewer.getRenderer(),
      scene: this.viewer.getScene(),
      camera: this.viewer.getCamera(),
      canvas: this.viewer.getCanvas(),
    });
    this.toolManager.register(this.measurementTool);

    // Keep clipping handle and measurement markers at constant screen size
    this.viewer.onUpdate(() => {
      this.clippingTool.update();
      this.measurementTool.update();
    });

    // Toolbar UI
    const appEl = document.getElementById('app')!;
    this.toolbar = new Toolbar(appEl, this.toolManager);
    this.toolbar.addButton({
      name: 'clipping',
      icon: '✂',
      title: 'Section Cut (C)',
      onReactivate: () => this.clippingTool.enterPlacingMode(),
    });
    this.toolbar.addButton({
      name: 'measurement',
      icon: '📏',
      title: 'Measure (M)',
    });
    this.toolbar.addButton({ name: 'transparify', icon: '◻', title: 'Transparify All', disabled: true });
    this.toolbar.addButton({ name: 'reset', icon: '↺', title: 'Reset View', onClick: () => this.resetView() });
    this.toolbar.finalize();

    // Model tree panel
    this.modelTreePanel = new ModelTreePanel(appEl, {
      onVisibilityToggle: (id, visible) => {
        this.modelManager.setVisible(id, visible);
      },
      onRemoveModel: (id) => {
        this.modelManager.removeModel(id);
        this.modelTreePanel.removeModel(id);
      },
      onAddModel: () => {
        const fileInput = document.getElementById('file-input') as HTMLInputElement | null;
        if (fileInput) fileInput.click();
      },
      onAddRemoteModel: () => {
        const url = window.prompt('Enter URL to a remote .ifc file:');
        if (url) this.loadFromUrl(url);
      },
    });

    // Session persistence
    this.sessionStore = new SessionStore();
    this.memoryToggle = new MemoryToggle(appEl, this.sessionStore);
    this.memoryToggle.onChange(async (enabled) => {
      if (enabled) {
        // Flush all in-memory files to IndexedDB
        for (const [name, buffer] of this.loadedFiles) {
          await this.sessionStore.saveFile(name, buffer);
        }
      } else {
        if (this.saveTimer) {
          clearTimeout(this.saveTimer);
          this.saveTimer = null;
        }
      }
    });

    // Remote loader
    this.remoteLoader = new RemoteLoader();

    // URL input for remote loading
    const urlMount = document.getElementById('url-input-mount')!;
    this.urlInput = new UrlInput(urlMount);
    this.urlInput.onSubmit((event) => this.handleRemoteLoad(event.normalizedUrl));
    this.urlInput.onTokenRetry((url, token) => this.handleRemoteLoad(url, token));

    // Footer branding + cookie consent
    const footerEl = document.getElementById('app-footer')!;
    this.footer = new Footer(footerEl);
    this.cookieBanner = new CookieBanner(footerEl);
    this.cookieBanner.onAccept(() => Analytics.load());
    if (CookieConsent.getStatus() === 'accepted') {
      Analytics.load();
    }

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
          this.modelTreePanel.addModel(parsed.id, file.name, parsed.meshes.length);
          this.loadedFiles.set(file.name, file.buffer);
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
      this.modelTreePanel.addModel(parsed.id, file.name, parsed.meshes.length);
      this.loadedFiles.set(file.name, file.buffer);

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

  private async resetView(): Promise<void> {
    // Tear down all view state
    this.toolManager.abort();
    this.clippingTool.clearClipPlane();
    this.measurementTool.clearMeasurements();
    this.viewer.clearPivot();

    // Remove all models and UI rows
    for (const id of this.modelManager.getModelIds()) {
      this.modelManager.removeModel(id);
      this.modelTreePanel.removeModel(id);
    }

    // Re-parse and re-add every loaded file from memory
    for (const [name, buffer] of this.loadedFiles) {
      try {
        this.setStatus(`Reloading ${name}...`);
        const parsed = await this.parser.parse(buffer, name);
        this.modelManager.addModel(parsed);
        this.modelTreePanel.addModel(parsed.id, name, parsed.meshes.length);
      } catch {
        // skip files that fail to re-parse
      }
    }

    const box = this.modelManager.getBoundingBox();
    this.viewer.fitToBox(box);
    this.setStatus('');
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private showUploadPrompt(show: boolean): void {
    const prompt = document.getElementById('upload-prompt');
    if (prompt) prompt.style.display = show ? 'flex' : 'none';
  }

  async loadFromUrl(url: string): Promise<void> {
    const { normalizeUrl } = await import('../loader/urlNormalizer');
    const { url: normalized } = normalizeUrl(url);
    await this.handleRemoteLoad(normalized);
  }

  private async handleRemoteLoad(url: string, token?: string): Promise<void> {
    // Extract filename for the loading row
    let name = 'model.ifc';
    try {
      const pathname = new URL(url).pathname;
      name = decodeURIComponent(pathname.split('/').pop() || 'model.ifc');
    } catch { /* use default */ }

    const loadingId = `loading-${Date.now()}`;
    this.showUploadPrompt(false);
    this.modelTreePanel.addLoadingModel(loadingId, name);

    const result = await this.remoteLoader.fetch(url, token, (loaded, total) => {
      this.modelTreePanel.updateLoadingProgress(loadingId, loaded, total);
    });

    this.modelTreePanel.removeLoadingModel(loadingId);

    if (result.status === 'ok' && result.file) {
      this.urlInput.clearInput();
      await this.handleFile(result.file);
      return;
    }

    if (result.status === 'auth') {
      this.urlInput.showAuthPrompt(url);
      return;
    }

    this.urlInput.showMessage(result.message, 'error');
  }

  dispose(): void {
    window.removeEventListener('beforeunload', this.boundBeforeUnload);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.cookieBanner.dispose();
    this.footer.dispose();
    this.memoryToggle.dispose();
    this.urlInput.dispose();
    this.toolbar.dispose();
    this.modelTreePanel.dispose();
    this.toolManager.dispose();
    this.modelManager.dispose();
    this.fileLoader.dispose();
    this.parser.dispose();
    this.viewer.dispose();
  }
}
