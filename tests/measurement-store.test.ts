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
      expect(store.getSelectedIds()).toEqual([]);
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
      store.applySelection(a.id);
      store.remove(a.id);
      expect(store.getSelectedIds()).toEqual([]);
    });

    it('removeSelected drops the selected measurement, and nothing without one', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      expect(store.removeSelected()).toBe(false);
      store.applySelection(a.id);
      expect(store.removeSelected()).toBe(true);
      expect(store.size()).toBe(0);
    });

    it('clear() empties the store and the selection', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      store.add(v(0, 0, 0), v(2, 0, 0), ['m']);
      store.applySelection(a.id);

      expect(store.clear()).toBe(true);
      expect(store.size()).toBe(0);
      expect(store.getSelectedIds()).toEqual([]);
    });

    it('clear() on an empty store is a no-op', () => {
      expect(store.clear()).toBe(false);
    });
  });

  describe('selection', () => {
    it('a plain click replaces the selection', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['m']);

      store.applySelection(a.id);
      store.applySelection(b.id);
      expect(store.getSelectedIds()).toEqual([b.id]);
    });

    it('Ctrl/Cmd+click adds to the selection', () => {
      // The user's report: "can't multi select by holding ctrl on measurement
      // lines". Mirrors SelectionManager's 'add' mode exactly.
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['m']);
      const c = store.add(v(0, 0, 0), v(3, 0, 0), ['m']);

      store.applySelection(a.id);
      store.applySelection(b.id, 'add');
      store.applySelection(c.id, 'add');
      expect(store.getSelectedIds()).toEqual([a.id, b.id, c.id]);
      expect(store.selectedCount()).toBe(3);
    });

    it('Ctrl/Cmd+click TOGGLES, so a mis-click undoes itself', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['m']);

      store.applySelection(a.id);
      store.applySelection(b.id, 'add');
      store.applySelection(b.id, 'add');
      expect(store.getSelectedIds()).toEqual([a.id]);
    });

    it('Shift+click removes without touching the rest', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['m']);

      store.applySelection(a.id);
      store.applySelection(b.id, 'add');
      store.applySelection(a.id, 'remove');
      expect(store.getSelectedIds()).toEqual([b.id]);
    });

    it('Shift+click on an unselected measurement is a no-op', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['m']);
      store.applySelection(a.id);
      store.applySelection(b.id, 'remove');
      expect(store.getSelectedIds()).toEqual([a.id]);
    });

    it('a plain click on an unknown id clears — click empty space to deselect', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      store.applySelection(a.id);
      store.applySelection('ghost');
      expect(store.getSelectedIds()).toEqual([]);
    });

    it('Ctrl+click on an unknown id leaves the selection alone', () => {
      // Never store a dangling reference, but never destroy a multi-selection
      // because one candidate went stale mid-gesture either.
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      store.applySelection(a.id);
      store.applySelection('ghost', 'add');
      expect(store.getSelectedIds()).toEqual([a.id]);
    });

    it('applySelection(null) deselects everything', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['m']);
      store.applySelection(a.id);
      store.applySelection(b.id, 'add');
      store.applySelection(null);
      expect(store.getSelectedIds()).toEqual([]);
    });

    it('isSelected answers for every member of a multi-selection', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['m']);
      const c = store.add(v(0, 0, 0), v(3, 0, 0), ['m']);
      store.applySelection(a.id);
      store.applySelection(c.id, 'add');

      expect(store.isSelected(a.id)).toBe(true);
      expect(store.isSelected(b.id)).toBe(false);
      expect(store.isSelected(c.id)).toBe(true);
    });
  });

  describe('deleting a multi-selection', () => {
    it('removeSelected takes every selected measurement at once', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['m']);
      const c = store.add(v(0, 0, 0), v(3, 0, 0), ['m']);

      store.applySelection(a.id);
      store.applySelection(c.id, 'add');
      expect(store.removeSelected()).toBe(true);

      expect(store.list().map((r) => r.id)).toEqual([b.id]);
      expect(store.getSelectedIds()).toEqual([]);
    });

    it('notifies exactly once for a multi-delete', () => {
      // One Delete keypress is one user gesture, so the tray refreshes once.
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['m']);
      store.applySelection(a.id);
      store.applySelection(b.id, 'add');

      const cb = vi.fn();
      store.onChange(cb);
      store.removeSelected();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('reports false with nothing selected', () => {
      store.add(v(0, 0, 0), v(1, 0, 0), ['m']);
      expect(store.removeSelected()).toBe(false);
    });

    it('drops a selected measurement from the selection when its model goes', () => {
      const a = store.add(v(0, 0, 0), v(1, 0, 0), ['model-a']);
      const b = store.add(v(0, 0, 0), v(2, 0, 0), ['model-b']);
      store.applySelection(a.id);
      store.applySelection(b.id, 'add');

      store.onModelRemoved('model-a');
      expect(store.getSelectedIds()).toEqual([b.id]);
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

      store.applySelection(a.id);
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
      store.applySelection(null);
      store.setModelVisible('model-a', true); // already visible
      expect(cb).not.toHaveBeenCalled();

      store.applySelection(a.id);
      store.applySelection(a.id); // already selected
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
