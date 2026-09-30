import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { measurementViews } from '../src/tools/measurementViews';
import type { MeasurementRecord } from '../src/tools/MeasurementStore';

/**
 * The mapping between what a measurement is and what it looks like. Extracted
 * from `MeasurementTool` so it can be tested without a WebGL context — the
 * renderer either side of it still cannot be.
 */

function record(id: string, modelIds: string[] = ['m1']): MeasurementRecord {
  return {
    id,
    start: new THREE.Vector3(0, 0, 0),
    end: new THREE.Vector3(1, 0, 0),
    modelIds,
    mode: 'direct',
    startSnap: { target: 'point' },
    endSnap: { target: 'point' },
  } as MeasurementRecord;
}

const allVisible = {
  isVisible: () => true,
  isSelected: () => false,
  hoveredId: null,
};

describe('measurementViews', () => {
  it('produces one view per record, in order', () => {
    const views = measurementViews([record('a'), record('b')], allVisible);

    expect(views.map((v) => v.id)).toEqual(['a', 'b']);
  });

  it('carries the endpoints through untouched', () => {
    const r = record('a');

    const [view] = measurementViews([r], allVisible);

    expect(view.start).toBe(r.start);
    expect(view.end).toBe(r.end);
  });

  it('marks only the selected one selected', () => {
    const views = measurementViews([record('a'), record('b')], {
      ...allVisible,
      isSelected: (id) => id === 'b',
    });

    expect(views.map((v) => v.selected)).toEqual([false, true]);
  });

  it('marks only the hovered one hovered', () => {
    const views = measurementViews([record('a'), record('b')], {
      ...allVisible,
      hoveredId: 'a',
    });

    expect(views.map((v) => v.hovered)).toEqual([true, false]);
  });

  it('reports visibility per record, not per id', () => {
    const shown = record('a', ['m1']);
    const hidden = record('b', ['m2']);

    const views = measurementViews([shown, hidden], {
      ...allVisible,
      isVisible: (r) => r.modelIds.includes('m1'),
    });

    expect(views.map((v) => v.visible)).toEqual([true, false]);
  });

  it('lets a measurement be selected and hovered at once', () => {
    const [view] = measurementViews([record('a')], {
      ...allVisible,
      isSelected: () => true,
      hoveredId: 'a',
    });

    expect(view.selected).toBe(true);
    expect(view.hovered).toBe(true);
  });

  it('returns nothing for no records', () => {
    expect(measurementViews([], allVisible)).toEqual([]);
  });

  it('carries what each end caught, which is what picks the glyph', () => {
    const r = record('a');
    r.startSnap = { target: 'face' };
    r.endSnap = { target: 'edge', direction: new THREE.Vector3(1, 0, 0) };

    const [view] = measurementViews([r], allVisible);

    expect(view.startSnap.target).toBe('face');
    expect(view.endSnap.target).toBe('edge');
    expect(view.endSnap.direction?.x).toBeCloseTo(1, 6);
  });
});
