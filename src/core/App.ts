import * as THREE from 'three';
import { Viewer } from '../viewer/Viewer';
import { ModelManager } from '../viewer/ModelManager';
import { AppearanceManager } from '../viewer/AppearanceManager';
import { FileLoader } from '../loader/FileLoader';
import { WorkerIfcParser } from '../parser/WorkerIfcParser';
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
import { HistoryShortcuts } from '../ui/HistoryShortcuts';
import { HistoryManager } from './history/HistoryManager';
import { HelpOverlay } from '../ui/HelpOverlay';
import { ContextualActions } from '../ui/ContextualActions';
import { CookieConsent } from '../services/CookieConsent';
import { Analytics } from '../services/Analytics';
import { SessionStore } from '../services/SessionStore';
import { GeometryCache, sha256Hex } from '../services/GeometryCache';
import { SelectionManager } from '../inspector/SelectionManager';
import { MarqueeSelector } from '../inspector/MarqueeSelector';
import { InspectorPanel } from '../inspector/InspectorPanel';
import { SelectionBasket } from '../inspector/SelectionBasket';
import { SelectionBasketPanel } from '../ui/SelectionBasketPanel';
import { WorkerPropertyRepository } from '../inspector/repository/WorkerPropertyRepository';
import { ContextMenu } from '../ui/ContextMenu';
import { buildContextMenuItems, shouldSuppressContextMenu } from '../ui/contextMenuItems';
import { BulkRequestCancelled } from '../inspector/repository/ElementPropertyRepository';
import {
  categoryQuery,
  describeSimilarResult,
  identitiesFromIds,
  sharedSource,
  typeQuery,
  type SimilarQuery,
} from '../inspector/selectSimilar';
import { SIMILAR_MENU_ENRICH_MAX } from '../inspector/limits';
import type { SelectionState } from '../inspector/types';
import type { ModelRecord, ModelSource, SessionState } from '../services/SessionStore';
import type { LoadedFile } from '../loader/FileLoader';

/** How long a transient status message stays up before clearing. */
const STATUS_CLEAR_MS = 4000;

export class App {
  private viewer: Viewer;
  private modelManager: ModelManager;
  private fileLoader: FileLoader;
  // IFC parsing runs in a Web Worker (see ifcWorker.ts). `parser` is the
  // main-thread proxy; it owns the Worker. All web-ifc state — geometry
  // AND property queries — lives in the worker, so the main thread never
  // blocks during a load.
  private parser: WorkerIfcParser;
  private toolManager: ToolManager;
  private toolbar: Toolbar;
  private modelTreePanel: ModelTreePanel;
  private sessionStore: SessionStore;
  private geometryCache: GeometryCache;
  private memoryToggle: MemoryToggle;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private clippingTool: ClippingTool;
  private measurementTool: MeasurementTool;
  private footer: Footer;
  private cookieBanner: CookieBanner;
  private urlInput: UrlInput;
  private remoteLoader: RemoteLoader;
  private keyboardShortcuts!: KeyboardShortcuts;
  // Undo/redo: a single HistoryManager owns the stacks; the SelectionManager
  // and SelectionBasket push commands into it. HistoryShortcuts wires the
  // Ctrl/Cmd+Z / +Y / +Shift+Z chords (separate from KeyboardShortcuts, which
  // only maps single keys). history.clear() runs on any model add/remove (U2).
  private history: HistoryManager;
  private historyShortcuts!: HistoryShortcuts;
  private helpOverlay!: HelpOverlay;
  // Bottom-right floating action tray. Currently hosts the Remove clipping
  // button; future contextual buttons (Remove measurements, Show hidden
  // elements, etc.) will register here. Constructed in start().
  private contextualActions!: ContextualActions;
  private modelRecords = new Map<string, ModelRecord>();
  private bufferCache = new Map<string, ArrayBuffer>();
  // Serializes `handleFile` calls so two files dropped at once don't
  // interleave their main-thread bookkeeping (modelRecords, sessionStore
  // writes). The web-ifc parse itself is serialized inside the worker;
  // this chain only orders the App-level work around it.
  private loadChain = Promise.resolve();
  private statusEl: HTMLElement | null;
  // Element selection (Phase 2 of the Inspector). Owns canvas pointer
  // listeners; defers to active tools and pivot picking via deps.
  private selectionManager!: SelectionManager;
  // Alt-drag marquee selection (window/crossing). Coexists with
  // SelectionManager via capture-phase pointerdown; bails when any tool
  // is active or pivot picking is on.
  private marqueeSelector!: MarqueeSelector;
  // Element appearance (hide / isolate / show-all + transparent / opaque).
  // Per-element overrides driven from the context menu + the contextual tray,
  // made reversible by the shared HistoryManager. Constructed in the App
  // constructor alongside SelectionManager so both share the pristine store.
  private appearanceManager!: AppearanceManager;
  // Write-once-per-mesh pristine-material store, SHARED by AppearanceManager
  // and SelectionManager. Whichever subsystem touches a mesh first records its
  // true load-time material here; both then derive their effects from this
  // pristine base, which makes the highlight ↔ appearance reconciliation
  // order-independent (precedence: hidden > transparent > highlighted > base).
  private pristineMaterials = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
  // Generic right-click menu (selection-scoped; no raycast). Constructed in
  // start(); items built from the current selection + appearance flags.
  private contextMenu!: ContextMenu;
  private boundOnContextMenu!: (e: MouseEvent) => void;
  // Property repository + panel UI (Phase 3 of the Inspector). The
  // repository proxies property queries to the same worker `parser` owns.
  private propertyRepository!: WorkerPropertyRepository;
  private inspectorPanel!: InspectorPanel;
  // Selection Basket (Data Insight feature 1). The basket is the model
  // (constructed eagerly so restore can rehydrate it); the panel + tray
  // button are wired in start(). The 4 calculator actions (M+/M−/MR/MC)
  // bridge the basket to the SelectionManager. Persisted in the session.
  private selectionBasket: SelectionBasket;
  private selectionBasketPanel!: SelectionBasketPanel;

  constructor(canvas: HTMLCanvasElement) {
    this.viewer = new Viewer(canvas);
    // Shared render-on-demand hook. Every module that mutates visible
    // scene state without moving the camera (model add/remove, tool
    // mutations, highlight changes) receives this callback so the viewer
    // renders the next frame instead of sitting idle.
    const requestRender = (): void => this.viewer.requestRender();
    this.modelManager = new ModelManager(this.viewer.getScene(), requestRender);
    this.fileLoader = new FileLoader();
    this.parser = new WorkerIfcParser();
    this.statusEl = document.getElementById('status');

    // Tools
    this.toolManager = new ToolManager();

    this.clippingTool = new ClippingTool({
      renderer: this.viewer.getRenderer(),
      scene: this.viewer.getScene(),
      camera: this.viewer.getCamera(),
      canvas: this.viewer.getCanvas(),
      requestRender,
    });
    this.toolManager.register(this.clippingTool);

    this.measurementTool = new MeasurementTool({
      renderer: this.viewer.getRenderer(),
      scene: this.viewer.getScene(),
      camera: this.viewer.getCamera(),
      canvas: this.viewer.getCanvas(),
      requestRender,
    });
    this.toolManager.register(this.measurementTool);

    // Keep clipping handle and measurement markers at constant screen size
    this.viewer.onUpdate(() => {
      this.clippingTool.update();
      this.measurementTool.update();
    });

    // Undo/redo history. The single owner of the undo/redo stacks; injected
    // into the SelectionManager and SelectionBasket so each pushes one command
    // per user gesture. Constructed before those consumers.
    this.history = new HistoryManager();

    // Shared pristine-material accessor: write-once per mesh so the first
    // subsystem to touch a mesh records its load-time material. Both the
    // appearance and selection systems derive their effects from this base.
    const pristineFor = (mesh: THREE.Mesh): THREE.Material | THREE.Material[] => {
      let p = this.pristineMaterials.get(mesh);
      if (!p) {
        p = mesh.material;
        this.pristineMaterials.set(mesh, p);
      }
      return p;
    };

    // Element appearance. Constructed before SelectionManager so the latter's
    // appearanceBaseFor provider can reach it. Shares the HistoryManager (each
    // hide/isolate/show-all/transparent/opaque = one undoable command) and the
    // shared pristine store.
    this.appearanceManager = new AppearanceManager({
      modelManager: this.modelManager,
      requestRender,
      history: this.history,
      pristineFor,
    });

    // Element selection (Phase 2 — Inspector). Must be constructed after
    // viewer / modelManager / toolManager exist; defers clicks to active
    // tools and pivot picking via those dependencies. The appearanceBaseFor
    // provider lets the highlight compose on top of the appearance base
    // (transparent clone or pristine original) rather than capturing a stale
    // material — see AppearanceManager / SelectionManager.refreshHighlights.
    this.selectionManager = new SelectionManager({
      viewer: this.viewer,
      modelManager: this.modelManager,
      toolManager: this.toolManager,
      history: this.history,
      appearanceBaseFor: (mesh) => this.appearanceManager.getBaseForMesh(mesh, pristineFor(mesh)),
    });

    // Orbiting over empty space with something selected almost always means
    // "turn around that", so give the viewer a way to ask where it is.
    this.viewer.setSelectionCenterProvider(() => this.selectionManager.getSelectionCenter());

    // Marquee selection (Alt-drag, window + crossing). Same dependency
    // graph as SelectionManager; coexists via capture-phase pointerdown
    // that only fires when Alt is held and no tool/pivot is active.
    this.marqueeSelector = new MarqueeSelector({
      viewer: this.viewer,
      modelManager: this.modelManager,
      toolManager: this.toolManager,
      selectionManager: this.selectionManager,
    });

    // Selection Basket model (Data Insight feature 1). Constructed eagerly
    // so session restore can rehydrate it once models are back. The panel
    // and the 4 calculator actions are wired in start(). Shares the single
    // HistoryManager so M+/M−/MC are undoable (U3).
    this.selectionBasket = new SelectionBasket(this.history);

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
        // Undo history may hold expressIds of the model we're about to remove;
        // clearing it (U2) is the safe v1 — no stale-id crash on a later undo.
        // Cleared BEFORE the selection/basket prune so those prunes (system
        // changes) don't leave a half-relevant stack behind.
        this.history.clear();
        // Drop selection bookkeeping BEFORE ModelManager disposes the meshes,
        // so SelectionManager doesn't try to restore materials on dead meshes.
        this.selectionManager.onModelRemoved(id);
        // Prune the Selection Basket too — drop any of this model's entries
        // (its onChange triggers a debounced session save). Constructed in
        // the App constructor, so it's always available here.
        this.selectionBasket.onModelRemoved(id);
        // Prune appearance overrides for the removed model (system change,
        // pushes no undo command). Its onChange triggers a debounced save.
        this.appearanceManager.onModelRemoved(id);
        // Free memoized properties AND close the worker's model. The
        // repository's disposeModel posts the `disposeModel` worker
        // message, so we do NOT also call parser.disposeModel here.
        if (this.propertyRepository) {
          this.propertyRepository.disposeModel(id);
        } else {
          // Repository not yet constructed (very early removal) — still
          // close the worker model directly so it isn't leaked.
          this.parser.disposeModel(id);
        }
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
    // Parsed-geometry cache, keyed by SHA-256 of the source .ifc buffer.
    // Used to skip geometry streaming on session restore — the model
    // becomes visible immediately and the worker re-opens the model in
    // the background to refill the web-ifc state the property inspector
    // needs.
    this.geometryCache = new GeometryCache(this.sessionStore);
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

    // Undo/redo chords (Ctrl/Cmd+Z, Ctrl/Cmd+Y, Ctrl/Cmd+Shift+Z). A separate
    // module from KeyboardShortcuts because it needs modifier chords plus a
    // text-input focus guard so native text undo keeps working.
    this.historyShortcuts = new HistoryShortcuts(this.history);

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
    // The IFC engine now lives in a worker — it initializes lazily on the
    // first message, so there is no main-thread init to wait for here.
    this.setStatus('');

    // Construct the property repository + inspector panel (Phase 3). The
    // repository shares the same worker the `parser` owns, so all web-ifc
    // state stays in one place. The panel subscribes to
    // selectionManager.onChange itself in its constructor.
    this.propertyRepository = new WorkerPropertyRepository(this.parser);
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
        onSelectSimilar: (query) => void this.runSelectSimilar(query),
      },
      this.selectionManager,
    );

    // Selection Basket panel (D1) — appears only when the basket is
    // non-empty. The 4 calculator actions bridge the basket to the
    // SelectionManager; M+/M− read the live selection, MR uses the
    // lock-bypassing selectExactly path so recall spans models without
    // touching the single-model-lock preference (D3).
    this.selectionBasketPanel = new SelectionBasketPanel(appEl, {
      basket: this.selectionBasket,
      selection: this.selectionManager,
      onAddSelection: () => this.basketAdd(),
      onRemoveSelection: () => this.basketRemove(),
      onRecall: () => this.basketRecall(),
      onClear: () => this.selectionBasket.clear(),
    });

    // Persist the basket on every content change (debounced via the same
    // scheduleSave path the camera/models use; honours the memory toggle).
    this.selectionBasket.onChange(() => this.scheduleSave());

    // Persist appearance overrides on every change (same debounced path).
    this.appearanceManager.onChange(() => this.scheduleSave());

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

    // Selection Basket (D1) — "Clear basket" in the tray, so the basket can
    // be cleared even when nothing is selected and the user's attention is
    // elsewhere. Same idiom as Remove clipping; visible only when the basket
    // is non-empty.
    this.contextualActions.register({
      id: 'clear-basket',
      label: 'Clear basket',
      icon: '🧺', // 🧺
      isVisible: () => this.selectionBasket.size() > 0,
      onClick: () => this.selectionBasket.clear(),
      subscribe: (refresh) => this.selectionBasket.onChange(refresh),
    });

    // Element appearance recovery (D) — always-available escape hatches so the
    // user is never trapped with invisible or faded geometry. Same idiom as
    // Remove clipping; visible only when the matching state is active.
    this.contextualActions.register({
      id: 'show-hidden',
      label: this.showHiddenLabel(),
      icon: '👁',
      isVisible: () => this.appearanceManager.hasHidden(),
      onClick: () => this.appearanceShowAll(),
      subscribe: (refresh) =>
        this.appearanceManager.onChange(() => {
          this.updateShowHiddenLabel();
          refresh();
        }),
    });
    this.contextualActions.register({
      id: 'clear-transparency',
      label: 'Clear transparency',
      icon: '◐',
      isVisible: () => this.appearanceManager.hasTransparent(),
      onClick: () => this.appearanceClearTransparency(),
      subscribe: (refresh) => this.appearanceManager.onChange(refresh),
    });

    // Right-click context menu (C). Selection-scoped — the handler reads
    // SelectionManager.getState() + appearance flags and builds the items; it
    // NEVER raycasts or mutates the selection (CM2).
    this.contextMenu = new ContextMenu(contextualParent);
    this.boundOnContextMenu = (e) => this.onContextMenu(e);
    this.viewer.getCanvas().addEventListener('contextmenu', this.boundOnContextMenu);

    // Close the menu if the selection clears while it's open (e.g. model
    // removed) — "menus only work for a selection".
    this.selectionManager.onChange(() => {
      if (this.contextMenu.isOpen() && this.selectionManager.getState().kind === 'none') {
        // Only close when there's also nothing to recover; otherwise the menu
        // could legitimately be a recovery-only menu. Simplest safe behaviour:
        // close on any selection-clear while open.
        this.contextMenu.close();
      }
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
      this.sessionStore.saveSession(this.buildSessionState());
    }
  };

  /**
   * Assemble the SessionState snapshot persisted to localStorage. Single
   * home so every save path (debounced, beforeunload, immediate-on-load)
   * carries the same fields — including the Selection Basket (D2).
   */
  private buildSessionState(): SessionState {
    return {
      camera: this.viewer.getCameraState(),
      models: Array.from(this.modelRecords.values()),
      basket: this.selectionBasket.serialize(),
      appearance: this.appearanceManager.serialize(),
    };
  }

  private scheduleSave(): void {
    if (!this.sessionStore.isMemoryEnabled()) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.sessionStore.isMemoryEnabled()) return;
      this.sessionStore.saveSession(this.buildSessionState());
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
            // Stream the parse through the worker. The model fills in
            // progressively; the worker keeps it open for properties.
            this.modelManager.beginStream(id);
            const parsed = await this.parser.parseStreaming(stored.buffer, id, (batch) => {
              this.modelManager.appendMeshes(id, batch);
            });
            this.modelManager.endStream(id);
            this.modelTreePanel.addModel(id, stored.name, parsed.meshes.length);
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
            // skip files that fail to parse on restore — drop a partial stream
            this.modelManager.removeModel(stored.id);
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
            // Buffer is available — try the geometry-cache fast path first.
            // On hit we hydrate the scene from cached typed-array buffers
            // (instant on a 200 MB model) and ask the worker to open the
            // model for properties (no geometry streamed).
            const cachedMeshes = record.hash
              ? await this.geometryCache.load(record.hash)
              : null;
            if (cachedMeshes) {
              this.modelManager.addModel({
                id: record.id,
                meshes: cachedMeshes,
              });
              this.modelTreePanel.addModel(
                record.id, record.name, cachedMeshes.length, record.source.type,
              );
              this.bufferCache.set(record.id, stored.buffer);
              this.modelRecords.set(record.id, { ...record, hasCachedBuffer: true });
              // Open the model in the worker for property queries. A later
              // `getProps` for this id simply queues behind this open in
              // the worker and resolves once the model is ready — the old
              // "properties unavailable" gap is handled by message ordering.
              void this.parser.openForProperties(stored.buffer, record.id).catch((err) => {
                console.warn(`Worker openForProperties failed for ${record.id}:`, err);
              });
            } else {
              // Cache miss — full streamed parse, then backfill the cache
              // so the *next* restore is fast. Backfills also rescue
              // sessions saved before the cache feature shipped (no hash).
              this.modelManager.beginStream(record.id);
              const parsed = await this.parser.parseStreaming(
                stored.buffer, record.id, (batch) => {
                  this.modelManager.appendMeshes(record.id, batch);
                },
              );
              this.modelManager.endStream(record.id);
              this.modelTreePanel.addModel(record.id, record.name, parsed.meshes.length);
              this.bufferCache.set(record.id, stored.buffer);
              const hash = record.hash ?? await sha256Hex(stored.buffer);
              this.modelRecords.set(record.id, { ...record, hasCachedBuffer: true, hash });
              void this.geometryCache.save(hash, parsed.meshes);
            }
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
          // skip models that fail to restore — drop any partial stream
          this.modelManager.removeModel(record.id);
        }
      }
      const box = this.modelManager.getBoundingBox();
      if (!box.isEmpty()) this.viewer.fitToBox(box);
      this.setStatus('');
    }

    // Rehydrate the Selection Basket (D2) AFTER models are restored — its
    // identities only resolve once their models exist. Drop entries whose
    // model didn't restore (e.g. a missing local file). The basket is
    // metadata only (no geometry), so this is cheap and rides in the
    // localStorage session state.
    if (session?.basket?.length) {
      const liveModelIds = new Set(this.modelManager.getModelIds());
      const surviving = session.basket.filter((e) => liveModelIds.has(e.modelId));
      if (surviving.length > 0) {
        this.selectionBasket.deserialize(surviving);
      }
    }

    // Rehydrate appearance overrides (D, A2) AFTER models restore — same
    // rationale as the basket: the entries only apply once their meshes exist.
    // deserialize re-applies the visual effect (hidden/transparent) for live
    // models; entries whose model didn't return are dropped here.
    if (session?.appearance?.length) {
      const liveModelIds = new Set(this.modelManager.getModelIds());
      const surviving = session.appearance.filter((e) => liveModelIds.has(e.modelId));
      if (surviving.length > 0) {
        this.appearanceManager.deserialize(surviving);
      }
    }

    // Restore camera after fitToBox so it overrides the auto-fit
    if (session?.camera) {
      this.viewer.restoreCameraState(session.camera);
    }
  }

  private enqueueLoad(file: LoadedFile, source?: ModelSource): void {
    this.loadChain = this.loadChain
      .then(() => this.handleFile(file, source))
      .catch(() => {}); // errors handled inside handleFile
  }

  private async handleFile(file: LoadedFile, source?: ModelSource): Promise<void> {
    // Tracks an in-progress streamed load so the catch block can drop a
    // partially-built model if the parse fails. Null before the stream
    // starts and once it completes.
    let streamId: string | null = null;
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
      // Hash in parallel with the parse — SHA-256 of 200 MB is a few
      // hundred milliseconds and we don't want it in front of the user.
      const hashPromise = sha256Hex(file.buffer);

      // Stream the parse through the worker: the model's group goes into
      // the scene now and geometry fills in batch by batch as the worker
      // posts it, so a large model materializes progressively while the
      // main thread stays at 60 fps.
      this.modelManager.beginStream(id);
      streamId = id;
      let totalElements = 0;
      let framed = false;
      const parsed = await this.parser.parseStreaming(file.buffer, id, (batch, progress) => {
        this.modelManager.appendMeshes(id, batch);
        totalElements = progress.total;
        this.setStatus(
          `Loading ${file.name}… ` +
          `(${progress.loaded.toLocaleString()} / ${progress.total.toLocaleString()} elements)`,
        );
        // Fit once, on the first batch, so the camera frames the model
        // early and the progressive fill is actually visible. We do NOT
        // re-fit at the end: the load is interactive now, and a late fit
        // would yank a camera the user may already be orbiting.
        if (!framed) {
          framed = true;
          this.viewer.fitToBox(this.modelManager.getBoundingBox());
        }
      });
      this.modelManager.endStream(id);
      streamId = null;
      const hash = await hashPromise;

      const modelSource: ModelSource = source ?? { type: 'local', fileName: file.name };
      const record: ModelRecord = {
        id,
        name: file.name,
        source: modelSource,
        addedAt: Date.now(),
        sizeBytes: file.buffer.byteLength,
        hasCachedBuffer: true,
        hash,
      };

      this.modelRecords.set(id, record);
      this.bufferCache.set(id, file.buffer);
      // Adding a model invalidates undo history references (U2) — clear it so
      // a pre-existing selection-undo can't restore against the new geometry.
      this.history.clear();
      this.modelTreePanel.addModel(
        id, file.name, parsed.meshes.length,
        modelSource.type,
      );

      // Persist to IndexedDB if memory is enabled
      if (this.sessionStore.isMemoryEnabled()) {
        await this.sessionStore.saveModel(id, file.name, file.buffer);
        // Force an immediate session save (not debounced) so the record
        // is in localStorage even if the user refreshes right away
        this.sessionStore.saveSession(this.buildSessionState());
        // Fire-and-forget geometry-cache write. Runs after the scene is
        // up so the user-perceived parse time is unaffected; a failed
        // write just means the next restore falls back to a full parse.
        void this.geometryCache.save(hash, parsed.meshes);
      }

      this.setStatus(`Loaded ${file.name} (${totalElements.toLocaleString()} elements)`);
      setTimeout(() => this.setStatus(''), 3000);
    } catch (err) {
      // A streamed load that failed partway leaves an empty/partial model
      // and an open stream — drop both (removeModel also clears the stream).
      if (streamId) this.modelManager.removeModel(streamId);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.setStatus(`Error: ${msg}`);
    }
  }

  // ── Selection Basket actions (M+ / M− / MR) ───────────────
  //
  // The four calculator keys, all driven by the basket panel: M+ (add live
  // selection), M− (remove live selection), MR (recall — select the basket's
  // contents), MC (clear, wired inline to `selectionBasket.clear()`). M+/M−
  // read the current SelectionManager state; an empty selection is a no-op
  // (the panel disables the buttons, but we guard here too).

  /** M+ — add the current live selection to the basket. */
  private basketAdd(): void {
    const state = this.selectionManager.getState();
    if (state.kind === 'none') return;
    this.selectionBasket.add(state.identities);
  }

  /** M− — remove the current live selection from the basket. */
  private basketRemove(): void {
    const state = this.selectionManager.getState();
    if (state.kind === 'none') return;
    this.selectionBasket.remove(state.identities);
  }

  /**
   * MR — recall: select the basket's contents (highlight them). Uses the
   * lock-bypassing `selectExactly` path so a multi-model basket recalls
   * across all its models WITHOUT mutating the single-model-lock preference
   * (D3). No-op on an empty basket.
   */
  private basketRecall(): void {
    const contents = this.selectionBasket.getContents();
    if (contents.length === 0) return;
    this.selectionManager.selectExactly(contents);
  }

  // ── Select similar (F) ─────────────────────────────────────

  /**
   * Run a "select similar" query and make its result the selection.
   *
   * The predicate runs in the worker (`findMatching`) or, for the class
   * preset, is just an id enumeration — either way only ids cross the thread
   * boundary, so a class with tens of thousands of members costs a small
   * message rather than a property dump. The result lands through
   * `selectExactly`, which bypasses the single-model lock and records ONE
   * undo command for the whole set.
   *
   * See dev/plans/handoff-select-similar.md.
   */
  private async runSelectSimilar(query: SimilarQuery): Promise<void> {
    // A previous query (or an inspector intersection) still running would
    // sit ahead of this one in the worker's serial queue.
    this.propertyRepository.cancelBulk();
    this.setStatus(`Finding ${query.label}…`);

    try {
      const ids =
        query.kind === 'class'
          ? await this.propertyRepository.enumerateExpressIds(query.modelId, query.ifcTypeCode)
          : await this.propertyRepository.findMatching(
              query.modelId,
              query.ifcTypeCode,
              query.selector,
              query.value,
              (done, total) => this.setStatus(`Finding ${query.label}… ${done} / ${total}`),
            );

      const identities = identitiesFromIds(query, ids);
      if (identities.length > 0) {
        this.selectionManager.selectExactly(identities);
      }
      this.setStatus(describeSimilarResult(query, identities.length));
      window.setTimeout(() => this.setStatus(''), STATUS_CLEAR_MS);
    } catch (err) {
      // Superseded by a newer query — the user moved on, not an error.
      if (err instanceof BulkRequestCancelled) return;
      console.error('App: select similar failed', err);
      this.setStatus('Could not complete the search');
      window.setTimeout(() => this.setStatus(''), STATUS_CLEAR_MS);
    }
  }

  // ── Context menu (C) ───────────────────────────────────────
  //
  // The menu acts ONLY on the current selection (CM2): it reads
  // SelectionManager.getState() and the appearance flags to build its items,
  // and NEVER raycasts or mutates the selection on right-click. To act on an
  // element the user selects it first; to act on the basket they MR it into the
  // selection first.

  /** Right-click → build a selection-scoped menu (no raycast, no selection change). */
  private onContextMenu(e: MouseEvent): void {
    // Always suppress the native browser menu, on every path.
    e.preventDefault();

    // Bail (no menu) while a tool owns the pointer or a marquee drag is in
    // progress — don't fight tool gestures (CM4).
    if (
      shouldSuppressContextMenu({
        toolActive: this.toolManager.getActiveTool() !== null,
        marqueeDragging: this.marqueeSelector.isDragging(),
      })
    ) {
      return;
    }

    // Coordinates must be read before the await below — the event object is
    // not safe to touch once the handler has yielded.
    void this.openContextMenu(e.clientX, e.clientY);
  }

  /**
   * Resolve the selection's full identity, then open the menu for it.
   *
   * `SelectionManager` stores PLACEHOLDER identities — `ifcClass: ''`,
   * `ifcTypeCode: 0` — because it only knows what was clicked, not what it
   * is. Building the menu straight off those produced a category query for
   * class "" and type code 0, which enumerated nothing ("No elements match
   * all elements") and could never offer a type row. The repository memo
   * holds the enriched identity for anything the inspector has already
   * fetched, so this is normally instant.
   */
  private async openContextMenu(x: number, y: number): Promise<void> {
    const state = await this.enrichSelection(this.selectionManager.getState());
    // Same resolution the menu builder does, so a row that was offered and the
    // query it runs can never disagree.
    const similar = state.kind === 'none' ? null : sharedSource(state.identities);
    const items = buildContextMenuItems(
      state,
      {
        hasHidden: this.appearanceManager.hasHidden(),
        hasTransparent: this.appearanceManager.hasTransparent(),
      },
      {
        hide: () => this.appearanceHide(),
        isolate: () => this.appearanceIsolate(),
        showAll: () => this.appearanceShowAll(),
        transparent: () => this.appearanceTransparent(),
        opaque: () => this.appearanceOpaque(),
        clearTransparency: () => this.appearanceClearTransparency(),
        addToBasket: () => this.basketAdd(),
        selectSimilarCategory: () => {
          if (!similar) return;
          void this.runSelectSimilar(categoryQuery(similar));
        },
        selectSimilarType: () => {
          if (!similar) return;
          const query = typeQuery(similar);
          if (query) void this.runSelectSimilar(query);
        },
      },
    );

    // No selection and no active recovery action → no menu.
    if (!items || items.length === 0) return;

    this.contextMenu.open(x, y, items);
  }

  /**
   * Fill in the selection's real class / type code / type name from the
   * property repository, so "select all of this category / type" knows what
   * "this" is. Every member is enriched, because a multi-selection offers the
   * same rows whenever its members agree (`sharedSource`).
   *
   * Capped at `SIMILAR_MENU_ENRICH_MAX`: each fetch is a worker round-trip,
   * and a right-click menu that takes seconds to appear is worse than one
   * missing two rows. Past the cap the identities stay as they are, which
   * `sharedSource` reads as "nothing to offer".
   *
   * A failed fetch falls back to the placeholder rather than suppressing the
   * menu: hide / isolate / basket don't need the enrichment, and losing the
   * whole menu because one property read failed would be worse.
   */
  private async enrichSelection(state: SelectionState): Promise<SelectionState> {
    if (state.kind === 'none') return state;
    if (state.identities.length > SIMILAR_MENU_ENRICH_MAX) return state;

    const enriched = await Promise.all(
      state.identities.map(async (identity) => {
        try {
          const props = await this.propertyRepository.get(identity.modelId, identity.expressId);
          return { ...identity, ...props.identity };
        } catch {
          return identity;
        }
      }),
    );

    return state.kind === 'single'
      ? { kind: 'single', identities: [enriched[0]] }
      : { ...state, identities: enriched };
  }

  // ── Appearance actions (D) ─────────────────────────────────
  //
  // Each wraps an AppearanceManager op on the current-selection Scope, then
  // reconciles the highlight for any selected meshes whose base material just
  // changed. App is the single owner of the precedence chain
  // hidden > transparent > highlighted > base (the orchestrated reconciliation).

  /** The Scope these verbs act on = the current live selection. */
  private selectionScope(): import('../inspector/types').Scope {
    const state = this.selectionManager.getState();
    return state.kind === 'none' ? [] : state.identities;
  }

  private appearanceHide(): void {
    this.appearanceManager.hide(this.selectionScope());
    this.selectionManager.refreshHighlights();
  }

  private appearanceIsolate(): void {
    this.appearanceManager.isolate(this.selectionScope());
    this.selectionManager.refreshHighlights();
  }

  private appearanceShowAll(): void {
    this.appearanceManager.showAll();
    this.selectionManager.refreshHighlights();
  }

  private appearanceTransparent(): void {
    this.appearanceManager.transparent(this.selectionScope());
    this.selectionManager.refreshHighlights();
  }

  private appearanceOpaque(): void {
    this.appearanceManager.opaque(this.selectionScope());
    this.selectionManager.refreshHighlights();
  }

  private appearanceClearTransparency(): void {
    this.appearanceManager.clearTransparency();
    this.selectionManager.refreshHighlights();
  }

  /** Tray label for the "Show N hidden" button, kept in sync via onChange. */
  private showHiddenLabel(): string {
    const n = this.appearanceManager.hiddenCount();
    return n > 0 ? `Show ${n} hidden` : 'Show hidden';
  }

  private updateShowHiddenLabel(): void {
    const btn = document.querySelector<HTMLElement>(
      '.contextual-action[data-action-id="show-hidden"] .contextual-action-label',
    );
    if (btn) btn.textContent = this.showHiddenLabel();
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
    // Drop appearance overrides for every model — resetView re-creates the
    // meshes, and the recorded state references the disposed ones. A full
    // reset starts from a clean appearance slate, consistent with the
    // selection clear above.
    for (const id of this.modelManager.getModelIds()) {
      this.appearanceManager.onModelRemoved(id);
    }
    // resetView tears down and re-adds every model; the undo history's
    // references won't survive that, so clear it (U2). (The selectionManager
    // .clear() above ran while history was still live; clearing now drops any
    // command it pushed, which is what we want for a full reset.)
    this.history.clear();

    // Remove all models and UI rows. propertyRepository.disposeModel posts
    // the `disposeModel` worker message, so we do not also call
    // parser.disposeModel here.
    for (const id of this.modelManager.getModelIds()) {
      if (this.propertyRepository) {
        this.propertyRepository.disposeModel(id);
      } else {
        this.parser.disposeModel(id);
      }
      this.modelManager.removeModel(id);
      this.modelTreePanel.removeModel(id);
    }

    // Re-parse and re-add every loaded model from buffer cache. The worker
    // re-opens each model under its existing app-UUID; property queries
    // resume once the re-parse completes.
    for (const [id, record] of this.modelRecords) {
      const buffer = this.bufferCache.get(id);
      if (!buffer) continue;
      try {
        this.setStatus(`Reloading ${record.name}...`);
        this.modelManager.beginStream(id);
        const parsed = await this.parser.parseStreaming(buffer, id, (batch) => {
          this.modelManager.appendMeshes(id, batch);
        });
        this.modelManager.endStream(id);
        this.modelTreePanel.addModel(id, record.name, parsed.meshes.length, record.source.type);
      } catch {
        // skip files that fail to re-parse — drop any partial stream
        this.modelManager.removeModel(id);
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
    if (this.historyShortcuts) this.historyShortcuts.dispose();
    this.toolbar.dispose();
    this.modelTreePanel.dispose();
    if (this.inspectorPanel) this.inspectorPanel.dispose();
    if (this.selectionBasketPanel) this.selectionBasketPanel.dispose();
    this.marqueeSelector.dispose();
    this.selectionManager.dispose();
    // Context menu: detach the canvas listener + tear down the menu element.
    // Guarded — the field is initialized in start().
    if (this.boundOnContextMenu) {
      this.viewer.getCanvas().removeEventListener('contextmenu', this.boundOnContextMenu);
    }
    if (this.contextMenu) this.contextMenu.dispose();
    // contextualActions must dispose BEFORE toolManager so the tray can
    // unsubscribe from a live ClippingTool source. (toolManager.dispose
    // calls clippingTool.dispose, which clears its listener array.) The
    // field is initialized in start(), so guard for early-dispose paths.
    if (this.contextualActions) this.contextualActions.dispose();
    this.toolManager.dispose();
    this.modelManager.dispose();
    this.fileLoader.dispose();
    // Tear down the IFC worker: `dispose` posts a `dispose` message
    // (the worker frees every open web-ifc model + the WASM heap) and
    // then terminates the worker thread.
    this.parser.dispose();
    this.viewer.dispose();
  }
}
