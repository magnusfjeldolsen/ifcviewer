import * as THREE from 'three';

/**
 * The bookkeeping half of the measurement tool: what measurements exist, which
 * models they belong to, which one is selected, and which are visible.
 *
 * Split out of `MeasurementTool` because that class needs a WebGLRenderer and
 * a 2D canvas context (for the label sprite) and so cannot be constructed in
 * jsdom — the same reason `orbitMath.ts` and `PivotState.ts` sit beside
 * `Viewer.ts`. Everything that decides *what should happen* lives here and is
 * unit-tested; `MeasurementTool` only draws the consequences.
 *
 * Records are an ordered array with stable ids, which is all a Solibri-style
 * measurements list panel would need if it is ever wanted (D5 left that open).
 */

export interface MeasurementRecord {
  /** Stable for the lifetime of the measurement, including across a reload. */
  id: string;
  start: THREE.Vector3;
  end: THREE.Vector3;
  /**
   * The models the two endpoints were picked from — one id when both ends are
   * on the same model, two when the measurement spans models. Drives D15
   * (follow the model) and the D6 restore filter. Empty only for a record
   * built without model attribution, which stays permanently visible.
   */
  modelIds: string[];
}

/** The wire form persisted in the session (D6). Plain JSON, no THREE types. */
export interface SerializedMeasurement {
  id: string;
  start: [number, number, number];
  end: [number, number, number];
  modelIds: string[];
}

export class MeasurementStore {
  private records: MeasurementRecord[] = [];
  private selectedId: string | null = null;
  /** Models the user has switched off in the model tree (D15). */
  private hiddenModels = new Set<string>();
  private listeners: Array<() => void> = [];

  // ── Reads ──────────────────────────────────────────────────

  list(): readonly MeasurementRecord[] {
    return this.records;
  }

  size(): number {
    return this.records.length;
  }

  get(id: string): MeasurementRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  /**
   * D15, stricter rule: a measurement spanning two models is hidden while
   * EITHER model is hidden. A number on screen that refers to something the
   * user cannot see is worse than no number.
   */
  isVisible(record: MeasurementRecord): boolean {
    return record.modelIds.every((id) => !this.hiddenModels.has(id));
  }

  // ── Mutations ──────────────────────────────────────────────

  /**
   * Record a new measurement. `modelIds` is deduplicated so a same-model
   * measurement carries one id rather than the same id twice.
   */
  add(start: THREE.Vector3, end: THREE.Vector3, modelIds: readonly string[]): MeasurementRecord {
    const record: MeasurementRecord = {
      id: newId(),
      start: start.clone(),
      end: end.clone(),
      modelIds: [...new Set(modelIds)],
    };
    this.records.push(record);
    this.notify();
    return record;
  }

  /** Remove one measurement. Returns whether anything was removed. */
  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === before) return false;
    if (this.selectedId === id) this.selectedId = null;
    this.notify();
    return true;
  }

  /** Remove everything. No-op (and no notification) when already empty. */
  clear(): boolean {
    if (this.records.length === 0 && this.selectedId === null) return false;
    this.records = [];
    this.selectedId = null;
    this.notify();
    return true;
  }

  /**
   * Select a measurement so `Delete` knows what to take, or `null` to
   * deselect. Selecting an id that is not present clears the selection rather
   * than storing a dangling reference.
   */
  select(id: string | null): void {
    const next = id !== null && this.get(id) ? id : null;
    if (next === this.selectedId) return;
    this.selectedId = next;
    this.notify();
  }

  /** `Delete` / `Backspace`: drop the selected measurement, if any. */
  removeSelected(): boolean {
    return this.selectedId === null ? false : this.remove(this.selectedId);
  }

  /**
   * D15 — a model was removed, so every measurement that referenced it goes
   * with it. A spanning measurement is dropped when either of its models goes:
   * half a measurement is not a measurement.
   */
  onModelRemoved(modelId: string): boolean {
    this.hiddenModels.delete(modelId);
    const survivors = this.records.filter((r) => !r.modelIds.includes(modelId));
    if (survivors.length === this.records.length) return false;
    this.records = survivors;
    if (this.selectedId !== null && !this.get(this.selectedId)) this.selectedId = null;
    this.notify();
    return true;
  }

  /**
   * D15 — a model was hidden or shown in the model tree. Notifies whenever the
   * set changes, because `MeasurementTool` has to re-evaluate every group's
   * visibility (a measurement can span this model and another).
   */
  setModelVisible(modelId: string, visible: boolean): void {
    const had = this.hiddenModels.has(modelId);
    if (visible === !had) return;
    if (visible) this.hiddenModels.delete(modelId);
    else this.hiddenModels.add(modelId);
    this.notify();
  }

  // ── Session persistence (D6) ───────────────────────────────

  serialize(): SerializedMeasurement[] {
    return this.records.map((r) => ({
      id: r.id,
      start: [r.start.x, r.start.y, r.start.z],
      end: [r.end.x, r.end.y, r.end.z],
      modelIds: [...r.modelIds],
    }));
  }

  /**
   * Restore measurements from a session, dropping any whose models did not
   * come back (D6). World coordinates only mean something with the same
   * geometry loaded, so a measurement without its model is not restorable —
   * and restoring it anyway would leave a number floating in space.
   *
   * Replaces the current contents. Returns the records that survived.
   */
  deserialize(
    entries: readonly SerializedMeasurement[],
    liveModelIds: ReadonlySet<string>,
  ): readonly MeasurementRecord[] {
    this.records = entries
      .filter((e) => e.modelIds.length > 0 && e.modelIds.every((id) => liveModelIds.has(id)))
      .map((e) => ({
        id: e.id,
        start: new THREE.Vector3(...e.start),
        end: new THREE.Vector3(...e.end),
        modelIds: [...e.modelIds],
      }));
    this.selectedId = null;
    this.notify();
    return this.records;
  }

  // ── Notification ───────────────────────────────────────────

  /**
   * Fires on every content, selection or visibility change. Same surface as
   * `ClippingTool.onStateChange` and for the same consumer: the
   * contextual-action tray needs to know when to offer "Clear measurements".
   */
  onChange(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  dispose(): void {
    this.listeners = [];
    this.records = [];
    this.selectedId = null;
    this.hiddenModels.clear();
  }

  private notify(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

/**
 * `crypto.randomUUID` is what the model records already use, but it is absent
 * from insecure origins and older embedded webviews, and a measurement id only
 * has to be unique within one session's store.
 */
function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
