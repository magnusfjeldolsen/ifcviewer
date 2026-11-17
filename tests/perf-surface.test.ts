// @vitest-environment jsdom
/**
 * The `?stats` surface's bookkeeping, against a stand-in viewer: what counts
 * as "first geometry", how a load is timed, and that a scripted orbit hands
 * the camera back the way it found it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { installPerfSurface } from '../src/debug/perfSurface';
import type { DebugHandles, LoadSettledEvent } from '../src/core/App';

type Rendered = (t: number, cpuMs: number) => void;

function makeHarness() {
  const rendered: Rendered[] = [];
  const settled: Array<(e: LoadSettledEvent) => void> = [];
  const group = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 1000);
  camera.position.set(5, 5, 5);
  let cameraState = { position: { x: 5, y: 5, z: 5 }, target: { x: 0, y: 0, z: 0 } };
  const restoreCameraState = vi.fn((s: typeof cameraState) => {
    cameraState = s;
    camera.position.set(s.position.x, s.position.y, s.position.z);
  });
  const renderer = {
    info: { render: { calls: 0, triangles: 0, points: 0, lines: 0 }, memory: { geometries: 0, textures: 0 }, programs: [] },
  };
  const viewer = {
    onRendered: (cb: Rendered) => {
      rendered.push(cb);
      return () => {};
    },
    getRenderer: () => renderer,
    getCanvas: () => document.createElement('canvas'),
    getCamera: () => camera,
    getScene: () => new THREE.Scene(),
    requestRender: vi.fn(),
    getCameraState: () => cameraState,
    restoreCameraState,
  };
  const modelManager = {
    getAllModels: () => [{ group }],
    getBoundingBox: () => new THREE.Box3().setFromObject(group),
  };
  const handles = {
    viewer,
    modelManager,
    onLoadSettled: (cb: (e: LoadSettledEvent) => void) => settled.push(cb),
  } as unknown as DebugHandles;

  const addMesh = () =>
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  const draw = (t: number, cpu = 1) => rendered.forEach((cb) => cb(t, cpu));
  const settle = (e: Partial<LoadSettledEvent> = {}) =>
    settled.forEach((cb) =>
      cb({ name: 'm.ifc', source: 'file', ok: true, meshCount: group.children.length, fromCache: false, ...e }),
    );
  return { handles, addMesh, draw, settle, restoreCameraState, getState: () => cameraState };
}

describe('installPerfSurface', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="app"><input type="file" id="file-input"></main>';
  });
  afterEach(() => {
    delete window.__ifcPerf;
    vi.useRealTimers();
  });

  it('exposes itself on window and draws an overlay', () => {
    const h = makeHarness();
    installPerfSurface(h.handles);
    expect(window.__ifcPerf).toBeDefined();
    expect(document.querySelector('.stats-overlay')).not.toBeNull();
  });

  it('times a file load from the input change to settle, with first geometry from the first frame that has any', () => {
    const h = makeHarness();
    const perf = installPerfSurface(h.handles);
    const now = vi.spyOn(performance, 'now');

    now.mockReturnValue(1000);
    document.getElementById('file-input')!.dispatchEvent(new Event('change'));
    h.draw(1010); // empty frame — not first geometry
    h.addMesh();
    h.draw(1500);
    h.addMesh();
    h.draw(1600);
    now.mockReturnValue(2000);
    h.settle();

    expect(perf.loads).toHaveLength(1);
    expect(perf.loads[0]).toMatchObject({ startedAt: 1000, firstGeometryAt: 1500, settledAt: 2000, ok: true });
    now.mockRestore();
  });

  it('fills in first geometry for a load that settles before its first frame (cache restore)', () => {
    const h = makeHarness();
    const perf = installPerfSurface(h.handles);
    h.addMesh();
    h.settle({ source: 'restore', fromCache: true });
    expect(perf.loads[0].startedAt).toBe(0);
    expect(perf.loads[0].firstGeometryAt).toBeNull();
    h.draw(700);
    expect(perf.loads[0].firstGeometryAt).toBe(700);
  });

  it('records a failed load and resolves waiters', async () => {
    const h = makeHarness();
    const perf = installPerfSurface(h.handles);
    const waiting = perf.waitForLoads(1);
    h.settle({ ok: false, error: 'boom', meshCount: 0 });
    const loads = await waiting;
    expect(loads[0]).toMatchObject({ ok: false, error: 'boom', firstGeometryAt: null });
  });

  it('orbits about the model centre and hands the camera back where it was', async () => {
    const h = makeHarness();
    h.addMesh();
    const perf = installPerfSurface(h.handles);
    const before = h.getState();

    let t = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      setTimeout(() => {
        t += 16;
        h.draw(t, 2);
        cb(t);
      }, 0);
      return 0;
    });
    try {
      const result = await perf.orbit({ frames: 8, warmupFrames: 2 });
      expect(result.frames).toBeGreaterThanOrEqual(7);
      expect(result.medianFrameMs).toBe(16);
      expect(result.renderCpuMedianMs).toBe(2);
      // Every pose looks at the centre; the last call puts the old pose back.
      const calls = h.restoreCameraState.mock.calls.map((c) => c[0]);
      expect(calls.slice(0, -1).every((s) => s.target.x === 0 && s.target.y === 0 && s.target.z === 0)).toBe(true);
      expect(calls[calls.length - 1]).toBe(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses to orbit with nothing loaded, and leaves the camera alone', async () => {
    const h = makeHarness();
    const perf = installPerfSurface(h.handles);
    await expect(perf.orbit()).rejects.toThrow(/No model/);
    expect(h.restoreCameraState).not.toHaveBeenCalled();
  });
});
