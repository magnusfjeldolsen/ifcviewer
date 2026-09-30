import type * as THREE from 'three';
import type { MeasurementEnd, MeasurementRecord } from './MeasurementStore';

/**
 * The bridge between what a measurement *is* and what it *looks like*.
 *
 * `MeasurementStore` owns existence, selection and visibility.
 * `MeasurementRenderer` owns the scene. Neither knows about the other, and
 * this is the only thing that knows about both — a plain mapping with no
 * THREE objects built and no store methods called beyond the predicates it is
 * handed, which is what makes it the one part of the rendering path that can
 * be tested.
 */

/** One measurement, as the scene needs to know it. */
export interface MeasurementView {
  id: string;
  start: THREE.Vector3;
  end: THREE.Vector3;
  visible: boolean;
  selected: boolean;
  hovered: boolean;
  /** What each end caught, which decides the glyph drawn there. */
  startSnap: MeasurementEnd;
  endSnap: MeasurementEnd;
}

export interface MeasurementViewState {
  isVisible(record: MeasurementRecord): boolean;
  isSelected(id: string): boolean;
  /** The measurement the cursor is over, per the candidate system. */
  hoveredId: string | null;
}

export function measurementViews(
  records: readonly MeasurementRecord[],
  state: MeasurementViewState,
): MeasurementView[] {
  return records.map((record) => ({
    id: record.id,
    start: record.start,
    end: record.end,
    visible: state.isVisible(record),
    selected: state.isSelected(record.id),
    // Deliberately not gated on visibility, matching the behaviour this was
    // extracted from. A hidden measurement keeping its hover flag is invisible
    // anyway, and the candidate system only ever hovers visible ones — so
    // tightening it here would be a behaviour change smuggled into a refactor.
    hovered: state.hoveredId === record.id,
    startSnap: record.startSnap,
    endSnap: record.endSnap,
  }));
}
