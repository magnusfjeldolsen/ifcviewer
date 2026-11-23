import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Settings } from '../src/services/Settings';
import { allowedSnapTargets, toggleSnapTarget } from '../src/tools/snapSettings';
import { SnapCursor } from '../src/tools/SnapCursor';
import type { SnapTarget } from '../src/tools/snapCandidates';

/**
 * Issue #63: `4` switches round-centre snaps on and off, alongside `1` `2` `3`.
 * The seam is the settings mapping the app hands every point-placing tool,
 * and the key handler in `SnapCursor` that calls it.
 */

function key(k: string): KeyboardEvent {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {} } as unknown as KeyboardEvent;
}

describe('snap settings', () => {
  it('offers round centres by default, with everything else', () => {
    expect([...allowedSnapTargets(new Settings())].sort()).toEqual(['centre', 'edge', 'face', 'point', 'vertex']);
  });

  it('switches round centres off and on again, and says so', () => {
    const settings = new Settings();
    expect(toggleSnapTarget(settings, 'centre')).toBe('Round centres off');
    expect(allowedSnapTargets(settings).has('centre')).toBe(false);
    // The others are left alone.
    expect(allowedSnapTargets(settings).has('vertex')).toBe(true);
    expect(toggleSnapTarget(settings, 'centre')).toBe('Round centres on');
    expect(allowedSnapTargets(settings).has('centre')).toBe(true);
  });

  it('has no switch for the raw point, which is always offered', () => {
    const settings = new Settings();
    expect(toggleSnapTarget(settings, 'point')).toBeNull();
    expect(allowedSnapTargets(settings).has('point')).toBe(true);
  });
});

describe('SnapCursor number keys', () => {
  it('maps 1 2 3 4 to corners, edges, surfaces and round centres', () => {
    const flipped: SnapTarget[] = [];
    const cursor = new SnapCursor({
      camera: new THREE.PerspectiveCamera(),
      canvas: {} as HTMLCanvasElement,
      onToggleSnapTarget: (target) => flipped.push(target),
    });
    for (const k of ['1', '2', '3', '4']) expect(cursor.onKeyDown(key(k))).toBe('toggled');
    expect(flipped).toEqual(['vertex', 'edge', 'face', 'centre']);
  });

  it('turns centres off through the same path the app wires up', () => {
    const settings = new Settings();
    const cursor = new SnapCursor({
      camera: new THREE.PerspectiveCamera(),
      canvas: {} as HTMLCanvasElement,
      onToggleSnapTarget: (target) => toggleSnapTarget(settings, target),
    });
    cursor.onKeyDown(key('4'));
    expect(allowedSnapTargets(settings).has('centre')).toBe(false);
  });
});
