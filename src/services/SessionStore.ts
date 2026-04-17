export interface CameraState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

export interface StoredFile {
  name: string;
  buffer: ArrayBuffer;
}

export type ModelSource =
  | { type: 'local'; fileName: string }
  | { type: 'remote'; url: string; fileName: string };

export interface ModelRecord {
  id: string;
  name: string;
  source: ModelSource;
  addedAt: number;
  sizeBytes: number;
  hasCachedBuffer: boolean;
}

export interface StoredModel {
  id: string;
  name: string;
  buffer: ArrayBuffer;
}

export interface SessionState {
  camera?: CameraState;
  /** @deprecated Use models instead */
  fileNames?: string[];
  models?: ModelRecord[];
}

const TOGGLE_KEY = 'ifcviewer:memoryEnabled';
const SESSION_KEY = 'ifcviewer:session';
const DB_NAME = 'ifcviewer';
const DB_VERSION = 2;
const MODELS_STORE = 'models';
/** @deprecated v1 store name, used only during migration */
const FILES_STORE = 'files';

export class SessionStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  isMemoryEnabled(): boolean {
    try {
      const val = localStorage.getItem(TOGGLE_KEY);
      if (val === null) return true; // default ON for first visit
      return val === 'true';
    } catch {
      return false;
    }
  }

  setMemoryEnabled(on: boolean): void {
    try {
      localStorage.setItem(TOGGLE_KEY, String(on));
    } catch {
      // localStorage unavailable — silently degrade
    }
  }

  getSession(): SessionState | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw === null) return null;
      return JSON.parse(raw) as SessionState;
    } catch {
      return null;
    }
  }

  saveSession(state: SessionState): void {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch {
      // localStorage unavailable — silently degrade
    }
  }

  clearSession(): void {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // localStorage unavailable — silently degrade
    }
    this.clearModels().catch(() => {});
  }

  // ── IndexedDB file storage ───────────────────────────────

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const oldVersion = event.oldVersion;

        if (oldVersion < 1) {
          // Fresh install — create v2 store directly
          db.createObjectStore(MODELS_STORE, { keyPath: 'id' });
        } else if (oldVersion < 2) {
          // Migrate v1 → v2: rename files → models with UUID keys
          // We can't read from the old store during upgrade, so we create
          // the new store and handle data migration after the DB opens
          if (!db.objectStoreNames.contains(MODELS_STORE)) {
            db.createObjectStore(MODELS_STORE, { keyPath: 'id' });
          }
          // Old store will be deleted after data migration
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Run v1 → v2 data migration if old files store still exists
        if (db.objectStoreNames.contains(FILES_STORE)) {
          this.migrateV1ToV2(db).then(() => resolve(db)).catch(() => resolve(db));
        } else {
          resolve(db);
        }
      };
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async migrateV1ToV2(db: IDBDatabase): Promise<void> {
    // Read all v1 files
    const readTx = db.transaction(FILES_STORE, 'readonly');
    const oldFiles = await new Promise<StoredFile[]>((resolve, reject) => {
      const req = readTx.objectStore(FILES_STORE).getAll();
      req.onsuccess = () => resolve(req.result as StoredFile[]);
      req.onerror = () => reject(req.error);
    });

    if (oldFiles.length > 0) {
      // Write to new models store with generated UUIDs
      const writeTx = db.transaction(MODELS_STORE, 'readwrite');
      const store = writeTx.objectStore(MODELS_STORE);
      const idMap = new Map<string, string>(); // name → uuid

      for (const file of oldFiles) {
        const id = crypto.randomUUID();
        idMap.set(file.name, id);
        store.put({ id, name: file.name, buffer: file.buffer });
      }

      await new Promise<void>((resolve, reject) => {
        writeTx.oncomplete = () => resolve();
        writeTx.onerror = () => reject(writeTx.error);
      });

      // Migrate session state: fileNames → models
      const session = this.getSession();
      if (session?.fileNames) {
        const models: ModelRecord[] = session.fileNames
          .filter(name => idMap.has(name))
          .map(name => ({
            id: idMap.get(name)!,
            name,
            source: { type: 'local' as const, fileName: name },
            addedAt: Date.now(),
            sizeBytes: oldFiles.find(f => f.name === name)?.buffer.byteLength ?? 0,
            hasCachedBuffer: true,
          }));
        this.saveSession({ camera: session.camera, models });
      }
    }

    // Delete old store requires a version bump — we can't do that here.
    // Instead, we'll just leave the old store empty and ignore it.
    // Clear it so it doesn't take up space.
    try {
      const clearTx = db.transaction(FILES_STORE, 'readwrite');
      clearTx.objectStore(FILES_STORE).clear();
      await new Promise<void>((resolve, reject) => {
        clearTx.oncomplete = () => resolve();
        clearTx.onerror = () => reject(clearTx.error);
      });
    } catch {
      // non-critical — old store just wastes a bit of space
    }
  }

  // ── Model storage (v2) ──────────────────────────────────

  async saveModel(id: string, name: string, buffer: ArrayBuffer): Promise<void> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(MODELS_STORE, 'readwrite');
      tx.objectStore(MODELS_STORE).put({ id, name, buffer } as StoredModel);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('SessionStore: failed to save model', err);
    }
  }

  async getModel(id: string): Promise<StoredModel | null> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(MODELS_STORE, 'readonly');
      const req = tx.objectStore(MODELS_STORE).get(id);
      return await new Promise<StoredModel | null>((resolve, reject) => {
        req.onsuccess = () => resolve((req.result as StoredModel) ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('SessionStore: failed to get model', err);
      return null;
    }
  }

  async getAllModels(): Promise<StoredModel[]> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(MODELS_STORE, 'readonly');
      const req = tx.objectStore(MODELS_STORE).getAll();
      return await new Promise<StoredModel[]>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as StoredModel[]);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('SessionStore: failed to get all models', err);
      return [];
    }
  }

  async removeModel(id: string): Promise<void> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(MODELS_STORE, 'readwrite');
      tx.objectStore(MODELS_STORE).delete(id);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('SessionStore: failed to remove model', err);
    }
  }

  // ── Legacy methods (v1 compat, delegate to v2) ──────────

  /** @deprecated Use saveModel instead */
  async saveFile(name: string, buffer: ArrayBuffer): Promise<void> {
    const id = crypto.randomUUID();
    await this.saveModel(id, name, buffer);
  }

  /** @deprecated Use getAllModels instead */
  async getFiles(): Promise<StoredFile[]> {
    const models = await this.getAllModels();
    return models.map(m => ({ name: m.name, buffer: m.buffer }));
  }

  /** @deprecated Use removeModel instead */
  async removeFile(name: string): Promise<void> {
    const models = await this.getAllModels();
    const match = models.find(m => m.name === name);
    if (match) await this.removeModel(match.id);
  }

  private async clearModels(): Promise<void> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(MODELS_STORE, 'readwrite');
      tx.objectStore(MODELS_STORE).clear();
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('SessionStore: failed to clear models', err);
    }
  }
}
