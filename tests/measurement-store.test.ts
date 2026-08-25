/**
 * `MeasurementStore` — the bookkeeping half of the measurement tool.
 *
 * `MeasurementTool` needs a WebGLRenderer and a 2D canvas context, so it has
 * no unit tests; everything that decides *what should happen* was split out
 * here so it does. Covered: the D5 removal contract (per-item delete plus a
 * global clear, and the tray predicate that drives the button), the D15
 * follow-the-model rules, and the D6 restore filter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { MeasurementStore } from '../src/tools/MeasurementStore';

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

describe('MeasurementStore', () => {
  let store: MeasurementStore;

  beforeEach(() => {
    store = new MeasurementStore();
  });

  describe('records', () => {
    it('starts empty', () => {
      expect(store.size()).toBe(0);
      expect(store.list()).toEqual([]);
      expect(store.getSelectedId()).toBeNull();
    });

    it('assigns a distinct id to every measurement', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['model-1']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['model-1']);
      expect(a.id).not.toBe(b.id);
      expect(store.get(a.id)).toBe(a);
    });

    it('copies the endpoints, so a reused raycast vector cannot move them', () => {
      // three reuses intersection vectors between raycasts.
      const start = v(1, 2, 3);
      const record = store.add(start, v(4, 5, 6), ['model-1']);
      start.set(9, 9, 9);
      expect(record.start.equals(v(1, 2, 3))).toBe(true);
    });

    it('deduplicates model ids, so a same-model measurement carries one', () => {
      const record = store.add(v(0, 0, 0), v(1, 0, 0), ['model-1', 'model-1']);
      expect(record.modelIds).toEqual(['model-1']);
    });

    it('keeps insertion order, which a list panel would need later', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['m']);
      const c = store.add(v(0, 0, 0), v(3, 0, 0), ['m']);
      expect(store.list().map((r) => r.id)).toEqual([a.id, b.id, c.id]);
    });
  });

  describe('removal (D5)', () => {
    it('removes exactly the named measurement and leaves the rest in order', () => {
      // The failure mode this fixes: six measurements, the fourth a misclick,
      // and the only escape being to redo all six.
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['m']);
      const c = store.add(v(0, 0, 0), v(3, 0, 0), ['m']);

      expect(store.remove(b.id)).toBe(true);
      expect(store.list().map((r) => r.id)).toEqual([a.id, c.id]);
    });

    it('reports false for an id it does not hold', () => {
      expect(store.remove('nope')).toBe(false);
    });

    it('clears the selection when the selected measurement is removed', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      store.select(a.id);
      store.remove(a.id);
      expect(store.getSelectedId()).toBeNull();
    });

    it('removeSelected drops the selected measurement, and nothing without one', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      expect(store.removeSelected()).toBe(false);
      store.select(a.id);
      expect(store.removeSelected()).toBe(true);
      expect(store.size()).toBe(0);
    });

    it('clear() empties the store and the selection', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      store.add(v(0, 0, 0), v(2, 0, 0), ['m']);
      store.select(a.id);

      expect(store.clear()).toBe(true);
      expect(store.size()).toBe(0);
      expect(store.getSelectedId()).toBeNull();
    });

    it('clear() on an empty store is a no-op', () => {
      expect(store.clear()).toBe(false);
    });
  });

  describe('selection', () => {
    it('selecting an unknown id clears rather than storing a dangling reference', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      store.select(a.id);
      store.select('ghost');
      expect(store.getSelectedId()).toBeNull();
    });

    it('select(null) deselects', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      store.select(a.id);
      store.select(null);
      expect(store.getSelectedId()).toBeNull();
    });
  });

  describe('following the model (D15)', () => {
    it('drops every measurement belonging to a removed model', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['model-a']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['model-b']);

      expect(store.onModelRemoved('model-a')).toBe(true);
      expect(store.list().map((r) => r.id)).toEqual([b.id]);
      expect(store.get(a.id)).toBeUndefined();
    });

    it('drops a two-model measurement when EITHER model is removed', () => {
      // Stricter rule: half a measurement is not a measurement.
      store.add(v(0, 0, 0), v(1, 0, 0), ['model-a', 'model-b']);
      store.onModelRemoved('model-b');
      expect(store.size()).toBe(0);
    });

    it('reports false when no measurement referenced the removed model', () => {
      store.add(v(0, 0, 0), v(1, 0, 0), ['model-a']);
      expect(store.onModelRemoved('model-z')).toBe(false);
    });

    it('hides a measurement while its model is hidden, and shows it again', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['model-a']);
      expect(store.isVisible(a)).toBe(true);

      store.setModelVisible('model-a', false);
      expect(store.isVisible(a)).toBe(false);

      store.setModelVisible('model-a', true);
      expect(store.isVisible(a)).toBe(true);
    });

    it('hides a two-model measurement while EITHER model is hidden', () => {
      const spanning = store.add(v(0, 0, 0), v(1, 0, 0), ['model-a', 'model-b']);
      store.setModelVisible('model-b', false);
      expect(store.isVisible(spanning)).toBe(false);

      store.setModelVisible('model-b', true);
      expect(store.isVisible(spanning)).toBe(true);
    });

    it('keeps a measurement without model attribution permanently visible', () => {
      const orphan = store.add(v(0, 0, 0), v(1, 0, 0), []);
      store.setModelVisible('model-a', false);
      expect(store.isVisible(orphan)).toBe(true);
    });
  });

  describe('session persistence (D6)', () => {
    it('round-trips ids, points and model ids', () => {
      const a = store.add(v(1, 2, 3), v(4, 5, 6), ['model-a']);
      const wire = store.serialize();
      expect(wire).toEqual([
        { id: a.id, start: [1, 2, 3], end: [4, 5, 6], modelIds: ['model-a'] },
      ]);

      const restored = new MeasurementStore();
      restored.deserialize(wire, new Set(['model-a']));
      const back = restored.list()[0];
      expect(back.id).toBe(a.id);
      expect(back.start.equals(v(1, 2, 3))).toBe(true);
      expect(back.end.equals(v(4, 5, 6))).toBe(true);
    });

    it('drops measurements whose model did not come back', () => {
      // World coordinates only mean something with the same geometry loaded.
      const wire = [
        { id: 'keep', start: [0, 0, 0] as [number, number, number], end: [1, 0, 0] as [number, number, number], modelIds: ['live'] },
        { id: 'drop', start: [0, 0, 0] as [number, number, number], end: [1, 0, 0] as [number, number, number], modelIds: ['gone'] },
      ];
      store.deserialize(wire, new Set(['live']));
      expect(store.list().map((r) => r.id)).toEqual(['keep']);
    });

    it('drops a spanning measurement unless BOTH its models came back', () => {
      const wire = [
        {
          id: 'spanning',
          start: [0, 0, 0] as [number, number, number],
          end: [1, 0, 0] as [number, number, number],
          modelIds: ['live', 'gone'],
        },
      ];
      store.deserialize(wire, new Set(['live']));
      expect(store.size()).toBe(0);
    });

    it('drops entries with no model attribution — nothing anchors them', () => {
      const wire = [
        {
          id: 'orphan',
          start: [0, 0, 0] as [number, number, number],
          end: [1, 0, 0] as [number, number, number],
          modelIds: [],
        },
      ];
      store.deserialize(wire, new Set(['live']));
      expect(store.size()).toBe(0);
    });
  });

  describe('change notification — the tray contract', () => {
    it('the tray predicate follows the contents', () => {
      // "Clear measurements" is visible only when there is something to clear.
      expect(store.size() > 0).toBe(false);
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      expect(store.size() > 0).toBe(true);
      store.remove(a.id);
      expect(store.size() > 0).toBe(false);
    });

    it('notifies on add, remove, select and visibility changes', () => {
      const cb = vi.fn();
      store.onChange(cb);

      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['model-a']);
      expect(cb).toHaveBeenCalledTimes(1);

      store.select(a.id);
      expect(cb).toHaveBeenCalledTimes(2);

      store.setModelVisible('model-a', false);
      expect(cb).toHaveBeenCalledTimes(3);

      store.remove(a.id);
      expect(cb).toHaveBeenCalledTimes(4);
    });

    it('stays quiet on no-op mutations, so the tray does not churn', () => {
      const cb = vi.fn();
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['model-a']);
      store.onChange(cb);

      store.remove('ghost');
      store.select(null);
      store.setModelVisible('model-a', true); // already visible
      expect(cb).not.toHaveBeenCalled();

      store.select(a.id);
      store.select(a.id); // already selected
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes cleanly', () => {
      const cb = vi.fn();
      const off = store.onChange(cb);
      off();
      store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
