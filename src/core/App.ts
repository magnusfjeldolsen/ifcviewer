import { Viewer } from '../viewer/Viewer';
import { ModelManager } from '../viewer/ModelManager';
import { AppearanceManager } from '../viewer/AppearanceManager';
import { FileLoader } from '../loader/FileLoader';
import { WorkerIfcParser } from '../parser/WorkerIfcParser';
import { UrlInput } from '../ui/UrlInput';
import { RemoteLoader } from '../loader/RemoteLoader';
import { checkRemoteUrl, type UrlSource } from '../loader/urlSafety';
import { ToolManager } from '../tools/Tool';
import { ClippingTool } from '../tools/ClippingTool';
import { MeasurementTool } from '../tools/MeasurementTool';
import { PositionMarkerTool } from '../tools/PositionMarkerTool';
import type { SnapTarget } from '../tools/snapCandidates';
import { Toolbar } from '../ui/Toolbar';
import { ModelTreePanel } from '../ui/ModelTreePanel';
import { MemoryToggle } from '../ui/MemoryToggle';
import { Footer } from '../ui/Footer';
import { CookieBanner } from '../ui/CookieBanner';
import { KeyboardShortcuts } from '../ui/KeyboardShortcuts';
import { HistoryShortcuts } from '../ui/HistoryShortcuts';
import { HistoryManager } from './history/HistoryManager';
import { HelpOverlay } from '../ui/HelpOverlay';
import { FlyTips, looksTouchOnly } from '../ui/FlyTips';
import { CentreMark } from '../ui/CentreMark';
import { elementTagLabel } from '../inspector/elementLabel';
import { elementOfHit } from '../viewer/ModelBatch';
import { ContextualActions } from '../ui/ContextualActions';
import { CookieConsent } from '../services/CookieConsent';
import { Analytics } from '../services/Analytics';
import { SessionStore } from '../services/SessionStore';
import { GeometryCache, sha256Hex } from '../services/GeometryCache';
import { LoadTimeline, type LoadPhases } from './LoadTimeline';
import { partFilesSupported, type CacheWriteReport } from '../services/geometryParts';
import { loadingStatus } from '../ui/loadingStatus';
import { loadErrorStatus } from './loadErrors';
import { SelectionManager } from '../inspector/SelectionManager';
import { MarqueeSelector } from '../inspector/MarqueeSelector';
import { CandidateResolver } from '../inspector/CandidateResolver';
import { CandidateInput } from '../inspector/CandidateInput';
import { elementCandidatesAt, elementHit } from '../inspector/elementCandidates';
import { measurementPayload } from '../tools/measurementPicking';
import { Settings } from '../services/Settings';
import { InspectorPanel } from '../inspector/InspectorPanel';
import { SelectionBasket } from '../inspector/SelectionBasket';
import { SelectionBasketPanel } from '../ui/SelectionBasketPanel';
import { ParametersPanel } from '../ui/ParametersPanel';
import { registerModel } from './registerModel';
import { valueText } from '../ui/ParameterList';
import { ColourByController, colourScopeFor, isColouringBy, staleWhenVisibilityChanges, type ColourScope } from '../inspector/ColourByController';
import { ColourLegend, loadColourValueCount } from '../ui/ColourLegend';
import { ParameterPicker, type PickerRow } from '../ui/ParameterPicker';
import { TotalsController, type TotalsScope } from '../inspector/TotalsController';
import { VisibleCountsController } from '../inspector/VisibleCountsController';
import { TotalsView } from '../ui/TotalsView';
import type { ParameterSummary, ParameterValue } from '../inspector/types';
import type { UnitRef } from '../inspector/units';
import { crossModelUnitKey, findAcrossModels, InOrder, Latest, showOnlyStatus } from '../inspector/showOnly';
import { StatusTimer } from '../ui/statusTimer';
import { columnIdsWithValue, columnValueCounts } from '../inspector/parameterColumn';
import { LoadGate } from './LoadGate';
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
import { SceneBounds } from '../viewer/SceneBounds';

/**
 * A model load has finished, one way or the other. `source` says whether it
 * was a file the user opened or a model brought back by session restore;
 * `fromCache` is true when restore hydrated it from the geometry cache instead
 * of parsing the IFC again.
 */
export interface LoadSettledEvent {
  name: string;
  source: 'file' | 'restore';
  ok: boolean;
  meshCount: number;
  fromCache: boolean;
  error?: string;
  /** Where the load's time went, when it was measured. See `LoadTimeline`. */
  phases?: LoadPhases;
}

/** What the `?stats` debug surface needs to reach. Nothing else uses it. */
export interface DebugHandles {
  viewer: Viewer;
  modelManager: ModelManager;
  onLoadSettled(cb: (event: LoadSettledEvent) => void): void;
}

/** Status while another tab blocks storage (see `SessionStore.openDB`). */
export const STORAGE_BLOCKED_STATUS =
  'The viewer is open in another tab with an older version, so models are not remembered here. Close the other tabs and reload.';

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
  /** World extent of everything loaded, fed batch by batch from parsed data. */
  private sceneBounds = new SceneBounds();
  private measurementTool: MeasurementTool;
  private positionTool: PositionMarkerTool;
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
  private flyTips: FlyTips;
  /** Dot in a ring at the centre of the view while flying with the mouse captured. */
  private centreMark: CentreMark;
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
  /** Whether a model is loading: parameter discovery waits until none is. */
  private loadGate = new LoadGate();
  private statusEl: HTMLElement | null;
  // Element selection (Phase 2 of the Inspector). Owns canvas pointer
  // listeners; defers to active tools and pivot picking via deps.
  private selectionManager!: SelectionManager;
  // Alt-drag marquee selection (window/crossing). Coexists with
  // SelectionManager via capture-phase pointerdown; bails when any tool
  // is active or pivot picking is on.
  private marqueeSelector!: MarqueeSelector;
  // The one candidate system (D9). Given a cursor it asks every registered
  // provider what is under there, ranks the answers (elements first), lets the
  // top one pre-highlight, and lets Tab cycle. Step 1 registers the element
  // and measurement providers; snapping registers a third later and inherits
  // the ranking, the cycling and the hover display unchanged.
  private candidateResolver = new CandidateResolver();
  // Constructed in start(); null until then, so the SelectionManager adapter
  // below can be handed over in the constructor and simply answer "nothing" if
  // a click somehow arrives before the wiring is complete.
  private candidateInput: CandidateInput | null = null;
  // User settings, keyed under `ifcviewer:settings:*`. Today it holds one
  // entry — the D10 hover pre-highlight toggle; the queued settings panel will
  // surface it (and the rest) rather than each consumer reading storage itself.
  private settings = new Settings();
  // Element appearance (hide / isolate / show-all + transparent / opaque).
  // Per-element overrides driven from the context menu + the contextual tray,
  // made reversible by the shared HistoryManager. Constructed in the App
  // constructor alongside SelectionManager.
  private appearanceManager!: AppearanceManager;
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
  private parametersPanel!: ParametersPanel;
  /** Columns asked for because their parameter is open: `${modelId}
${key}`. */
  private preparedColumns = new Set<string>();
  /** Colour by parameter (#68): the colouring shown, its legend, and the right-click picker. */
  private colourBy!: ColourByController;
  private colourLegend!: ColourLegend;
  private parameterPicker!: ParameterPicker;
  private totals!: TotalsController;
  /** Counts in the Parameters list that follow what can be seen (#115). */
  private visibleCounts!: VisibleCountsController;
  private totalsView!: TotalsView;
  // Told when a model load finishes or fails. Only the `?stats` debug
  // surface listens; see `onLoadSettled`.
  private loadSettledListeners: Array<(event: LoadSettledEvent) => void> = [];

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
      cancelCameraAnimation: () => this.viewer.cancelCameraAnimation(),
    });
    this.toolManager.register(this.clippingTool);
    // The handle can be dragged outside the model; keep it between the planes.
    this.viewer.addViewBoundsSource((box) => this.clippingTool.expandViewBounds(box));

    // One set of snap settings, shared by every tool that places a point.
    const snapSettings = {
      snappingEnabled: () => this.settings.get('measurementSnapping'),
      allowedSnapTargets: () => {
        const allowed = new Set<SnapTarget>(['point']);
        if (this.settings.get('snapToVertices')) allowed.add('vertex');
        if (this.settings.get('snapToEdges')) allowed.add('edge');
        if (this.settings.get('snapToSurfaces')) allowed.add('face');
        return allowed;
      },
      onToggleSnapTarget: (target: SnapTarget) => {
        const key =
          target === 'vertex'
            ? 'snapToVertices'
            : target === 'edge'
              ? 'snapToEdges'
              : 'snapToSurfaces';
        const on = this.settings.toggle(key);
        const name = target === 'vertex' ? 'Corners' : target === 'edge' ? 'Edges' : 'Surfaces';
        this.setStatus(`${name} ${on ? 'on' : 'off'}`);
        this.clearStatusAfter(STATUS_CLEAR_MS);
      },
      onToggleSnapping: () => {
        const on = this.settings.toggle('measurementSnapping');
        this.setStatus(on ? 'Snapping on' : 'Snapping off');
        this.clearStatusAfter(STATUS_CLEAR_MS);
      },
    };

    this.measurementTool = new MeasurementTool({
      renderer: this.viewer.getRenderer(),
      scene: this.viewer.getScene(),
      camera: this.viewer.getCamera(),
      canvas: this.viewer.getCanvas(),
      requestRender,
      // The tool refuses a measurement between two surfaces that are not
      // parallel. The status line is where it says so, and it clears itself
      // like every other transient message.
      onMessage: (message) => {
        this.setStatus(message);
        this.clearStatusAfter(STATUS_CLEAR_MS);
      },
      ...snapSettings,
    });
    this.toolManager.register(this.measurementTool);

    // Setting out a coordinate. Snaps through the same `SnapCursor` and reads
    // the same snap settings as measuring, so `S` and `1` `2` `3` are one
    // switch for both tools rather than two that disagree.
    this.positionTool = new PositionMarkerTool({
      renderer: this.viewer.getRenderer(),
      scene: this.viewer.getScene(),
      camera: this.viewer.getCamera(),
      canvas: this.viewer.getCanvas(),
      overlayParent: document.getElementById('app')!,
      requestRender,
      // `propertyRepository` is created later in the constructor; looked up
      // at call time, by which point it exists.
      lengthUnitFor: (modelId) => this.propertyRepository.lengthUnit(modelId),
      onMessage: (message) => {
        this.setStatus(message);
        this.clearStatusAfter(STATUS_CLEAR_MS);
      },
      snappingEnabled: snapSettings.snappingEnabled,
      allowedSnapTargets: snapSettings.allowedSnapTargets,
      onToggleSnapTarget: snapSettings.onToggleSnapTarget,
      onToggleSnapping: snapSettings.onToggleSnapping,
    });
    this.toolManager.register(this.positionTool);

    // Keep clipping handle and measurement markers at constant screen size
    this.viewer.onUpdate(() => {
      this.clippingTool.update();
      this.measurementTool.update();
      this.positionTool.update();
    });

    // Undo/redo history. The single owner of the undo/redo stacks; injected
    // into the SelectionManager and SelectionBasket so each pushes one command
    // per user gesture. Constructed before those consumers.
    this.history = new HistoryManager();

    // Element appearance. Shares the HistoryManager (each
    // hide/isolate/show-all/transparent/opaque = one undoable command).
    this.appearanceManager = new AppearanceManager({
      modelManager: this.modelManager,
      requestRender,
      history: this.history,
      // Read when a show-only runs, long after the clipping tool exists.
      clipPlane: () => this.clippingTool.getClipPlane(),
    });

    // Element selection (Phase 2 — Inspector). Must be constructed after
    // viewer / modelManager / toolManager exist; defers clicks to active
    // tools and pivot picking via those dependencies. The highlight is its own
    // per-element flag in the renderer, so it composes with appearance
    // overrides without either manager knowing about the other.
    this.selectionManager = new SelectionManager({
      viewer: this.viewer,
      modelManager: this.modelManager,
      toolManager: this.toolManager,
      history: this.history,
      // Pick arbitration: elements outrank the annotations drawn over them, so
      // this normally answers 'element' and the click proceeds exactly as it
      // did before. Only a Tab-cycled candidate diverts it.
      candidates: {
        activeAt: (x, y) => this.candidateInput?.activeAt(x, y) ?? null,
        pick: (candidate) => this.candidateResolver.pick(candidate),
      },
    });

    // Picking a measurement is a selection in its own right, so the two never
    // coexist. Guarded on a NON-empty selection: clearing the element
    // selection is exactly what the measurement pick does first, and reacting
    // to that would undo the selection it just made.
    this.selectionManager.onChange((state) => {
      if (state.kind !== 'none') this.measurementTool.selectMeasurement(null);
    });

    // Orbiting over empty space with something selected almost always means
    // "turn around that", so give the viewer a way to ask where it is.
    this.viewer.setSelectionCenterProvider(() => this.selectionManager.getSelectionCenter());
    // Everything loaded, hidden included, kept up to date as each batch
    // arrives (see SceneBounds). Sizes the clipping planes, so neither a
    // streaming load nor unhiding can reveal a cut.
    this.viewer.setSceneBoundsProvider(() => this.sceneBounds.box());
    // See-through elements blend in the right order only if drawn back to
    // front; the batches sort themselves for the view before each frame.
    this.viewer.onUpdate(() => this.modelManager.sortSeeThrough(this.viewer.getCamera()));
    this.sceneBounds.onChange(() => this.viewer.refreshSceneBounds());

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
    this.toolbar.addButton({
      name: 'position',
      icon: '📍',
      title: 'Position marker — read X, Y, Z (P)',
    });
    this.toolbar.addButton({
      name: 'fly',
      icon: '✈',
      title: 'Fly through the model (G)',
      toggle: true,
      onClick: () => this.viewer.toggleFlying(),
    });
    this.toolbar.addButton({ name: 'fit', icon: '⊡', title: 'Fit View (F)', onClick: () => this.fitSmart() });
    this.toolbar.addButton({ name: 'transparify', icon: '◻', title: 'Transparify All', disabled: true });
    this.toolbar.addButton({ name: 'reset', icon: '↺', title: 'Reset View', onClick: () => this.resetView() });
    this.toolbar.finalize();

    // Flying (#98): the button shows the mode, and the keys show only while
    // flying. Every way out — the button, G, Esc, Fit, a load — lands here.
    this.flyTips = new FlyTips(appEl, this.viewer.getFlySpeed());
    this.centreMark = new CentreMark(appEl, { anchor: this.viewer.getCanvas() });
    this.viewer.onFlyingChange((flying) => {
      this.toolbar.setPressed('fly', flying);
      if (flying) this.flyTips.show();
      else this.flyTips.hide();
      this.updateCentreMark();
      this.fitFlyTips();
    });
    window.addEventListener('resize', () => this.fitFlyTips());
    // What is under the centre mark, looked at only when the flying view has
    // moved (the viewer throttles it and skips busy frames).
    this.viewer.onFlyProbe((fast) => this.probeCentreMark(fast));
    this.viewer.onFlySpeedChange((speed) => this.flyTips.setSpeed(speed));
    // Captured mouse or drag-to-look (the lock was refused): the tips and the
    // crosshair say which.
    this.viewer.onFlyLookChange((look) => {
      this.flyTips.setLook(look);
      this.updateCentreMark();
    });
    // A touch-only device has no way to fly, so it is not offered — until a
    // key press shows a keyboard is there after all.
    if (looksTouchOnly()) {
      this.toolbar.setHidden('fly', true);
      window.addEventListener('keydown', () => this.toolbar.setHidden('fly', false), { once: true });
    }

    // Model tree panel
    this.modelTreePanel = new ModelTreePanel(appEl, {
      onVisibilityToggle: (id, visible) => {
        this.modelManager.setVisible(id, visible);
        // D15 — a measurement follows its model. A number annotating geometry
        // the user just switched off is worse than no number, and a
        // measurement spanning two models hides while either is hidden.
        this.measurementTool.setModelVisible(id, visible);
        this.positionTool.setModelVisible(id, visible);
        this.colourBy?.markStale();
        this.totals?.invalidate();
        this.visibleCounts?.invalidate();
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
        // D15 — drop this model's measurements: two world points with no
        // geometry left to refer to are not a measurement.
        this.measurementTool.onModelRemoved(id);
        this.positionTool.onModelRemoved(id);
        // Prune appearance overrides for the removed model (system change,
        // pushes no undo command). Its onChange triggers a debounced save.
        this.appearanceManager.onModelRemoved(id);
        // Its elements leave the colouring by parameter (and the colouring
        // ends if it was this model's alone).
        this.colourBy?.onModelRemoved(id);
        this.totals?.onModelRemoved(id);
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
        this.sceneBounds.removeModel(id);
        this.modelTreePanel.removeModel(id);
        const record = this.modelRecords.get(id);
        this.modelRecords.delete(id);
        // After the record is gone, so the panel can move on to another model.
        this.parametersPanel?.onModelRemoved(id);
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
      onShowParameters: (id) => this.parametersPanel?.open(id),
    });

    // Session persistence
    this.sessionStore = new SessionStore();
    // Parsed-geometry cache, keyed by SHA-256 of the source .ifc buffer.
    // Used to skip geometry streaming on session restore — the model
    // becomes visible immediately and the worker re-opens the model in
    // the background to refill the web-ifc state the property inspector
    // needs.
    this.geometryCache = new GeometryCache(this.sessionStore);
    // A tab running an older build can hold the database at its version.
    // The viewer then works without remembering anything; say so plainly.
    this.sessionStore.onStorageBlocked(() => this.setStatus(STORAGE_BLOCKED_STATUS));
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
      key: 'p',
      label: 'Position marker',
      action: () => {
        if (!this.toolManager.isActive('position')) {
          this.toolManager.activate('position');
        }
      },
    });

    // D5 — click a measurement, then Delete. `KeyboardShortcuts` already skips
    // text inputs, so this cannot eat a Backspace someone is typing with.
    // Registered under both keys because Delete and Backspace are the two
    // conventions and users reach for whichever their keyboard has.
    const deleteMeasurement = (): void => {
      if (this.measurementTool.removeSelectedMeasurement()) {
        this.candidateInput?.refresh();
      }
    };
    this.keyboardShortcuts.register({
      key: 'Delete',
      label: 'Delete measurement',
      action: deleteMeasurement,
    });
    this.keyboardShortcuts.register({
      key: 'Backspace',
      label: 'Delete measurement',
      action: deleteMeasurement,
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

    // Flying (#98). F is Fit View, so the mode key is its neighbour G ("go").
    this.keyboardShortcuts.register({
      key: 'g',
      label: 'Fly through the model',
      plainOnly: true,
      action: () => this.viewer.toggleFlying(),
    });

    // While flying the mouse is captured, so the tips' Hide button cannot be
    // clicked: H does the same. Outside flying the key does nothing.
    this.keyboardShortcuts.register({
      key: 'h',
      label: 'Show / hide the flying keys',
      plainOnly: true,
      action: () => {
        if (this.viewer.isFlying()) this.flyTips.toggleCollapsed();
      },
    });

    this.keyboardShortcuts.register({
      key: 'Escape',
      label: 'Cancel',
      action: () => {
        if (this.viewer.isPivotPicking()) {
          this.viewer.cancelPivotPicking();
        } else if (this.toolManager.getActiveTool() !== null) {
          this.toolManager.abort();
        } else if (this.viewer.isFlying()) {
          // An open menu or the help card closes on this Escape by itself
          // (their listeners run after this one); leaving flying waits for
          // the next, so one press never does two things.
          if (!this.contextMenu?.isOpen() && !this.helpOverlay.isOpen()) this.viewer.exitFlying();
        } else {
          // No tool active, no pivot picking: clear both selections. A
          // measurement selection is as much "a thing Escape should let go of"
          // as an element one, and only one of the two is ever set.
          this.selectionManager.clear();
          this.measurementTool.selectMeasurement(null);
        }
      },
    });

    // Help overlay — ? button at top-left, also toggled by ? key
    const appEl = document.getElementById('app')!;
    this.helpOverlay = new HelpOverlay(appEl, this.keyboardShortcuts);
    // An open menu or help card has the keyboard; fly keys wait for it.
    this.viewer.setFlyKeysSuspended(() => !!this.contextMenu?.isOpen() || this.helpOverlay.isOpen());

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

    // Totals (#69): count, sum, min, max and average of chosen parameters
    // over the selection, or everything visible when nothing is selected.
    // A tab of the Parameters panel; it reads the same value columns, and
    // does nothing while the tab is closed.
    const loadedModels = (): string[] =>
      [...this.modelRecords.values()].filter((r) => this.modelManager.getModel(r.id)).map((r) => r.id);
    this.totals = new TotalsController({
      models: loadedModels,
      isShown: (id) => this.modelManager.isVisible(id),
      scope: () => this.totalsScope(),
      visibility: (modelId) => this.modelManager.visibleElements(modelId, this.clippingTool.getClipPlane()),
      describe: async (modelId, onProgress) => {
        await this.loadGate.idle();
        return this.propertyRepository.describeParameters(modelId, this.modelManager.elementIds(modelId), onProgress);
      },
      scopeIds: (modelId) => this.propertyRepository.scopeOf(modelId),
      // The controller waits for any load itself, and asks for a column only
      // if it still wants it then.
      waitForIdle: () => this.loadGate.idle(),
      loadColumn: (modelId, key, onProgress) => this.propertyRepository.getColumn(modelId, key, onProgress),
      visibleCount: (models) => {
        const plane = this.clippingTool.getClipPlane();
        let n = 0;
        for (const m of models) {
          const visible = this.modelManager.visibleElements(m, plane);
          for (const id of this.modelManager.elementIds(m)) if (!visible || visible(id)) n++;
        }
        return n;
      },
      // A build the Parameters list also got ready is the list's to give up.
      releaseColumn: (modelId, key) => {
        if (!this.preparedColumns.has(`${modelId}\n${key}`)) this.propertyRepository.releaseColumn(modelId, key);
      },
      select: (elements) =>
        this.selectionManager.selectExactly(elements.map((e) => ({ ...e, ifcClass: '', ifcTypeCode: 0 }))),
      showOnly: (elements, label, additive) => this.showOnlyElements(elements, label, additive),
    });
    this.totalsView = new TotalsView({
      controller: this.totals,
      picker: { open: (x, y, heading, rows, onPick) => this.parameterPicker.open(x, y, heading, rows, onPick) },
      modelName: (id) => this.modelRecords.get(id)?.name ?? 'Model',
    });
    // The totals follow the selection and what can be seen (debounced).
    // The Parameters list's counts follow the same visibility (#115): they
    // read the columns already built, and run only while the list is shown.
    this.visibleCounts = new VisibleCountsController({
      scopeIds: (modelId) => this.propertyRepository.scopeOf(modelId),
      visibility: (modelId) => this.modelManager.visibleElements(modelId, this.clippingTool.getClipPlane()),
      builtColumns: (modelId) => this.propertyRepository.builtColumns(modelId),
      onView: (view) => this.parametersPanel.getList().setVisible(view),
    });
    const recount = (): void => this.totals.invalidate();
    const recountVisible = (): void => this.visibleCounts.invalidate();
    this.selectionManager.onChange(recount);
    this.appearanceManager.onChange(() => {
      recount();
      recountVisible();
    });
    this.clippingTool.onStateChange(() => {
      recount();
      recountVisible();
    });
    this.clippingTool.onPlaneMoved(() => {
      recount();
      recountVisible();
    });
    this.loadGate.onIdle(() => {
      recount();
      recountVisible();
    });

    // Parameters panel (#67): which parameters a model has, opened from the
    // model's row in the Models panel. Discovery runs in the worker, never
    // during a load, over the elements the viewer draws — so its counts are
    // of what can be selected and coloured.
    this.parametersPanel = new ParametersPanel(appEl, {
      totals: this.totalsView,
      addToTotals: (parameter) => this.totals.addRow(parameter.key),
      watchVisibility: (modelId) => this.visibleCounts.watch(modelId),
      getModels: () => [...this.modelRecords.values()]
        .filter((r) => this.modelManager.getModel(r.id))
        .map((r) => ({ id: r.id, name: r.name })),
      describe: async (modelId, onProgress, onStarted) => {
        await this.loadGate.idle();
        onStarted?.();
        return this.propertyRepository.describeParameters(
          modelId,
          this.modelManager.elementIds(modelId),
          onProgress,
        );
      },
      isLoading: () => this.loadGate.busy,
      // Values and selection both read the parameter's value column: built
      // once in the worker (in the background, when the row is opened) and
      // then answered on this thread without asking the worker again.
      loadValues: async (modelId, key, onProgress) => {
        await this.loadGate.idle();
        return columnValueCounts(await this.propertyRepository.getColumn(modelId, key, onProgress));
      },
      selectValue: (modelId, parameter, value, additive, unit) =>
        void this.selectParameterValue(modelId, parameter, value, additive, unit),
      showOnlyValue: (modelId, parameter, value, additive, unit) =>
        void this.showOnlyParameterValue(modelId, parameter, value, additive, unit),
      // Opening a parameter builds its column in case a value is picked;
      // closing it again (or opening another) gives that build up, so
      // browsing the list never leaves scans running that nobody needs.
      prepare: (modelId, parameter) => {
        const wanted = `${modelId}
${parameter.key}`;
        this.preparedColumns.add(wanted);
        void this.loadGate
          .idle()
          .then(() => {
            // Closed again while a load was running: never started.
            if (!this.preparedColumns.has(wanted)) return;
            return this.propertyRepository.getColumn(modelId, parameter.key);
          })
          // The column is there now: the opened row can say what is visible.
          .then(() => this.visibleCounts.invalidate())
          // Given up, or failed: picking a value asks again and reports a failure then.
          .catch(() => {});
      },
      release: (modelId, parameter) => {
        this.preparedColumns.delete(`${modelId}
${parameter.key}`);
        this.propertyRepository.releaseColumn(modelId, parameter.key);
      },
      // The button of the parameter coloured by now clears it again.
      colourBy: (modelId, parameter) => {
        if (isColouringBy(this.colourBy.getState(), parameter.key, modelId)) this.colourBy.clear();
        else void this.colourBy.colourBy(parameter.key, this.colourScope(modelId, true));
      },
    });

    // Colour by parameter (#68). The colours read the same value columns as
    // the Parameters list; a model's parameters are described first when
    // the colouring comes from the right-click menu and the list was never
    // opened (the column's rows are the described elements).
    this.colourBy = new ColourByController({
      loadColumn: async (modelId, key, onProgress) => {
        await this.loadGate.idle();
        await this.propertyRepository.describeParameters(modelId, this.modelManager.elementIds(modelId), onProgress);
        // Urgent: someone is waiting to see the colours.
        return this.propertyRepository.getColumn(modelId, key, onProgress, { urgent: true });
      },
      paint: this.modelManager,
      select: (elements) =>
        this.selectionManager.selectExactly(elements.map((e) => ({ ...e, ifcClass: '', ifcTypeCode: 0 }))),
      showOnly: (elements, label, additive) => this.showOnlyElements(elements, label, additive),
      // Only what can be seen is coloured: not hidden, its model shown, and
      // not wholly behind the section plane.
      visibility: (modelId) => this.modelManager.visibleElements(modelId, this.clippingTool.getClipPlane()),
    }, { maxValues: loadColourValueCount() });
    // Anything that changes what can be seen may leave the colours out of
    // date: the legend says so, and Refresh works them out again.
    staleWhenVisibilityChanges(this.colourBy, { appearance: this.appearanceManager, clipping: this.clippingTool });
    // Appended after the Parameters panel: the stylesheet moves the legend
    // left of the panel while the panel is open (a sibling selector).
    this.colourLegend = new ColourLegend(appEl, {
      controller: this.colourBy,
      modelName: (id) => this.modelRecords.get(id)?.name ?? 'Model',
    });
    this.parameterPicker = new ParameterPicker(appEl);
    this.colourBy.onChange(() => {
      const s = this.colourBy.getState();
      this.parametersPanel.setColoured(
        s.phase === 'off'
          ? null
          : { key: s.key, models: new Set(s.scope.kind === 'model' ? [s.scope.modelId] : s.scope.elements.keys()) },
      );
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
    // The tray shares the right edge with the Parameters panel and grows
    // upward; the panel stays clear of it.
    const tray = contextualParent.querySelector<HTMLElement>('.contextual-actions');
    if (tray) {
      this.parametersPanel.keepClearOf(tray);
      this.colourLegend.keepClearOf(tray);
    }
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

    // Measurements (D5) — before this there was NO way to remove one: the only
    // escape was Reset View, which also drops your clipping plane, selection
    // and appearance overrides. Same idiom as Remove clipping; visible only
    // when at least one measurement exists.
    this.contextualActions.register({
      id: 'clear-measurements',
      label: 'Clear measurements',
      icon: '📏',
      isVisible: () => this.measurementTool.hasMeasurements(),
      onClick: () => this.measurementTool.clearMeasurements(),
      subscribe: (refresh) => this.measurementTool.onStateChange(refresh),
    });

    // Same idiom for position markers; visible only when one exists.
    this.contextualActions.register({
      id: 'clear-position-markers',
      label: 'Clear position markers',
      icon: '📍',
      isVisible: () => this.positionTool.hasMarkers(),
      onClick: () => this.positionTool.clearMarkers(),
      subscribe: (refresh) => this.positionTool.onStateChange(refresh),
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
    // Orbit pivot — the red marker is easy to place and, before this, had no
    // discoverable way back off. Same idiom as Remove clipping; visible only
    // while a pivot is actually placed.
    this.contextualActions.register({
      id: 'remove-pivot',
      label: 'Remove pivot',
      icon: '🎯',
      isVisible: () => this.viewer.hasPivot(),
      onClick: () => this.viewer.clearPivot(),
      subscribe: (refresh) => this.viewer.onPivotChange(refresh),
    });

    // Colour by parameter: the legend has its own Clear, but the tray is
    // where every other "undo this view change" lives.
    this.contextualActions.register({
      id: 'clear-colours',
      label: 'Clear colours',
      icon: '🎨',
      isVisible: () => this.colourBy.isActive(),
      onClick: () => this.colourBy.clear(),
      subscribe: (refresh) => this.colourBy.onChange(refresh),
    });

    this.contextualActions.register({
      id: 'clear-transparency',
      label: 'Clear transparency',
      icon: '◐',
      isVisible: () => this.appearanceManager.hasTransparent(),
      onClick: () => this.appearanceClearTransparency(),
      subscribe: (refresh) => this.appearanceManager.onChange(refresh),
    });

    this.setupCandidateSystem();

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
      const endLoad = this.loadGate.begin();
      try {
        await this.restoreSession();
      } finally {
        endLoad();
      }
    }

    // Auto-save camera state on changes (throttled to 1s)
    this.viewer.onUpdate(() => this.scheduleSave());

    // Final save on page unload
    window.addEventListener('beforeunload', this.boundBeforeUnload);
  }

  /**
   * Register the candidate providers and wire the pointer / `Tab` input.
   *
   * Two providers today. The element one wraps `raycastVisible` untouched, so
   * element selection cannot regress through this route; the measurement one
   * is a screen-space pass over the drawn line and markers — never the label
   * (D9) — which is why `raycastVisible` can go on filtering measurements out
   * and nothing about the existing pick path has to change.
   */
  private setupCandidateSystem(): void {
    const viewer = this.viewer;
    const canvas = viewer.getCanvas();

    this.candidateResolver.register({
      kind: 'element',
      candidatesAt: (cursor) =>
        elementCandidatesAt(
          {
            camera: viewer.getCamera(),
            scene: viewer.getScene(),
            renderer: viewer.getRenderer(),
            canvas,
          },
          cursor,
        ),
      // No `pick`: SelectionManager owns the element click, modifier keys and
      // all. Routing it through here would leak selection modes into a generic
      // resolver for no gain.
    });

    this.candidateResolver.register({
      kind: 'measurement',
      candidatesAt: (cursor) => this.measurementTool.candidatesAt(cursor),
      pick: (candidate, mode) => {
        const id = measurementPayload(candidate)?.measurementId;
        if (!id) return;
        // Element and measurement selections never coexist, so the element one
        // goes even when Ctrl is adding to the measurement selection.
        this.selectionManager.clear();
        this.measurementTool.selectMeasurement(id, mode);
      },
      highlight: (candidate) =>
        this.measurementTool.setHovered(
          candidate ? (measurementPayload(candidate)?.measurementId ?? null) : null,
        ),
    });

    this.candidateInput = new CandidateInput({
      canvas,
      resolver: this.candidateResolver,
      // The same ownership gates every other pointer path honours. A second
      // pick path that ignores them is how gestures start fighting — the
      // lesson the orbit work already paid for.
      canPick: () =>
        this.toolManager.getActiveTool() === null &&
        !viewer.isPivotPicking() &&
        !this.marqueeSelector.isDragging(),
      showHover: () => this.settings.get('hoverPreHighlight'),
      // Dormant until there is something to arbitrate: with no measurements
      // placed there is only one candidate kind, so the hover raycast — the
      // expensive part on a 100k-mesh model — never runs.
      isActive: () => this.measurementTool.hasMeasurements(),
      requestRender: () => viewer.requestRender(),
    });

    // Flipping the hover setting has to take effect without moving the mouse.
    this.settings.onChange(() => this.candidateInput?.refresh());
    // A measurement that disappears must not leave its highlight behind.
    this.measurementTool.onStateChange(() => this.candidateInput?.refresh());
    // D6 — persist measurements alongside the models and the basket.
    this.measurementTool.onStateChange(() => this.scheduleSave());
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
      measurements: this.measurementTool.serialize(),
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
              this.sceneBounds.addMeshes(id, batch);
            });
            this.modelManager.endStream(id);
            this.modelTreePanel.addModel(id, stored.name, parsed.meshCount);
            this.bufferCache.set(id, stored.buffer);
            this.registerModel(id, {
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
            this.sceneBounds.removeModel(stored.id);
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
        // A restore starts with the page, as the `?stats` surface counts it.
        const timeline = new LoadTimeline(0);
        try {
          this.setStatus(`Restoring ${record.name}...`);
          timeline.mark('main.restoreStarted');
          let stored = await this.sessionStore.getModel(record.id);
          timeline.mark('main.ifcFromIdb');

          // Fallback: UUID mismatch (e.g. after migration) — find by name
          if (!stored) {
            const byName = allStored.find(m => m.name === record.name);
            if (byName) {
              console.warn(`SessionStore: UUID miss for "${record.name}", found by name`);
              stored = byName;
            }
          }

          if (stored) {
            // Buffer is available — try the geometry cache first. It is read
            // part by part, each appended as it arrives, so even a model with
            // gigabytes of geometry fills in progressively and is never held
            // twice. Meanwhile the worker opens the model for properties (no
            // geometry): a `getProps` simply queues behind that open.
            let restored = false;
            const cached = record.hash ? await this.geometryCache.open(record.hash) : null;
            timeline.mark('main.cacheIndex');
            if (cached) {
              void this.parser.openForProperties(stored.buffer, record.id).catch((err) => {
                console.warn(`Worker openForProperties failed for ${record.id}:`, err);
              });
              this.modelManager.beginStream(record.id);
              let pieces = 0;
              const ok = await cached.read((meshes) => {
                if (pieces === 0) {
                  timeline.mark('main.firstPart');
                  // Show the first part where the user left the camera.
                  if (session?.camera) this.viewer.restoreCameraState(session.camera);
                }
                timeline.time('main.append', () => this.modelManager.appendMeshes(record.id, meshes));
                timeline.time('main.bounds', () => this.sceneBounds.addMeshes(record.id, meshes));
                pieces += meshes.length;
              }, (span, ms) => timeline.add(span, ms));
              if (ok) {
                timeline.time('main.finish', () => this.modelManager.endStream(record.id));
                this.modelTreePanel.addModel(record.id, record.name, pieces, record.source.type);
                this.bufferCache.set(record.id, stored.buffer);
                this.registerModel(record.id, { ...record, hasCachedBuffer: true });
                timeline.mark('main.settled');
                this.emitLoadSettled({
                  name: record.name, source: 'restore', ok: true,
                  meshCount: pieces, fromCache: true, phases: timeline.toJSON(),
                });
                restored = true;
              } else {
                // Unreadable entry (already removed): drop what came in, close
                // the properties-only model, and parse instead.
                this.modelManager.removeModel(record.id);
                this.sceneBounds.removeModel(record.id);
                this.parser.disposeModel(record.id);
              }
            }
            if (!restored) {
              // Cache miss — full streamed parse; the workers store the
              // geometry as they go, so the *next* restore is fast. Also
              // rescues sessions saved before the cache existed (no hash).
              this.modelManager.beginStream(record.id);
              const cacheKey = this.cacheKeyFor(record.id);
              const parsed = await this.parser.parseStreaming(
                stored.buffer, record.id, (batch) => {
                  timeline.mark('main.firstBatch');
                  timeline.time('main.append', () => this.modelManager.appendMeshes(record.id, batch));
                  timeline.time('main.bounds', () => this.sceneBounds.addMeshes(record.id, batch));
                },
                timeline,
                { cacheKey },
              );
              timeline.mark('main.streamed');
              timeline.absorbWorker(parsed.timings);
              timeline.time('main.finish', () => this.modelManager.endStream(record.id));
              this.modelTreePanel.addModel(record.id, record.name, parsed.meshCount);
              this.bufferCache.set(record.id, stored.buffer);
              const hashPromise = record.hash ? Promise.resolve(record.hash) : sha256Hex(stored.buffer);
              this.commitCache(cacheKey, hashPromise, parsed.cache);
              const hash = await hashPromise;
              this.registerModel(record.id, { ...record, hasCachedBuffer: true, hash });
              timeline.mark('main.settled');
              this.emitLoadSettled({
                name: record.name, source: 'restore', ok: true,
                meshCount: parsed.meshCount, fromCache: false, phases: timeline.toJSON(),
              });
            }            // Fix the IndexedDB key to match the session UUID
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
            this.modelTreePanel.setModelWarning(
              record.id,
              this.sessionStore.isStorageBlocked()
                ? 'Close the viewer’s other tabs, then reload to restore'
                : 'File missing — re-upload to restore',
            );
          }
        } catch (err) {
          // skip models that fail to restore — drop any partial stream
          this.modelManager.removeModel(record.id);
          this.sceneBounds.removeModel(record.id);
          this.emitLoadSettled({
            name: record.name, source: 'restore', ok: false, meshCount: 0, fromCache: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
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

    // Rehydrate measurements (D6) AFTER models restore — same rationale as the
    // basket, but stricter: a measurement is two world points, and world
    // points only mean something with the geometry they were taken from. The
    // store drops any whose models did not all come back.
    if (session?.measurements?.length) {
      this.measurementTool.deserialize(
        session.measurements,
        new Set(this.modelManager.getModelIds()),
      );
    }

    // Restore camera after fitToBox so it overrides the auto-fit
    if (session?.camera) {
      this.viewer.restoreCameraState(session.camera);
    }

    // Clear out cache parts no entry points at (a load that failed or was
    // closed mid-way). After the restore, so it never competes with it.
    void this.geometryCache.sweep();
  }

  private enqueueLoad(file: LoadedFile, source?: ModelSource): void {
    this.loadChain = this.loadChain
      .then(() => this.handleFile(file, source))
      .catch(() => {}); // errors handled inside handleFile
  }

  private async handleFile(file: LoadedFile, source?: ModelSource): Promise<void> {
    const endLoad = this.loadGate.begin();
    try {
      await this.loadFile(file, source);
    } finally {
      endLoad();
    }
  }

  private async loadFile(file: LoadedFile, source?: ModelSource): Promise<void> {
    // Tracks an in-progress streamed load so the catch block can drop a
    // partially-built model if the parse fails. Null before the stream
    // starts and once it completes.
    let streamId: string | null = null;
    // Set once the workers may be writing cache parts for this load.
    let cacheKey: string | undefined;
    const timeline = new LoadTimeline(file.readStartedAt ?? performance.now());
    if (file.readEndedAt !== undefined) timeline.mark('main.read', file.readEndedAt);
    timeline.mark('main.handled');
    try {
      // Reject duplicate filenames
      for (const existing of this.modelRecords.values()) {
        if (existing.name === file.name) {
          this.setStatus(`${file.name} is already loaded`);
          this.clearStatusAfter(3000);
          // Settled, as a load that did not happen: whoever waits for this
          // load (the `?stats` surface, the bench) hears about it.
          this.emitLoadSettled({
            name: file.name, source: 'file', ok: false, meshCount: 0, fromCache: false,
            error: 'already loaded',
          });
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
      // The workers store the geometry in the cache as they stream it, when
      // it will be kept (memory on); see `commitCache`.
      cacheKey = this.cacheKeyFor(id);
      const parsed = await this.parser.parseStreaming(file.buffer, id, (batch, progress) => {
        timeline.mark('main.firstBatch');
        timeline.time('main.append', () => this.modelManager.appendMeshes(id, batch));
        timeline.time('main.bounds', () => this.sceneBounds.addMeshes(id, batch));
        totalElements = progress.loaded;
        this.setStatus(loadingStatus(file.name, progress));
        // Fit once, on the first batch, so the camera frames the model
        // early and the progressive fill is actually visible. We do NOT
        // re-fit at the end: the load is interactive now, and a late fit
        // would yank a camera the user may already be orbiting.
        if (!framed) {
          framed = true;
          this.viewer.fitToBox(this.modelManager.getBoundingBox());
        }
      }, timeline, { cacheKey });
      timeline.mark('main.streamed');
      timeline.absorbWorker(parsed.timings);
      timeline.time('main.finish', () => this.modelManager.endStream(id));
      streamId = null;
      this.commitCache(cacheKey, hashPromise, parsed.cache);
      cacheKey = undefined; // commitCache owns it now
      const hash = await hashPromise;
      timeline.mark('main.hashed');

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

      this.registerModel(id, record);
      this.bufferCache.set(id, file.buffer);
      // Adding a model invalidates undo history references (U2) — clear it so
      // a pre-existing selection-undo can't restore against the new geometry.
      this.history.clear();
      this.modelTreePanel.addModel(
        id, file.name, parsed.meshCount,
        modelSource.type,
      );

      this.setStatus(`Loaded ${file.name} (${totalElements.toLocaleString()} elements)`);
      this.clearStatusAfter(3000);
      timeline.mark('main.settled');
      this.emitLoadSettled({
        name: file.name, source: 'file', ok: true, meshCount: parsed.meshCount, fromCache: false,
        phases: timeline.toJSON(),
      });

      // Persist to IndexedDB if memory is enabled. After the load has
      // settled: the model is on screen and usable, and writing a large
      // file (0.8 s for 357 MB) is no reason to keep saying "Loading". The
      // next queued load still waits for it.
      if (this.sessionStore.isMemoryEnabled()) {
        await this.sessionStore.saveModel(id, file.name, file.buffer);
        // Force an immediate session save (not debounced) so the record
        // is in localStorage even if the user refreshes right away
        this.sessionStore.saveSession(this.buildSessionState());
      }
    } catch (err) {
      // A streamed load that failed partway leaves an empty/partial model
      // and an open stream — drop both (removeModel also clears the stream).
      // Whatever parts the workers wrote will never be an entry.
      if (cacheKey) void this.geometryCache.discard(cacheKey);
      if (streamId) {
        this.modelManager.removeModel(streamId);
        this.sceneBounds.removeModel(streamId);
      }
      const msg = err instanceof Error ? err.message : 'Unknown error';
      // Out of memory, in whatever shape, becomes one plain sentence.
      this.setStatus(loadErrorStatus(err));
      this.emitLoadSettled({
        name: file.name, source: 'file', ok: false, meshCount: 0, fromCache: false, error: msg,
      });
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
      const ids = await this.similarIds(query, (done, total) => this.setStatus(`Finding ${query.label}… ${done} / ${total}`));
      const identities = identitiesFromIds(query, ids);
      if (identities.length > 0) {
        this.selectionManager.selectExactly(identities);
      }
      this.setStatus(describeSimilarResult(query, identities.length));
      this.clearStatusAfter(STATUS_CLEAR_MS);
    } catch (err) {
      // Superseded by a newer query — the user moved on, not an error.
      if (err instanceof BulkRequestCancelled) return;
      console.error('App: select similar failed', err);
      this.setStatus('Could not complete the search');
      this.clearStatusAfter(STATUS_CLEAR_MS);
    }
  }

  /** Newest pick of a value wins: an older one finishing later never selects. */
  private readonly selectValueRequests = new Latest();

  /** The ids a select-similar query finds in its model (worker side). */
  private similarIds(query: SimilarQuery, onProgress?: (done: number, total: number) => void): Promise<number[]> {
    return query.kind === 'class'
      ? this.propertyRepository.enumerateExpressIds(query.modelId, query.ifcTypeCode)
      : this.propertyRepository.findMatching(query.modelId, query.ifcTypeCode, query.selector, query.value, onProgress);
  }

  /**
   * The Parameters list's "select the elements with this value", read from
   * the parameter's value column: the elements of the scope the list
   * counted whose value is `value`, compared the way the list counted it —
   * so the count shown next to the value is the number selected. The column
   * is built once (usually already, when the row was opened); every later
   * pick is a scan of a typed array on this thread, with the worker free.
   * Like select-similar, hidden elements are selected too.
   *
   * `additive` (Ctrl/Shift) adds to the selection through the ordinary
   * `applyMany('add')`, which keeps the single-model lock; otherwise the
   * result replaces the selection through `selectExactly`, one undo step.
   */
  private async selectParameterValue(
    modelId: string,
    parameter: ParameterSummary,
    value: ParameterValue,
    additive: boolean,
    /** For a mixed-unit parameter: the unit of the value picked. Only values in it are selected. */
    valueUnit?: UnitRef,
  ): Promise<void> {
    const key = parameter.key;
    // An inspector reduction for the previous selection would only hold up
    // the column behind it in the worker's queue.
    this.propertyRepository.cancelBulk();
    const symbol = valueUnit ? valueUnit.symbol : parameter.unit;
    const unit = typeof value === 'number' && symbol ? ` ${symbol}` : '';
    const query = { label: `${key.slice(key.lastIndexOf('.') + 1)} = ${valueText(value)}${unit}` };
    this.setStatus(`Finding ${query.label}…`);
    // A Ctrl/Shift pick adds to the ones before it, so it does not outdate them.
    const ticket = additive ? this.selectValueRequests.current() : this.selectValueRequests.next();
    try {
      // Urgent: a column built in case goes ahead of any other background
      // work now that someone is waiting on it, and is no longer given up.
      const column = await this.propertyRepository.getColumn(
        modelId,
        key,
        (done, total) => this.setStatus(`Finding ${query.label}… ${done} / ${total}`),
        { urgent: true },
      );
      // A newer pick, or the model closed meanwhile: this one is out of date.
      if (!this.selectValueRequests.isLatest(ticket) || !this.modelManager.getModel(modelId)) return;
      const ids = columnIdsWithValue(column, value, valueUnit?.key);
      // The class of each match is not known here: the inspector fills it in,
      // as it does for an all-products select-similar.
      const identities = ids.map((expressId) => ({ modelId, expressId, ifcClass: '', ifcTypeCode: 0 }));
      if (identities.length > 0) {
        if (additive) this.selectionManager.applyMany('add', identities);
        else this.selectionManager.selectExactly(identities);
      }
      this.setStatus(describeSimilarResult(query, identities.length));
      this.clearStatusAfter(STATUS_CLEAR_MS);
    } catch (err) {
      if (err instanceof BulkRequestCancelled) return;
      console.error('App: select parameter value failed', err);
      this.setStatus('Could not complete the search');
      this.clearStatusAfter(STATUS_CLEAR_MS);
    }
  }

  // ── Show only (#70) ────────────────────────────────────────

  /**
   * Show only these elements and hide the rest, through the same path as
   * Isolate (one undo step). While something is hidden it narrows what is
   * shown; `additive` (Ctrl/Shift) shows them as well. The status line says
   * what happened, and the tray's "Show N hidden" is the way back.
   */
  private showOnlyElements(
    elements: readonly { modelId: string; expressId: number }[],
    label: string,
    additive: boolean,
  ): void {
    void this.showOnlyQueued(label, additive, async () => elements);
  }

  /** Hide the rest now, and say what happened. */
  private applyShowOnly(
    elements: readonly { modelId: string; expressId: number }[],
    label: string,
    additive: boolean,
  ): void {
    const start = performance.now();
    const result = this.appearanceManager.showOnly(elements, additive ? 'add' : 'narrow');
    // Readable from the page (`performance.getEntriesByName('show-only')`) for measuring.
    performance.measure('show-only', { start });
    this.setStatus(showOnlyStatus(label, result, additive));
    this.clearStatusAfter(STATUS_CLEAR_MS);
  }

  /**
   * The Parameters list's eye: show only the elements with `value`, in
   * every loaded model that has the parameter. The list's own model reads
   * it exactly as selecting does; another model matches only in the same
   * unit key, and not at all when the unit is not stated (ADR 4). Another
   * model's parameters are described first if they never were.
   */
  private async showOnlyParameterValue(
    modelId: string,
    parameter: ParameterSummary,
    value: ParameterValue,
    additive: boolean,
    valueUnit?: UnitRef,
  ): Promise<void> {
    const key = parameter.key;
    const symbol = valueUnit ? valueUnit.symbol : parameter.unit;
    const unit = typeof value === 'number' && symbol ? ` ${symbol}` : '';
    const label = `${key.slice(key.lastIndexOf('.') + 1)} = ${valueText(value)}${unit}`;
    const crossKey = crossModelUnitKey(parameter, value, valueUnit);
    await this.showOnlyFound(label, additive, async (m) => {
      if (m !== modelId) {
        if (crossKey === null) return [];
        const described = await this.propertyRepository.describeParameters(m, this.modelManager.elementIds(m));
        if (!described.parameters.some((p) => p.key === key)) return [];
      }
      const column = await this.propertyRepository.getColumn(m, key, undefined, { urgent: true });
      return columnIdsWithValue(column, value, m === modelId ? valueUnit?.key : (crossKey ?? undefined));
    });
  }

  /**
   * The right-click menu's "Show only this category / type": what
   * select-similar would find, in every loaded model. A class and a
   * predefined type, or a type name within a class, mean the same in any
   * model (the class's type code is the schema's), so the query is run in
   * each. Elements without geometry are not drawn and not counted.
   */
  private async showOnlySimilar(query: SimilarQuery): Promise<void> {
    await this.showOnlyFound(query.label, false, (m) => this.similarIds({ ...query, modelId: m }));
  }

  /**
   * Newest show-only wins: a plain one outdates every earlier one still
   * searching; a Ctrl/Shift one joins them and lands after them.
   */
  private readonly showOnlyRequests = new Latest();
  private readonly showOnlyOrder = new InOrder();

  /**
   * Search every loaded model (after any load, so a model still loading is
   * searched rather than wholly hidden) and show only what was found.
   */
  private showOnlyFound(
    label: string,
    additive: boolean,
    search: (modelId: string) => Promise<readonly number[]>,
  ): Promise<void> {
    this.propertyRepository.cancelBulk();
    this.setStatus(`Finding ${label}…`);
    return this.showOnlyQueued(label, additive, () =>
      findAcrossModels(
        {
          idle: () => this.loadGate.idle(),
          models: () => this.modelManager.getModelIds(),
          isLoaded: (m) => !!this.modelManager.getModel(m),
        },
        search,
      ),
    );
  }

  /** Show only what `find` gives, unless a newer show-only has outdated it by then. */
  private async showOnlyQueued(
    label: string,
    additive: boolean,
    find: () => Promise<readonly { modelId: string; expressId: number }[]>,
    waitForEarlier = additive,
  ): Promise<void> {
    const ticket = additive ? this.showOnlyRequests.current() : this.showOnlyRequests.next();
    try {
      await this.showOnlyOrder.run(
        find,
        (found) => {
          if (this.showOnlyRequests.isLatest(ticket)) this.applyShowOnly(found, label, additive);
        },
        waitForEarlier,
      );
    } catch (err) {
      if (err instanceof BulkRequestCancelled || !this.showOnlyRequests.isLatest(ticket)) return;
      console.error('App: show only failed', err);
      this.setStatus('Could not complete the search');
      this.clearStatusAfter(STATUS_CLEAR_MS);
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
        hasColouring: this.colourBy.isActive(),
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
        showOnlySimilarCategory: () => {
          if (!similar) return;
          void this.showOnlySimilar(categoryQuery(similar));
        },
        showOnlySimilarType: () => {
          if (!similar) return;
          const query = typeQuery(similar);
          if (query) void this.showOnlySimilar(query);
        },
        colourBy: () => void this.openColourPicker(x, y, state),
        clearColours: () => this.colourBy.clear(),
        refreshColours: () => this.colourBy.refresh(),
        totals: () => this.parametersPanel.openTotals(),
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

  // ── Totals (#69) ───────────────────────────────────────────

  /** What the totals cover: the selection, or everything visible when nothing is selected. */
  private totalsScope(): TotalsScope {
    const state = this.selectionManager.getState();
    if (state.kind === 'none') return { kind: 'visible' };
    const elements = new Map<string, number[]>();
    for (const { modelId, expressId } of state.identities) {
      let ids = elements.get(modelId);
      if (!ids) elements.set(modelId, (ids = []));
      ids.push(expressId);
    }
    return { kind: 'selection', elements };
  }

  // ── Colour by parameter (#68) ──────────────────────────────

  /**
   * What a colouring covers (see `colourScopeFor`): with two or more
   * elements selected, the selection; otherwise the whole of `modelId`.
   * From the Parameters list (`onlyThisModel`), only the list's model.
   */
  private colourScope(modelId: string, onlyThisModel: boolean): ColourScope {
    const state = this.selectionManager.getState();
    return colourScopeFor(state.kind === 'none' ? [] : state.identities, modelId, onlyThisModel);
  }

  /**
   * "Colour by parameter…" from the right-click menu: a searchable list of
   * the clicked element's own parameters, each with its value, at the
   * menu's position.
   */
  private async openColourPicker(x: number, y: number, state: SelectionState): Promise<void> {
    if (state.kind === 'none') return;
    const first = state.identities[0];
    let rows: PickerRow[];
    try {
      const props = await this.propertyRepository.get(first.modelId, first.expressId);
      // One row per parameter: the first at its path, as discovery and the
      // value columns read it.
      const seen = new Set<string>();
      rows = [];
      for (const r of props.flat) {
        if (seen.has(r.path)) continue;
        seen.add(r.path);
        rows.push({ key: r.path, value: r.unit ? `${r.displayValue} ${r.unit}` : r.displayValue });
      }
    } catch (err) {
      console.error('App: reading parameters for colouring failed', err);
      this.setStatus('Could not read the parameters of this element');
      this.clearStatusAfter(STATUS_CLEAR_MS);
      return;
    }
    const scope = this.colourScope(first.modelId, false);
    const n = state.identities.length;
    const heading = scope.kind === 'model' ? 'Colour the whole model by' : `Colour the ${n.toLocaleString('en-US')} selected by`;
    this.parameterPicker.open(x, y, heading, rows, (key) => void this.colourBy.colourBy(key, scope));
  }

  // ── Appearance actions (D) ─────────────────────────────────
  //
  // Each wraps an AppearanceManager op on the current-selection Scope. The
  // precedence hidden > transparent > highlighted > base holds in the
  // renderer itself (independent per-element flags), so nothing needs
  // reconciling afterwards.

  /** The Scope these verbs act on = the current live selection. */
  private selectionScope(): import('../inspector/types').Scope {
    const state = this.selectionManager.getState();
    return state.kind === 'none' ? [] : state.identities;
  }

  private appearanceHide(): void {
    this.appearanceManager.hide(this.selectionScope());
  }

  private appearanceIsolate(): void {
    this.appearanceManager.isolate(this.selectionScope());
  }

  private appearanceShowAll(): void {
    this.appearanceManager.showAll();
  }

  private appearanceTransparent(): void {
    this.appearanceManager.transparent(this.selectionScope());
  }

  private appearanceOpaque(): void {
    this.appearanceManager.opaque(this.selectionScope());
  }

  private appearanceClearTransparency(): void {
    this.appearanceManager.clearTransparency();
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

  /**
   * The centre mark shows only while flying with the mouse captured. In the
   * drag-to-look fallback clicks land under the cursor, so a mark in the
   * middle would point at the wrong place: it is hidden there.
   */
  private updateCentreMark(): void {
    if (this.viewer.isFlying() && this.viewer.getFlyLook() === 'mouse') this.centreMark.show();
    else this.centreMark.hide();
  }

  /** On a short window the key list would cover the centre mark: fold it there. */
  private fitFlyTips(): void {
    if (!this.viewer.isFlying()) return;
    // Clear of the ring (12 px radius) with a little room.
    this.flyTips.fitAbove(this.viewer.getViewCentre().y - 20);
  }

  /** Raycast once at the centre (the same pick the hover uses) and tell the mark. */
  private probeCentreMark(fast: boolean): void {
    if (!this.centreMark.isShown()) return;
    const canvas = this.viewer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const centre = this.viewer.getViewCentre();
    const [candidate] = elementCandidatesAt(
      { camera: this.viewer.getCamera(), scene: this.viewer.getScene(), renderer: this.viewer.getRenderer(), canvas },
      { x: centre.x - rect.left, y: centre.y - rect.top },
    );
    const hit = candidate ? elementHit(candidate) : null;
    const element = hit ? elementOfHit(hit) : null;
    this.centreMark.setMoving(fast);
    if (!element) {
      this.centreMark.setTarget(null);
      return;
    }
    const { modelId, expressId } = element;
    this.centreMark.setTarget({
      key: `${modelId}:${expressId}`,
      // Once per rested element; the repository memoises the read.
      name: async (signal) => {
        if (!this.propertyRepository) return null;
        const props = await this.propertyRepository.get(modelId, expressId);
        return signal.aborted ? null : elementTagLabel(props.identity);
      },
    });
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
    this.positionTool.clearMarkers();
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
    // The same for a colouring by parameter: its columns are of models
    // about to be closed.
    this.colourBy?.clear();
    this.parameterPicker?.close();
    // resetView tears down and re-adds every model; the undo history's
    // references won't survive that, so clear it (U2). (The selectionManager
    // .clear() above ran while history was still live; clearing now drops any
    // command it pushed, which is what we want for a full reset.)
    this.history.clear();

    // Every model is closed and parsed again below: what the panel shows
    // would be of models that no longer exist.
    this.parametersPanel?.close();
    for (const id of this.modelManager.getModelIds()) this.totals?.onModelRemoved(id);
    const endLoad = this.loadGate.begin();

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
      this.sceneBounds.removeModel(id);
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
          this.sceneBounds.addMeshes(id, batch);
        });
        this.modelManager.endStream(id);
        this.modelTreePanel.addModel(id, record.name, parsed.meshCount, record.source.type);
      } catch {
        // skip files that fail to re-parse — drop any partial stream
        this.modelManager.removeModel(id);
        this.sceneBounds.removeModel(id);
      }
    }

    endLoad();

    const box = this.modelManager.getBoundingBox();
    this.viewer.fitToBox(box);
    this.setStatus('');
  }

  /** The internals the `?stats` debug surface measures. Not for features. */
  debugHandles(): DebugHandles {
    return {
      viewer: this.viewer,
      modelManager: this.modelManager,
      onLoadSettled: (cb) => {
        this.loadSettledListeners.push(cb);
      },
    };
  }

  /**
   * A key for the workers to store this load's geometry under, or undefined
   * when nothing is kept (memory off, or no private file system).
   */
  private cacheKeyFor(id: string): string | undefined {
    if (!this.sessionStore.isMemoryEnabled() || !partFilesSupported()) return undefined;
    return this.geometryCache.newKey(id);
  }

  /**
   * Once the workers have stored every part and the file's hash is known,
   * make the parts the cache entry for that file — or drop them if a write
   * failed. Runs after the load has settled; the user never waits for it.
   */
  private commitCache(
    cacheKey: string | undefined,
    hash: Promise<string>,
    written: Promise<CacheWriteReport> | undefined,
  ): void {
    if (!cacheKey || !written) return;
    void Promise.all([hash, written])
      .then(([h, report]) => this.geometryCache.commit(h, cacheKey, report))
      .catch(() => this.geometryCache.discard(cacheKey));
  }

  private emitLoadSettled(event: LoadSettledEvent): void {
    for (const cb of this.loadSettledListeners) cb(event);
  }

  /**
   * Clear the status after `ms`, unless another message has replaced it by
   * then: a message's clearing never wipes a newer one early.
   */
  /** Store a completely loaded model's record and let the Parameters picker see it (#113). */
  private registerModel(id: string, record: ModelRecord): void {
    registerModel(this.modelRecords, id, record, () => this.parametersPanel?.refreshModels());
  }

  private clearStatusAfter(ms: number): void {
    this.statusTimer.clearAfter(ms);
  }

  /** Tells status messages apart, so a clearing only clears its own. */
  private readonly statusTimer = new StatusTimer(() => this.setStatus(''));

  private setStatus(text: string): void {
    this.statusTimer.shown();
    // While storage is blocked, an otherwise empty status keeps saying so.
    if (text === '' && this.sessionStore?.isStorageBlocked()) text = STORAGE_BLOCKED_STATUS;
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private showUploadPrompt(show: boolean): void {
    const prompt = document.getElementById('upload-prompt');
    if (prompt) prompt.style.display = show ? 'flex' : 'none';
  }

  /**
   * @param source Who chose this URL. `'link'` means it arrived in a shared
   *   link and was authored by someone else, so it is held to public https
   *   only; `'user'` means they typed it and may point at their own network.
   */
  async loadFromUrl(url: string, source: UrlSource = 'user'): Promise<void> {
    const safety = checkRemoteUrl(url, source);
    if (!safety.ok) {
      this.urlInput.showMessage(safety.reason, 'error');
      return;
    }

    const { normalizeUrl } = await import('../loader/urlNormalizer');
    const { url: normalized } = normalizeUrl(url);
    await this.handleRemoteLoad(normalized);
  }

  private async handleRemoteLoad(url: string, token?: string): Promise<void> {
    // Last gate before the fetch, and the only one every path passes through
    // — `UrlInput` submits here directly, without going via `loadFromUrl`.
    // Checked at `'user'` strictness because a link-sourced URL has already
    // met the stricter bar above; what this catches is the scheme, so no
    // path can reach `fetch` with `javascript:`, `data:` or `file:`.
    const safety = checkRemoteUrl(url, 'user');
    if (!safety.ok) {
      this.urlInput.showMessage(safety.reason, 'error');
      return;
    }

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
    if (this.parametersPanel) this.parametersPanel.dispose();
    if (this.colourLegend) this.colourLegend.dispose();
    if (this.parameterPicker) this.parameterPicker.dispose();
    if (this.totals) this.totals.dispose();
    this.visibleCounts?.dispose();
    if (this.totalsView) this.totalsView.dispose();
    this.marqueeSelector.dispose();
    // Before toolManager.dispose (which disposes the measurement tool), so the
    // resolver's providers still point at live objects while they unhook.
    if (this.candidateInput) this.candidateInput.dispose();
    this.settings.dispose();
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
