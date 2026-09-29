import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MeasurementStore, type SerializedMeasurement } from '../src/tools/MeasurementStore';

/**
 * The record has to redraw itself after a reload without re-picking anything
 * — the geometry may come back in a different order, or the plane the
 * measurement was taken from may be on a model that did not return. So what
 * it looked like and what it measured both have to be in the record.
 */

const A = new THREE.Vector3(0, 0, 0);
const B = new THREE.Vector3(1, 0, 0);

describe('a measurement records how it was made', () => {
  it('defaults to a direct measurement between two plain points', () => {
    const store = new MeasurementStore();

    const record = store.add(A, B, ['m1']);

    expect(record.mode).toBe('direct');
    expect(record.startSnap.target).toBe('point');
    expect(record.endSnap.target).toBe('point');
  });

  it('records the snap target caught at each end', () => {
    const store = new MeasurementStore();

    const record = store.add(A, B, ['m1'], {
      startSnap: { target: 'vertex' },
      endSnap: { target: 'face' },
    });

    expect(record.startSnap.target).toBe('vertex');
    expect(record.endSnap.target).toBe('face');
  });

  it('records an orthogonal measurement as orthogonal', () => {
    const store = new MeasurementStore();

    const record = store.add(A, B, ['m1'], { mode: 'orthogonal' });

    expect(record.mode).toBe('orthogonal');
  });

  // An edge's direction is the one thing not recoverable from the two points,
  // and the glyph that shows which edge was caught needs it.
  it('keeps an edge’s direction, which the endpoints cannot imply', () => {
    const store = new MeasurementStore();

    const record = store.add(A, B, ['m1'], {
      startSnap: { target: 'edge', direction: new THREE.Vector3(0, 0, 1) },
    });

    expect(record.startSnap.direction?.z).toBeCloseTo(1, 6);
  });
});

describe('round-tripping through a session', () => {
  function roundTrip(
    build: (store: MeasurementStore) => void,
  ): readonly ReturnType<MeasurementStore['add']>[] {
    const store = new MeasurementStore();
    build(store);
    const wire = JSON.parse(JSON.stringify(store.serialize())) as SerializedMeasurement[];
    const restored = new MeasurementStore();
    return restored.deserialize(wire, new Set(['m1']));
  }

  it('brings back the mode', () => {
    const [record] = roundTrip((s) => s.add(A, B, ['m1'], { mode: 'orthogonal' }));

    expect(record.mode).toBe('orthogonal');
  });

  it('brings back both snap targets', () => {
    const [record] = roundTrip((s) =>
      s.add(A, B, ['m1'], { startSnap: { target: 'face' }, endSnap: { target: 'vertex' } }),
    );

    expect(record.startSnap.target).toBe('face');
    expect(record.endSnap.target).toBe('vertex');
  });

  it('brings back an edge direction as a real vector', () => {
    const [record] = roundTrip((s) =>
      s.add(A, B, ['m1'], {
        endSnap: { target: 'edge', direction: new THREE.Vector3(0, 1, 0) },
      }),
    );

    expect(record.endSnap.direction).toBeInstanceOf(THREE.Vector3);
    expect(record.endSnap.direction?.y).toBeCloseTo(1, 6);
  });

  // Sessions saved before snapping existed must still open.
  it('reads a record written before any of this existed', () => {
    const legacy: SerializedMeasurement[] = [
      { id: 'old', start: [0, 0, 0], end: [1, 0, 0], modelIds: ['m1'] },
    ];
    const store = new MeasurementStore();

    const [record] = store.deserialize(legacy, new Set(['m1']));

    expect(record.mode).toBe('direct');
    expect(record.startSnap.target).toBe('point');
    expect(record.endSnap.target).toBe('point');
  });
});
