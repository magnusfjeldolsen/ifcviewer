// @vitest-environment jsdom
/**
 * Render-on-demand wiring tests.
 *
 * The Viewer's `requestRender` flag and `renderer.render` gate are
 * difficult to test directly because `THREE.WebGLRenderer` doesn't run
 * in jsdom. Instead we verify the callback wiring: each module that can
 * mutate visible state without moving the camera receives a
 * `requestRender` callback (or holds a `viewer` ref) and fires it on
 * mutation. If a future change drops a callback, these tests catch it.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { ModelManager } from '../src/viewer/ModelManager';
import type { ParsedModel } from '../src/parser/types';

function makeParsed(id: string, expressId = 1): ParsedModel {
  return {
    id,
    meshes: [
      {
        expressID: expressId,
        vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        color: { r: 1, g: 1, b: 1, a: 1 },
      },
    ],
  };
}

describe('ModelManager — render-on-demand wiring', () => {
  it('calls requestRender on addModel', () => {
    const requestRender = vi.fn();
    const mm = new ModelManager(new THREE.Scene(), requestRender);
    mm.addModel(makeParsed('a'));
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it('calls requestRender on removeModel', () => {
    const requestRender = vi.fn();
    const mm = new ModelManager(new THREE.Scene(), requestRender);
    mm.addModel(makeParsed('a'));
    requestRender.mockClear();
    mm.removeModel('a');
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it('does not call requestRender when removeModel hits a missing id', () => {
    const requestRender = vi.fn();
    const mm = new ModelManager(new THREE.Scene(), requestRender);
    mm.removeModel('does-not-exist');
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('calls requestRender on setVisible toggling visibility', () => {
    const requestRender = vi.fn();
    const mm = new ModelManager(new THREE.Scene(), requestRender);
    mm.addModel(makeParsed('a'));
    requestRender.mockClear();
    mm.setVisible('a', false);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it('omitting the callback is supported (backwards-compat)', () => {
    const mm = new ModelManager(new THREE.Scene());
    expect(() => mm.addModel(makeParsed('a'))).not.toThrow();
    expect(() => mm.removeModel('a')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CameraAnimator.onTick — verify it fires every animation frame
// ---------------------------------------------------------------------------

import { CameraAnimator, type FlyToParams } from '../src/viewer/CameraAnimator';

describe('CameraAnimator — onTick wiring', () => {
  it('fires onTick on each rAF tick of the animation', async () => {
    // jsdom provides requestAnimationFrame as a setTimeout shim, so the
    // animation actually runs end-to-end here.
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(0, 0, 10);
    const canvas = document.createElement('canvas');
    // Minimal OrbitControls stub: only target + update are touched per tick.
    const controls = {
      target: new THREE.Vector3(),
      update: () => { /* noop */ },
    } as unknown as FlyToParams['controls'];

    const onTick = vi.fn();
    const animator = new CameraAnimator();
    await animator.flyTo({
      camera,
      controls,
      canvas,
      targetPosition: new THREE.Vector3(5, 5, 5),
      targetLookAt: new THREE.Vector3(0, 0, 0),
      near: 0.1,
      far: 100,
      durationMs: 30, // short — keep test fast
      onTick,
    });

    // At minimum: the final tick (rawT === 1) should have called onTick.
    expect(onTick).toHaveBeenCalled();
  });
});
