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
import { KeyboardShortcuts } from '../ui/KeyboardShortcuts';
import { HelpOverlay } from '../ui/HelpOverlay';
import { ContextualActions } from '../ui/ContextualActions';
import { CookieConsent } from '../services/CookieConsent';
import { Analytics } from '../services/Analytics';
import { SessionStore } from '../services/SessionStore';
import { SelectionManager } from '../inspector/SelectionManager';
import { MarqueeSelector } from '../inspector/MarqueeSelector';
import { InspectorPanel } from '../inspector/InspectorPanel';
import { WebIfcPropertyRepository } from '../inspector/repository/WebIfcPropertyRepository';
import type { ModelRecord, ModelSource } from '../services/SessionStore';
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
  private keyboardShortcuts!: KeyboardShortcuts;
  private helpOverlay!: HelpOverlay;
  // Bottom-right floating action tray. Currently hosts the Remove clipping
  // button; future contextual buttons (Remove measurements, Show hidden
  // elements, etc.) will register here. Constructed in start().
  private contextualActions!: ContextualActions;
  private modelRecords = new Map<string, ModelRecord>();
  private bufferCache = new Map<string, ArrayBuffer>();
  // Maps App UUID → web-ifc internal modelID. Populated when a parse
  // succeeds; entries are removed (and the web-ifc model closed) by
  // removeModel / resetView / dispose. Used by the Element Property
  // Repository to issue property queries to web-ifc.
  private modelIdMap = new Map<string, number>();
  private parseQueue = Promise.resolve();
  private statusEl: HTMLElement | null;
  // Element selection (Phase 2 of the Inspector). Owns canvas pointer
  // listeners; defers to active tools and pivot picking via deps.
  private selectionManager!: SelectionManager;
  // Alt-drag marquee selection (window/crossing). Coexists with
  // SelectionManager via capture-phase pointerdown; bails when any tool
  // is active or pivot picking is on.
  private marqueeSelector!: MarqueeSelector;
  // Property repository + panel UI (Phase 3 of the Inspector).
  private propertyRepository!: WebIfcPropertyRepository;
  private inspectorPanel!: InspectorPanel;

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

    // Element selection (Phase 2 — Inspector). Must be constructed after
    // viewer / modelManager / toolManager exist; defers clicks to active
    // tools and pivot picking via those dependencies.
    this.selectionManager = new SelectionManager({
      viewer: this.viewer,
      modelManager: this.modelManager,
      toolManager: this.toolManager,
    });

    // Marquee selection (Alt-drag, window + crossing). Same dependency
    // graph as SelectionManager; coexists via capture-phase pointerdown
    // that only fires when Alt is held and no tool/pivot is active.
    this.marqueeSelector = new MarqueeSelector({
      viewer: this.viewer,
      modelManager: this.modelManager,
      toolManager: this.toolManager,
      selectionManager: this.selectionManager,
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
    this.toolbar.addButton({ name: 'fit', icon: '⊡', title: 'Fit View (F)', onClick: () => this.fitSmart() });
    this.toolbar.addButton({ name: 'transparify', icon: '◻', title: 'Transparify All', disabled: true });
    this.toolbar.addButton({ name: 'reset', icon: '↺', title: 'Reset View', onClick: () => this.resetView() });
    this.toolbar.finalize();

    // Model tree panel
    this.modelTreePanel = new ModelTreePanel(appEl, {
      onVisibilityToggle: (id, visible) => {
        this.modelManager.setVisible(id, visible);
      },
      onRemoveModel: (id) => {
        // Drop selection bookkeeping BEFORE ModelManager disposes the meshes,
        // so SelectionManager doesn't try to restore materials on dead meshes.
        this.selectionManager.onModelRemoved(id);
        // Free memoized properties for this model before the web-ifc model is closed.
        if (this.propertyRepository) this.propertyRepository.disposeModel(id);
        this.closeWebIfcModel(id);
        this.modelManager.removeModel(id);
        this.modelTreePanel.removeModel(id);
        const record = this.modelRecords.get(id);
        this.modelRecords.delete(id);
        this.bufferCache.delete(id);
        if (record) this.sessionStore.removeModel(record.id);
        this.scheduleSave();
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
        // Flush all in-memory buffers to IndexedDB
        for (const [id, buffer] of this.bufferCache) {
          const record = this.modelRecords.get(id);
          if (record) {
            await this.sessionStore.saveModel(id, record.name, buffer);
            record.hasCachedBuffer = true;
          }
        }
        this.scheduleSave();
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
    this.keyboardShortcuts = new KeyboardShortcuts();

    this.keyboardShortcuts.register({
      key: 'c',
      label: 'Section Cut',
      action: () => {
        if (this.toolManager.isActive('clipping')) {
          const tool = this.toolManager.getActiveTool() as ClippingTool;
          tool.enterPlacingMode();
        } else {
          this.toolManager.activate('clipping');
        }
      },
    });

    this.keyboardShortcuts.register({
      key: 'm',
      label: 'Measure',
      action: () => {
        if (!this.toolManager.isActive('measurement')) {
          this.toolManager.activate('measurement');
        }
      },
    });

    this.keyboardShortcuts.register({
      key: 'v',
      label: 'Pick Pivot',
      action: () => this.viewer.togglePivotPicking(),
    });

    this.keyboardShortcuts.register({
      key: 'f',
      label: 'Fit View',
      action: () => this.fitSmart(),
    });

    this.keyboardShortcuts.register({
      key: 'Escape',
      label: 'Cancel',
      action: () => {
        if (this.viewer.isPivotPicking()) {
          this.viewer.cancelPivotPicking();
        } else if (this.toolManager.getActiveTool() !== null) {
          this.toolManager.abort();
        } else {
          // No tool active, no pivot picking: clear the inspector selection.
          this.selectionManager.clear();
        }
      },
    });

    // Help overlay — ? button at top-left, also toggled by ? key
    const appEl = document.getElementById('app')!;
    this.helpOverlay = new HelpOverlay(appEl, this.keyboardShortcuts);

    this.keyboardShortcuts.register({
      key: '?',
      label: 'Help',
      action: () => this.helpOverlay.toggle(),
    });
  }

  async start(): Promise<void> {
    this.setStatus('Initializing IFC engine...');
    await this.parser.init();
    this.setStatus('');

    // Construct the property repository + inspector panel here (Phase 3):
    // both depend on `parser.api` being initialized. The panel subscribes
    // to selectionManager.onChange itself in its constructor.
    const api = this.parser.api;
    if (api) {
      this.propertyRepository = new WebIfcPropertyRepository(
        // PropertyApi is a structural subset of web-ifc's IfcAPI.
        api as unknown as ConstructorParameters<typeof WebIfcPropertyRepository>[0],
        (id: string) => this.modelIdMap.get(id),
        (work) => {
          // Chain property fetches onto the parse queue so they don't
          // race against an in-flight parse on the same web-ifc model.
          const chained = this.parseQueue.then(() => work());
          this.parseQueue = chained.then(
            () => undefined,
            () => undefined,
          );
          return chained;
        },
      );
      const appEl = document.getElementById('app')!;
      this.inspectorPanel = new InspectorPanel(
        appEl,
        {
          repository: this.propertyRepository,
          getModelInfo: (modelId: string) => {
            const record = this.modelRecords.get(modelId);
            return record ? { name: record.name } : undefined;
          },
          getModelCount: () => this.modelRecords.size,
        },
        this.selectionManager,
      );
    }

    // Contextual action tray (bottom-right). Currently hosts the Remove
    // clipping button; future contextual buttons plug in by calling
    // contextualActions.register(...). Disposed BEFORE clippingTool in
    // App.dispose so the tray unsubscribes from a still-live event source.
    const contextualParent = document.getElementById('app')!;
    this.contextualActions = new ContextualActions(contextualParent);
    this.contextualActions.register({
      id: 'remove-clipping',
      label: 'Remove clipping',
      icon: '✂', // ✂
      isVisible: () => this.clippingTool.hasClipPlane(),
      onClick: () => this.clippingTool.clearClipPlane(),
      subscribe: (refresh) => this.clippingTool.onStateChange(refresh),
    });

    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input') as HTMLInputElement | null;

    if (dropZone) this.fileLoader.setupDropZone(dropZone);
    if (fileInput) this.fileLoader.setupFileInput(fileInput);

    this.fileLoader.onLoad((file) => this.enqueueLoad(file));

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
        models: Array.from(this.modelRecords.values()),
      });
    }
  };

  private scheduleSave(): void {
    if (!this.sessionStore.isMemoryEnabled()) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.sessionStore.isMemoryEnabled()) return;
      this.sessionStore.saveSession({
        camera: this.viewer.getCameraState(),
        models: Array.from(this.modelRecords.values()),
      });
    }, 1000);
  }

  private async restoreSession(): Promise<void> {
    const session = this.sessionStore.getSession();

    // Determine which models to restore from session state
    const records = session?.models ?? [];

    // Fallback for v1 sessions that only have fileNames
    if (records.length === 0 && session?.fileNames?.length) {
      const allModels = await this.sessionStore.getAllModels();
      const nameSet = new Set(session.fileNames);
      const fallbackModels = allModels.filter(m => nameSet.has(m.name));
      if (fallbackModels.length > 0) {
        this.showUploadPrompt(false);
        for (const stored of fallbackModels) {
          try {
            this.setStatus(`Restoring ${stored.name}...`);
            const id = stored.id;
            const parsed = await this.parser.parse(stored.buffer, id);
            this.modelManager.addModel(parsed);
            this.modelIdMap.set(id, parsed.modelID);
            this.modelTreePanel.addModel(parsed.id, stored.name, parsed.meshes.length);
            this.bufferCache.set(id, stored.buffer);
            this.modelRecords.set(id, {
              id,
              name: stored.name,
              source: { type: 'local', fileName: stored.name },
              addedAt: Date.now(),
              sizeBytes: stored.buffer.byteLength,
              hasCachedBuffer: true,
            });
          } catch {
            // skip files that fail to parse on restore
          }
        }
        const box = this.modelManager.getBoundingBox();
        this.viewer.fitToBox(box);
        this.setStatus('');
      }
    } else if (records.length > 0) {
      this.showUploadPrompt(false);
      // Pre-fetch all stored models for fallback name-based lookup
      const allStored = await this.sessionStore.getAllModels();
      for (const record of records) {
        try {
          this.setStatus(`Restoring ${record.name}...`);
          let stored = await this.sessionStore.getModel(record.id);

          // Fallback: UUID mismatch (e.g. after migration) — find by name
          if (!stored) {
            const byName = allStored.find(m => m.name === record.name);
            if (byName) {
              console.warn(`SessionStore: UUID miss for "${record.name}", found by name`);
              stored = byName;
            }
          }

          if (stored) {
            // Buffer available in IndexedDB — parse and add
            const parsed = await this.parser.parse(stored.buffer, record.id);
            this.modelManager.addModel(parsed);
            this.modelIdMap.set(record.id, parsed.modelID);
            this.modelTreePanel.addModel(parsed.id, record.name, parsed.meshes.length);
            this.bufferCache.set(record.id, stored.buffer);
            this.modelRecords.set(record.id, { ...record, hasCachedBuffer: true });
            // Fix the IndexedDB key to match the session UUID
            if (stored.id !== record.id) {
              await this.sessionStore.removeModel(stored.id);
              await this.sessionStore.saveModel(record.id, record.name, stored.buffer);
            }
          } else if (record.source.type === 'remote') {
            // No cached buffer — re-fetch from URL
            this.modelRecords.set(record.id, { ...record, hasCachedBuffer: false });
            try {
              await this.handleRemoteLoad(record.source.url);
              // handleRemoteLoad creates its own record, remove the placeholder
              this.modelRecords.delete(record.id);
            } catch {
              this.modelTreePanel.addModel(record.id, record.name, 0, 'remote');
              this.modelTreePanel.setModelWarning(record.id, 'Failed to fetch — click to retry');
            }
          } else {
            // Local model with missing buffer — show warning
            console.warn(`SessionStore: no buffer for local model "${record.name}" (id: ${record.id})`);
            this.modelRecords.set(record.id, { ...record, hasCachedBuffer: false });
            this.modelTreePanel.addModel(record.id, record.name, 0, 'local');
            this.modelTreePanel.setModelWarning(record.id, 'File missing — re-upload to restore');
          }
        } catch {
          // skip models that fail to restore
        }
      }
      const box = this.modelManager.getBoundingBox();
      if (!box.isEmpty()) this.viewer.fitToBox(box);
      this.setStatus('');
    }

    // Restore camera after fitToBox so it overrides the auto-fit
    if (session?.camera) {
      this.viewer.restoreCameraState(session.camera);
    }
  }

  private enqueueLoad(file: LoadedFile, source?: ModelSource): void {
    this.parseQueue = this.parseQueue
      .then(() => this.handleFile(file, source))
      .catch(() => {}); // errors handled inside handleFile
  }

  private async handleFile(file: LoadedFile, source?: ModelSource): Promise<void> {
    try {
      // Reject duplicate filenames
      for (const existing of this.modelRecords.values()) {
        if (existing.name === file.name) {
          this.setStatus(`${file.name} is already loaded`);
          setTimeout(() => this.setStatus(''), 3000);
          return;
        }
      }

      this.showUploadPrompt(false);
      this.setStatus(`Loading ${file.name}...`);

      const id = crypto.randomUUID();
      const parsed = await this.parser.parse(file.buffer, id);
      this.modelManager.addModel(parsed);
      this.modelIdMap.set(id, parsed.modelID);

      const modelSource: ModelSource = source ?? { type: 'local', fileName: file.name };
      const record: ModelRecord = {
        id,
        name: file.name,
        source: modelSource,
        addedAt: Date.now(),
        sizeBytes: file.buffer.byteLength,
        hasCachedBuffer: true,
      };

      this.modelRecords.set(id, record);
      this.bufferCache.set(id, file.buffer);
      this.modelTreePanel.addModel(
        parsed.id, file.name, parsed.meshes.length,
        modelSource.type,
      );

      const box = this.modelManager.getBoundingBox();
      this.viewer.fitToBox(box);

      // Persist to IndexedDB if memory is enabled
      if (this.sessionStore.isMemoryEnabled()) {
        await this.sessionStore.saveModel(id, file.name, file.buffer);
        // Force an immediate session save (not debounced) so the record
        // is in localStorage even if the user refreshes right away
        this.sessionStore.saveSession({
          camera: this.viewer.getCameraState(),
          models: Array.from(this.modelRecords.values()),
        });
      }

      this.setStatus(`Loaded ${file.name} (${parsed.meshes.length} objects)`);
      setTimeout(() => this.setStatus(''), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.setStatus(`Error: ${msg}`);
    }
  }

  private fitSmart(): void {
    // Future: if selection exists, fly to selection bounding box
    const box = this.modelManager.getBoundingBox();
    this.viewer.flyToBox(box);
  }

  private async resetView(): Promise<void> {
    // Tear down all view state
    this.toolManager.abort();
    this.clippingTool.clearClipPlane();
    this.measurementTool.clearMeasurements();
    this.viewer.clearPivot();
    // Clear inspector selection before disposing meshes — keeps the highlight
    // bookkeeping from referencing materials we're about to dispose.
    this.selectionManager.clear();

    // Remove all models and UI rows
    for (const id of this.modelManager.getModelIds()) {
      if (this.propertyRepository) this.propertyRepository.disposeModel(id);
      this.closeWebIfcModel(id);
      this.modelManager.removeModel(id);
      this.modelTreePanel.removeModel(id);
    }

    // Re-parse and re-add every loaded model from buffer cache.
    // modelIdMap is rebuilt as re-parses complete (old IDs were cleared above).
    for (const [id, record] of this.modelRecords) {
      const buffer = this.bufferCache.get(id);
      if (!buffer) continue;
      try {
        this.setStatus(`Reloading ${record.name}...`);
        const parsed = await this.parser.parse(buffer, id);
        this.modelManager.addModel(parsed);
        this.modelIdMap.set(id, parsed.modelID);
        this.modelTreePanel.addModel(parsed.id, record.name, parsed.meshes.length, record.source.type);
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
      const source: ModelSource = { type: 'remote', url, fileName: result.file.name };
      await this.handleFile(result.file, source);
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
    this.helpOverlay.dispose();
    this.keyboardShortcuts.dispose();
    this.toolbar.dispose();
    this.modelTreePanel.dispose();
    if (this.inspectorPanel) this.inspectorPanel.dispose();
    this.marqueeSelector.dispose();
    this.selectionManager.dispose();
    // contextualActions must dispose BEFORE toolManager so the tray can
    // unsubscribe from a live ClippingTool source. (toolManager.dispose
    // calls clippingTool.dispose, which clears its listener array.) The
    // field is initialized in start(), so guard for early-dispose paths.
    if (this.contextualActions) this.contextualActions.dispose();
    this.toolManager.dispose();
    this.modelManager.dispose();
    this.fileLoader.dispose();
    // Close every still-open web-ifc model before the parser disposes its WASM heap
    for (const id of Array.from(this.modelIdMap.keys())) {
      this.closeWebIfcModel(id);
    }
    this.parser.dispose();
    this.viewer.dispose();
  }

  /**
   * Close the web-ifc model corresponding to the given App UUID and drop
   * the entry from modelIdMap. Safe to call when no entry exists (no-op).
   * Errors from CloseModel are swallowed — the WASM may already be down
   * (e.g. dispose during teardown), and an upstream caller cannot recover.
   */
  private closeWebIfcModel(id: string): void {
    const webIfcId = this.modelIdMap.get(id);
    if (webIfcId === undefined) return;
    this.modelIdMap.delete(id);
    try {
      this.parser.api?.CloseModel(webIfcId);
    } catch {
      // ignore — web-ifc may already be disposed
    }
  }

  /** Test/inspector hook: snapshot of the current App UUID → web-ifc modelID map. */
  getModelIdMap(): ReadonlyMap<string, number> {
    return this.modelIdMap;
  }
}
