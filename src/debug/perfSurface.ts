/**
 * The `?stats` performance surface: an on-screen readout plus a scripting hook
 * on `window.__ifcPerf` that `npm run bench` (bench/run.mjs) drives.
 *
 * Loaded only when the page URL carries `?stats` — main.ts imports this module
 * dynamically, so without the parameter none of it is downloaded, nothing is
 * measured and the render loop does not even read the clock.
 *
 * Times are `performance.now()` milliseconds in the page. A load opened from
 * the file input starts at the input's `change` event (so reading the file
 * into memory counts); a model brought back by session restore starts at
 * navigation (time 0).
 */
import * as THREE from 'three';
import type { DebugHandles, LoadSettledEvent } from '../core/App';
import { computeFitPosition } from '../viewer/cameraUtils';
import { raycastVisible } from '../utils/raycast';
import { StatsOverlay } from './StatsOverlay';
import {
  intervals,
  median,
  ndcFootprint,
  type ScreenRect,
  orbitPositions,
  percentile,
  screenGrid,
  summarizeFrames,
  type FrameSummary,
} from './perfMath';

export interface LoadRecord extends LoadSettledEvent {
  startedAt: number;
  /** First frame drawn with any of this load's geometry in it; null if none. */
  firstGeometryAt: number | null;
  settledAt: number;
}

export interface RenderInfo {
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
  meshes: number;
}

export interface OrbitResult extends FrameSummary {
  distanceScale: number;
  renderCpuMedianMs: number;
  renderCpuP95Ms: number;
  wallMs: number;
  info: RenderInfo;
  near: number;
  far: number;
}

export interface PickResult {
  /** The screen area the grid covered (CSS px): the model's footprint by default. */
  area: ScreenRect;
  samples: number;
  hits: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  /** Median over the samples that hit something; NaN when none did. */
  hitMedianMs: number;
  firstMs: number;
  times: number[];
}

export interface PerfSurface {
  loads: LoadRecord[];
  /** Resolves once `count` loads have settled (ok or failed). */
  waitForLoads(count: number): Promise<LoadRecord[]>;
  info(): RenderInfo;
  /** Draw one frame now and report what it cost. */
  render(): Promise<{ renderCpuMs: number; info: RenderInfo }>;
  orbit(options?: { frames?: number; distanceScale?: number; warmupFrames?: number }): Promise<OrbitResult>;
  /**
   * Time `raycastVisible` at screen points (CSS px). By default a 5×5 grid over
   * where the model's bounding box lands on screen; `area: 'screen'` spreads
   * it over the whole canvas instead.
   */
  pick(options?: {
    points?: Array<{ x: number; y: number }>;
    cols?: number;
    rows?: number;
    repeat?: number;
    area?: 'model' | 'screen';
  }): PickResult;
  camera(): { near: number; far: number; position: number[]; fov: number; aspect: number };
  model(): { meshes: number; boundingSphere: { center: number[]; radius: number } | null; box: { min: number[]; max: number[] } | null };
  gpu(): { vendor: string; renderer: string; pixelRatio: number; drawingBuffer: [number, number] };
  heap(): { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } | null;
}

declare global {
  interface Window {
    __ifcPerf?: PerfSurface;
  }
}

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

export function installPerfSurface(handles: DebugHandles): PerfSurface {
  const { viewer, modelManager } = handles;
  const renderer = viewer.getRenderer();
  const canvas = viewer.getCanvas();

  const countMeshes = (): number => {
    let n = 0;
    for (const entry of modelManager.getAllModels()) n += entry.group.children.length;
    return n;
  };

  const info = (): RenderInfo => ({
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    points: renderer.info.render.points,
    lines: renderer.info.render.lines,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs?.length ?? 0,
    meshes: countMeshes(),
  });

  // ── Frame bookkeeping ──────────────────────────────────────
  const recentFrames: number[] = [];
  let lastRenderCpuMs: number | null = null;
  let lastInfo = { drawCalls: 0, triangles: 0, meshes: 0 };
  type Recorder = (t: number, cpuMs: number) => void;
  const recorders = new Set<Recorder>();

  // ── Load bookkeeping ───────────────────────────────────────
  const loads: LoadRecord[] = [];
  const waiters: Array<{ count: number; resolve: (l: LoadRecord[]) => void }> = [];
  let pending: { startedAt: number; baselineMeshes: number; firstGeometryAt: number | null } = {
    // Session restore starts with the page.
    startedAt: 0,
    baselineMeshes: 0,
    firstGeometryAt: null,
  };

  let settledBeforeDrawn: { record: LoadRecord; baseline: number } | null = null;

  const fileInput = document.getElementById('file-input');
  fileInput?.addEventListener(
    'change',
    () => {
      pending = { startedAt: performance.now(), baselineMeshes: countMeshes(), firstGeometryAt: null };
    },
    { capture: true },
  );

  viewer.onRendered((t, cpuMs) => {
    recentFrames.push(t);
    while (recentFrames.length > 240) recentFrames.shift();
    lastRenderCpuMs = cpuMs;
    lastInfo = {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      meshes: countMeshes(),
    };
    if (pending.firstGeometryAt === null && lastInfo.meshes > pending.baselineMeshes) {
      pending.firstGeometryAt = t;
    }
    if (settledBeforeDrawn && lastInfo.meshes > settledBeforeDrawn.baseline) {
      settledBeforeDrawn.record.firstGeometryAt = t;
      settledBeforeDrawn = null;
    }
    for (const r of recorders) r(t, cpuMs);
  });

  handles.onLoadSettled((event) => {
    const record: LoadRecord = {
      ...event,
      startedAt: pending.startedAt,
      firstGeometryAt: pending.firstGeometryAt,
      settledAt: performance.now(),
    };
    loads.push(record);
    // A restore from the geometry cache adds every mesh at once and settles
    // before the next frame; its first geometry is that next frame.
    if (event.ok && record.firstGeometryAt === null) {
      settledBeforeDrawn = { record, baseline: pending.baselineMeshes };
    }
    pending = { startedAt: performance.now(), baselineMeshes: countMeshes(), firstGeometryAt: null };
    for (const w of [...waiters]) {
      if (loads.length >= w.count) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(loads.slice());
      }
    }
  });

  const appEl = document.getElementById('app') ?? document.body;
  new StatsOverlay(appEl, () => ({
    frames: recentFrames,
    lastRenderCpuMs,
    drawCalls: lastInfo.drawCalls,
    triangles: lastInfo.triangles,
    meshes: lastInfo.meshes,
  }));

  /** Where the loaded model's bounding box lands on screen, in CSS pixels. */
  const modelFootprint = (width: number, height: number): ScreenRect | null => {
    const box = modelManager.getBoundingBox();
    if (box.isEmpty()) return null;
    const camera = viewer.getCamera();
    const corners: Array<{ x: number; y: number; z: number }> = [];
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const p = new THREE.Vector3(x, y, z).project(camera);
          corners.push({ x: p.x, y: p.y, z: p.z });
        }
      }
    }
    return ndcFootprint(corners, width, height);
  };

  const surface: PerfSurface = {
    loads,

    waitForLoads(count) {
      if (loads.length >= count) return Promise.resolve(loads.slice());
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },

    info,

    async render() {
      let cpu = NaN;
      const rec: Recorder = (_t, ms) => {
        cpu = ms;
      };
      recorders.add(rec);
      try {
        viewer.requestRender();
        // The viewer draws in its own rAF callback; two frames covers either order.
        await nextFrame();
        await nextFrame();
      } finally {
        recorders.delete(rec);
      }
      return { renderCpuMs: cpu, info: info() };
    },

    async orbit(options = {}) {
      const frames = options.frames ?? 360;
      const distanceScale = options.distanceScale ?? 1;
      const warmup = options.warmupFrames ?? 10;
      const fit = computeFitPosition(modelManager.getBoundingBox());
      if (!fit) throw new Error('No model loaded to orbit');

      const path = orbitPositions(fit.center, fit.position, frames, distanceScale);
      const target = { x: fit.center.x, y: fit.center.y, z: fit.center.z };
      const saved = viewer.getCameraState();
      const stamps: number[] = [];
      const cpu: number[] = [];
      const rec: Recorder = (t, ms) => {
        stamps.push(t);
        cpu.push(ms);
      };

      let started: number;
      try {
        // `restoreCameraState` is the one public way to set a pose. It hands
        // the camera to the user mode (OrbitControls polls, nothing tweens),
        // and the anchor it sets — the model centre — is exactly what the
        // camera looks at, so it stays on the forward axis.
        for (let i = 0; i < warmup; i++) {
          viewer.restoreCameraState({ position: path[0], target });
          await nextFrame();
        }
        recorders.add(rec);
        started = performance.now();
        for (const position of path) {
          viewer.restoreCameraState({ position, target });
          await nextFrame();
        }
        // Let the last pose draw.
        await nextFrame();
      } finally {
        recorders.delete(rec);
        viewer.restoreCameraState(saved);
      }
      const wallMs = performance.now() - started;
      const camera = viewer.getCamera();
      const summary = summarizeFrames(intervals(stamps));
      const result: OrbitResult = {
        ...summary,
        distanceScale,
        renderCpuMedianMs: median(cpu),
        renderCpuP95Ms: percentile(cpu, 95),
        wallMs,
        info: info(),
        near: camera.near,
        far: camera.far,
      };
      // The restored pose needs its own frame.
      viewer.requestRender();
      return result;
    },

    pick(options = {}) {
      const rect = canvas.getBoundingClientRect();
      const camera = viewer.getCamera();
      camera.updateMatrixWorld();
      const area =
        options.area === 'screen' ? null : modelFootprint(rect.width, rect.height);
      const points =
        options.points ??
        screenGrid(
          area ?? { left: 0, top: 0, width: rect.width, height: rect.height },
          options.cols ?? 5,
          options.rows ?? 5,
        );
      const repeat = options.repeat ?? 1;
      const scene = viewer.getScene();
      const ndc = new THREE.Vector2();
      const times: number[] = [];
      const hitTimes: number[] = [];
      let hits = 0;
      for (let r = 0; r < repeat; r++) {
        for (const p of points) {
          ndc.set((p.x / rect.width) * 2 - 1, -(p.y / rect.height) * 2 + 1);
          const t0 = performance.now();
          const hit = raycastVisible(ndc, camera, scene, renderer);
          const dt = performance.now() - t0;
          times.push(dt);
          if (hit) {
            hits++;
            hitTimes.push(dt);
          }
        }
      }
      return {
        area: area ?? { left: 0, top: 0, width: rect.width, height: rect.height },
        samples: times.length,
        hits,
        medianMs: median(times),
        p95Ms: percentile(times, 95),
        maxMs: times.length ? Math.max(...times) : NaN,
        hitMedianMs: median(hitTimes),
        firstMs: times[0] ?? NaN,
        times,
      };
    },

    camera() {
      const c = viewer.getCamera();
      return { near: c.near, far: c.far, position: c.position.toArray(), fov: c.fov, aspect: c.aspect };
    },

    model() {
      const box = modelManager.getBoundingBox();
      if (box.isEmpty()) return { meshes: countMeshes(), boundingSphere: null, box: null };
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      return {
        meshes: countMeshes(),
        boundingSphere: { center: sphere.center.toArray(), radius: sphere.radius },
        box: { min: box.min.toArray(), max: box.max.toArray() },
      };
    },

    gpu() {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      return {
        vendor: String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
        renderer: String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
        pixelRatio: renderer.getPixelRatio(),
        drawingBuffer: [size.x, size.y],
      };
    },

    heap() {
      const mem = (performance as Performance & {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
      }).memory;
      return mem
        ? { usedJSHeapSize: mem.usedJSHeapSize, totalJSHeapSize: mem.totalJSHeapSize, jsHeapSizeLimit: mem.jsHeapSizeLimit }
        : null;
    },
  };

  window.__ifcPerf = surface;
  return surface;
}
