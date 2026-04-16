export interface CameraState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

export interface StoredFile {
  name: string;
  buffer: ArrayBuffer;
}

export interface SessionState {
  camera?: CameraState;
  fileNames?: string[];
}

const TOGGLE_KEY = 'ifcviewer:memoryEnabled';
const SESSION_KEY = 'ifcviewer:session';
const DB_NAME = 'ifcviewer';
const DB_VERSION = 1;
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
    this.clearFiles().catch(() => {});
  }

  // ── IndexedDB file storage ───────────────────────────────

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          db.createObjectStore(FILES_STORE, { keyPath: 'name' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  async saveFile(name: string, buffer: ArrayBuffer): Promise<void> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(FILES_STORE, 'readwrite');
      tx.objectStore(FILES_STORE).put({ name, buffer });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // IndexedDB unavailable — silently degrade
    }
  }

  async getFiles(): Promise<StoredFile[]> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(FILES_STORE, 'readonly');
      const req = tx.objectStore(FILES_STORE).getAll();
      return await new Promise<StoredFile[]>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as StoredFile[]);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }

  async removeFile(name: string): Promise<void> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(FILES_STORE, 'readwrite');
      tx.objectStore(FILES_STORE).delete(name);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // silently degrade
    }
  }

  private async clearFiles(): Promise<void> {
    try {
      const db = await this.openDB();
      const tx = db.transaction(FILES_STORE, 'readwrite');
      tx.objectStore(FILES_STORE).clear();
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // silently degrade
    }
  }
}
