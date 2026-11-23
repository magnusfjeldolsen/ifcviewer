import type { Settings } from '../services/Settings';
import type { SnapTarget } from './snapCandidates';

/**
 * Which snap targets the stored settings switch on, and the switch each
 * number key flips. Shared by every tool that places a point, through
 * `App`, and kept here rather than inline so the mapping can be tested
 * without building the app.
 */

/** The setting behind each target the user can switch, and what the status line calls it. */
export const SNAP_TARGET_SETTINGS = {
  vertex: { key: 'snapToVertices', name: 'Corners' },
  edge: { key: 'snapToEdges', name: 'Edges' },
  face: { key: 'snapToSurfaces', name: 'Surfaces' },
  centre: { key: 'snapToCentres', name: 'Round centres' },
} as const satisfies Partial<Record<SnapTarget, { key: string; name: string }>>;

type SnapSettings = Pick<Settings, 'get' | 'toggle'>;

/** The targets currently offered. The raw point always is: it is the fallback. */
export function allowedSnapTargets(settings: Pick<Settings, 'get'>): Set<SnapTarget> {
  const allowed = new Set<SnapTarget>(['point']);
  for (const [target, { key }] of Object.entries(SNAP_TARGET_SETTINGS)) {
    if (settings.get(key)) allowed.add(target as SnapTarget);
  }
  return allowed;
}

/**
 * Flip one target and say what happened, for the status line — or null for
 * a target that has no switch (the raw point).
 */
export function toggleSnapTarget(settings: SnapSettings, target: SnapTarget): string | null {
  if (target === 'point') return null;
  const { key, name } = SNAP_TARGET_SETTINGS[target];
  const on = settings.toggle(key);
  return `${name} ${on ? 'on' : 'off'}`;
}
