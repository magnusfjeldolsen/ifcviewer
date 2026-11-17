#!/usr/bin/env node
// Performance benchmark for the viewer — `npm run bench -- <model.ifc> [options]`.
//
// Opens the app in the locally installed Chrome (Playwright, channel 'chrome',
// headed, real GPU), loads one IFC file through the file input and measures:
//
//   cold load      time to first geometry on screen and to fully loaded, in a
//                  fresh browser profile
//   scene          meshes, draw calls per frame, triangles
//   orbit          a scripted 360° orbit about the model centre at fit-view
//                  distance and again zoomed in close: median fps, p95 frame
//                  time, CPU ms inside renderer.render
//   orbit, synced  the same two orbits with a 1-pixel readPixels after every
//                  frame, so each frame waits for the GPU to finish it: render
//                  CPU + GPU wait per frame. Once render CPU is small, an
//                  unthrottled run (vsync off) reports rAF rates the GPU never
//                  drew; the synced frame time is the honest one.
//   pick           a raycast pick at a 5×5 grid of screen points: median, p95
//   heap           main-thread JS heap after load (after a forced GC). The IFC
//                  worker's heap is NOT included, and neither are ArrayBuffer
//                  backing stores — which is where geometry lives.
//   process memory private bytes of this run's Chrome processes (Windows),
//                  sampled once a second: peak per process type (renderer —
//                  which also hosts the IFC worker — and gpu-process) and
//                  peak total, over the cold load and again over the whole run
//   warm load      the page reloaded in the same profile, so session restore
//                  brings the model back from IndexedDB — from the geometry
//                  cache when it holds the model (`fromCache` says which)
//   gpu            the WebGL renderer string, so you know which GPU ran
//
// It prints a summary and writes the full JSON to bench-results/ (gitignored).
//
// Options
//   --gpu integrated|discrete|default
//                  integrated passes --force_low_power_gpu, discrete passes
//                  --force_high_performance_gpu. Check `gpu.renderer` in the
//                  output: the run warns when it does not match.
//   --vsync on|off off (default) passes --disable-gpu-vsync and
//                  --disable-frame-rate-limit, so frame rates above the
//                  display's refresh are visible. `on` caps at the display rate,
//                  which is what a user sees.
//   --url <url>    attach to a server already running (e.g. `npm run dev`,
//                  http://localhost:5173/ifcviewer/) instead of building and
//                  starting `vite preview`
//   --no-build     serve the existing dist/ without rebuilding
//   --port <n>     port for `vite preview` (default 4173)
//   --label <name> name used in the result file (default: the file's basename).
//                  Use a neutral label for models that must stay private.
//   --viewport WxH CSS pixels (default 1280x720)
//   --dpr <n>      device pixel ratio (default 1.5: 1280x720 at 1.5 is a
//                  1920x1080 office-laptop screen at 150 % scaling)
//   --orbit-frames <n>   frames per orbit (default 360, one per degree)
//   --close-scale <f>    distance factor for the close orbit (default 0.3 of
//                        the fit distance)
//   --timeout-min <n>    give up waiting for a load after n minutes (default 30)
//   --no-warm      skip the reload-from-cache run
//   --no-orbit     skip the orbits (load times and memory only)
//   --profile      record a V8 CPU profile of the main thread during the fit
//                  orbit, save it as .cpuprofile (open in DevTools) and print
//                  the functions with the most self time. Function names are
//                  minified in a production build; attach to the dev server
//                  with --url to read them.
//
// Examples
//   npm run bench -- "assets/ifcs/Snowdon Towers Sample Structural.ifc" --gpu integrated
//   npm run bench -- path/to/model.ifc --gpu discrete --vsync on --label heavy
//
// The model file is handed to Chrome by path; Node never reads it.

import { chromium } from 'playwright-core';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ROOT, build, startPreview } from './server.mjs';

// ── Arguments ────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    model: null,
    gpu: 'integrated',
    vsync: 'off',
    url: null,
    build: true,
    port: 4173,
    label: null,
    viewport: [1280, 720],
    dpr: 1.5,
    orbitFrames: 360,
    closeScale: 0.3,
    timeoutMin: 30,
    warm: true,
    orbit: true,
    profile: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--gpu': opts.gpu = next(); break;
      case '--vsync': opts.vsync = next(); break;
      case '--url': opts.url = next(); break;
      case '--no-build': opts.build = false; break;
      case '--port': opts.port = Number(next()); break;
      case '--label': opts.label = next(); break;
      case '--viewport': opts.viewport = next().split('x').map(Number); break;
      case '--dpr': opts.dpr = Number(next()); break;
      case '--orbit-frames': opts.orbitFrames = Number(next()); break;
      case '--close-scale': opts.closeScale = Number(next()); break;
      case '--timeout-min': opts.timeoutMin = Number(next()); break;
      case '--no-warm': opts.warm = false; break;
      case '--no-orbit': opts.orbit = false; break;
      case '--profile': opts.profile = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
        if (opts.model) throw new Error('Give exactly one model file');
        opts.model = a;
    }
  }
  if (!opts.model) throw new Error('Usage: npm run bench -- <model.ifc> [--gpu integrated|discrete|default] [--vsync on|off] ...');
  if (!['integrated', 'discrete', 'default'].includes(opts.gpu)) throw new Error('--gpu must be integrated, discrete or default');
  if (!['on', 'off'].includes(opts.vsync)) throw new Error('--vsync must be on or off');
  return opts;
}

const GPU_ARGS = {
  integrated: ['--force_low_power_gpu'],
  discrete: ['--force_high_performance_gpu'],
  default: [],
};

// ── Helpers ──────────────────────────────────────────────────

const log = (...a) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...a);
const round = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : v ?? null);
const mb = (bytes) => (typeof bytes === 'number' ? round(bytes / 1048576, 1) : null);

/** Evaluate in the page, but give up after `ms` (the main thread may be busy). */
async function probe(page, fn, ms = 5000) {
  return Promise.race([
    page.evaluate(fn).catch((e) => ({ probeError: String(e.message ?? e) })),
    new Promise((r) => setTimeout(() => r({ probeError: `no answer in ${ms} ms` }), ms)),
  ]);
}

const statusProbe = () => ({
  loads: window.__ifcPerf?.loads.length ?? -1,
  status: document.getElementById('status')?.textContent ?? '',
  meshes: window.__ifcPerf?.info().meshes ?? 0,
  heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
});

/** Wait until `count` loads have settled, logging progress. */
async function waitForLoads(page, count, timeoutMs, events) {
  const start = Date.now();
  let lastLog = 0;
  for (;;) {
    if (events.crashed) throw new Error('The page crashed (renderer process died) while loading');
    const s = await probe(page, statusProbe, 5000);
    if (s.loads >= count) return;
    const elapsed = Date.now() - start;
    if (elapsed - lastLog >= 15000) {
      lastLog = elapsed;
      log(`  …${Math.round(elapsed / 1000)} s`, s.probeError ? `(page busy: ${s.probeError})` : `meshes=${s.meshes} heap=${s.heapMB} MB status="${s.status}"`);
      events.progress.push({ atS: Math.round(elapsed / 1000), ...s });
    }
    if (elapsed > timeoutMs) throw new Error(`Load did not finish within ${Math.round(timeoutMs / 60000)} min`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const geometryCacheCount = () =>
  new Promise((resolve) => {
    const req = indexedDB.open('ifcviewer');
    req.onerror = () => resolve(-1);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('geometry-cache')) {
        db.close();
        resolve(0);
        return;
      }
      const c = db.transaction('geometry-cache', 'readonly').objectStore('geometry-cache').count();
      c.onsuccess = () => {
        db.close();
        resolve(c.result);
      };
      c.onerror = () => {
        db.close();
        resolve(-1);
      };
    };
  });

function loadTimes(rec) {
  if (!rec) return null;
  return {
    ok: rec.ok,
    error: rec.error ?? null,
    source: rec.source,
    fromCache: rec.fromCache,
    meshCount: rec.meshCount,
    firstGeometryMs: rec.firstGeometryAt === null ? null : round(rec.firstGeometryAt - rec.startedAt, 0),
    // Settled and drawn: a cache restore settles a frame before it is drawn.
    loadedMs: round(Math.max(rec.settledAt, rec.firstGeometryAt ?? 0) - rec.startedAt, 0),
    phases: phaseTable(rec),
  };
}

/**
 * The load's timeline (src/core/LoadTimeline.ts) on the same clock as
 * `firstGeometryMs` / `loadedMs`: marks as ms from the load's start, in time
 * order, and spans as total ms.
 */
function phaseTable(rec) {
  const p = rec.phases;
  if (!p) return null;
  const offset = p.startedAt - rec.startedAt;
  const marks = Object.entries(p.marks)
    .map(([name, ms]) => [name, round(ms + offset, 0)])
    .sort((a, b) => a[1] - b[1]);
  if (rec.firstGeometryAt !== null) marks.push(['drawn.firstGeometry', round(rec.firstGeometryAt - rec.startedAt, 0)]);
  marks.sort((a, b) => a[1] - b[1]);
  const spans = Object.entries(p.spans).map(([name, ms]) => [name, round(ms, 0)]);
  return { marks: Object.fromEntries(marks), spans: Object.fromEntries(spans) };
}

function logPhases(title, phases) {
  if (!phases) return;
  log(`${title} — marks (ms from start):`);
  for (const [name, ms] of Object.entries(phases.marks)) log(`  ${String(ms).padStart(7)}  ${name}`);
  log(`${title} — time spent (ms, summed):`);
  for (const [name, ms] of Object.entries(phases.spans)) log(`  ${String(ms).padStart(7)}  ${name}`);
}

/** Aggregate a V8 CPU profile's self time by function, largest first. */
function topSelfTime(profile, n) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const dt = profile.timeDeltas[i] ?? 0;
    total += dt;
    const f = byId.get(id)?.callFrame;
    const key = f
      ? `${f.functionName || '(anonymous)'} ${f.url ? `${f.url.split('/').pop()}:${f.lineNumber + 1}` : ''}`.trim()
      : '?';
    self.set(key, (self.get(key) ?? 0) + dt);
  });
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([fn, us]) => ({ fn, ms: round(us / 1000, 0), pct: round((100 * us) / total, 1) }));
}

/**
 * Sample the private memory of this run's Chrome processes once a second
 * (Windows only) and keep the peaks. The JS heap figure excludes ArrayBuffer
 * backing stores — where geometry lives — and the GPU process, so this is the
 * number that says whether a model fits.
 *
 * One long-lived PowerShell loop rather than a process per sample, so the
 * sampling itself barely disturbs the frame-rate measurements.
 */
function startProcessMemorySampler(profileDir) {
  const peaks = { byType: {}, total: 0, samples: 0 };
  if (process.platform !== 'win32') return { peaks, stop: () => {} };
  const dir = profileDir.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $all = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"
  $root = $all | Where-Object { $_.CommandLine -like '*${dir}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
  if ($root) {
    $rows = $all | Where-Object { $_.ProcessId -eq $root.ProcessId -or $_.ParentProcessId -eq $root.ProcessId } | ForEach-Object {
      $t = 'browser'; if ($_.CommandLine -match '--type=([\\w-]+)') { $t = $Matches[1] }
      if ($t -eq 'utility' -and $_.CommandLine -match '--utility-sub-type=([\\w.]+)') { $t = 'utility:' + $Matches[1] }
      '{0}={1}' -f $t, $_.PrivatePageCount
    }
    [Console]::Out.WriteLine(($rows -join ';'))
  }
  Start-Sleep -Milliseconds 1000
}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const now = {};
      let total = 0;
      for (const part of line.split(';')) {
        const [type, bytes] = part.split('=');
        const v = Number(bytes);
        if (!Number.isFinite(v)) continue;
        // Several renderers or utilities: the biggest one is the one that matters.
        now[type] = Math.max(now[type] ?? 0, v);
        total += v;
      }
      for (const [type, v] of Object.entries(now)) peaks.byType[type] = Math.max(peaks.byType[type] ?? 0, v);
      peaks.total = Math.max(peaks.total, total);
      peaks.last = { ...now, total };
      peaks.samples++;
    }
  });
  return {
    peaks,
    stop: () => {
      if (child.exitCode === null) child.kill();
    },
  };
}

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const modelPath = path.resolve(opts.model);
  const fileBytes = statSync(modelPath).size;
  const label = opts.label ?? path.basename(modelPath, path.extname(modelPath));

  let server = null;
  let baseUrl = opts.url;
  if (!baseUrl) {
    if (opts.build) {
      log('Building…');
      build();
    }
    server = await startPreview(opts.port);
    baseUrl = server.url;
  }
  const appUrl = new URL(baseUrl);
  appUrl.searchParams.set('stats', '');

  const args = [
    ...GPU_ARGS[opts.gpu],
    ...(opts.vsync === 'off' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
    // A headed window that is covered by another one must keep drawing.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--enable-precise-memory-info',
    '--ignore-gpu-blocklist',
  ];

  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'ifcviewer-bench-'));
  const result = {
    meta: {
      label,
      fileMB: mb(fileBytes),
      date: new Date().toISOString(),
      commit: gitCommit(),
      gpuOption: opts.gpu,
      vsync: opts.vsync,
      viewport: opts.viewport,
      dpr: opts.dpr,
      url: appUrl.toString(),
      chromeArgs: args,
    },
    errors: [],
  };
  const events = { crashed: false, progress: [] };

  let context = null;
  const sampler = startProcessMemorySampler(profileDir);
  const memSnapshot = () => ({
    peakTotalMB: mb(sampler.peaks.total),
    peakByTypeMB: Object.fromEntries(Object.entries(sampler.peaks.byType).map(([k, v]) => [k, mb(v)])),
    nowMB: sampler.peaks.last ? Object.fromEntries(Object.entries(sampler.peaks.last).map(([k, v]) => [k, mb(v)])) : null,
    samples: sampler.peaks.samples,
  });
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: false,
      args,
      viewport: { width: opts.viewport[0], height: opts.viewport[1] },
      deviceScaleFactor: opts.dpr,
    });
    result.meta.chromeVersion = context.browser()?.version() ?? null;
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('crash', () => {
      events.crashed = true;
      result.errors.push({ kind: 'crash', atMs: Date.now() });
    });
    page.on('pageerror', (e) => result.errors.push({ kind: 'pageerror', text: String(e.message ?? e).slice(0, 500) }));
    page.on('console', (m) => {
      // The geometry cache reports evictions at info level.
      if (m.type() === 'error' || m.type() === 'warning' || /GeometryCache/.test(m.text())) {
        if (result.errors.length < 50) result.errors.push({ kind: `console.${m.type()}`, text: m.text().slice(0, 500) });
      }
    });
    page.on('worker', (w) => w.on('close', () => result.errors.push({ kind: 'worker-closed', url: w.url().slice(-60) })));

    // Answer the cookie question up front: the banner blurs the whole canvas.
    await page.addInitScript(() => localStorage.setItem('ifcviewer:cookieConsent', 'declined'));
    log(`Opening ${appUrl}`);
    await page.goto(appUrl.toString());
    await page.waitForFunction(() => !!window.__ifcPerf, null, { timeout: 30000 });
    result.gpu = await page.evaluate(() => window.__ifcPerf.gpu());
    log(`GPU: ${result.gpu.renderer}`);
    const want = { integrated: /intel/i, discrete: /nvidia|amd|radeon/i }[opts.gpu];
    result.meta.gpuMatched = want ? want.test(result.gpu.renderer) : null;
    if (want && !result.meta.gpuMatched) log(`WARNING: asked for the ${opts.gpu} GPU but got "${result.gpu.renderer}"`);
    if (/swiftshader/i.test(result.gpu.renderer)) log('WARNING: software rendering (SwiftShader) — numbers are meaningless');

    // ── Cold load ──
    log(`Loading ${label} (${result.meta.fileMB} MB)…`);
    const cdp = await context.newCDPSession(page);
    const wallStart = Date.now();
    await page.setInputFiles('#file-input', modelPath);
    await waitForLoads(page, 1, opts.timeoutMin * 60000, events);
    const [cold] = await page.evaluate(() => window.__ifcPerf.loads);
    result.cold = { ...loadTimes(cold), wallMs: Date.now() - wallStart };
    log(`Cold load: first geometry ${result.cold.firstGeometryMs} ms, loaded ${result.cold.loadedMs} ms, ${cold.meshCount} meshes${cold.ok ? '' : ` — FAILED: ${cold.error}`}`);
    logPhases('Cold load', result.cold.phases);
    if (!cold.ok) throw new Error(`Load failed: ${cold.error}`);

    const forced = await page.evaluate(() => window.__ifcPerf.render());
    result.scene = { ...forced.info, renderCpuMs: round(forced.renderCpuMs, 2) };
    result.camera = await page.evaluate(() => window.__ifcPerf.camera());
    result.model = await page.evaluate(() => window.__ifcPerf.model());
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    result.heapAfterLoad = { usedMB: mb(heap.usedSize), totalMB: mb(heap.totalSize) };
    log(`Scene: ${result.scene.meshes} meshes, ${result.scene.drawCalls} draw calls, ${result.scene.triangles} triangles; heap ${result.heapAfterLoad.usedMB} MB`);
    if (result.model?.batches) log(`Batches: ${JSON.stringify(result.model.batches)}`);

    // ── Pick (at the fit view, before any orbit) ──
    await page.evaluate(() => window.__ifcPerf.pick({ cols: 1, rows: 1 })); // warm-up
    const pick = await page.evaluate(() => window.__ifcPerf.pick({ cols: 5, rows: 5 }));
    result.pick = { area: pick.area, samples: pick.samples, hits: pick.hits, medianMs: round(pick.medianMs, 2), p95Ms: round(pick.p95Ms, 2), maxMs: round(pick.maxMs, 2), hitMedianMs: round(pick.hitMedianMs, 2) };
    log(`Pick: median ${result.pick.medianMs} ms, p95 ${result.pick.p95Ms} ms (${pick.hits}/${pick.samples} hit; median of hits ${result.pick.hitMedianMs} ms)`);

    // ── Orbits ──
    const orbit = async (distanceScale, gpuSync = false) => {
      const o = await page.evaluate(
        ([frames, scale, sync]) => window.__ifcPerf.orbit({ frames, distanceScale: scale, gpuSync: sync }),
        [opts.orbitFrames, distanceScale, gpuSync],
      );
      if (gpuSync) {
        return {
          distanceScale,
          frames: o.frames,
          // What the frame really cost: render CPU + waiting for the GPU to finish it.
          syncedFrameMedianMs: round(o.syncedFrameMedianMs, 2),
          syncedFrameP95Ms: round(o.syncedFrameP95Ms, 2),
          syncedFps: round(1000 / o.syncedFrameMedianMs),
          gpuWaitMedianMs: round(o.gpuWaitMedianMs, 2),
          renderCpuMedianMs: round(o.renderCpuMedianMs, 2),
          drawCalls: o.info.drawCalls,
        };
      }
      return {
        distanceScale,
        frames: o.frames,
        medianFps: round(o.medianFps),
        meanFps: round(o.meanFps),
        p95FrameMs: round(o.p95FrameMs),
        maxFrameMs: round(o.maxFrameMs),
        renderCpuMedianMs: round(o.renderCpuMedianMs, 2),
        renderCpuP95Ms: round(o.renderCpuP95Ms, 2),
        wallMs: round(o.wallMs, 0),
        drawCalls: o.info.drawCalls,
        triangles: o.info.triangles,
        near: o.near,
        far: o.far,
      };
    };
    if (opts.orbit) {
    if (opts.profile) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
      await cdp.send('Profiler.start');
    }
    result.orbitFit = await orbit(1);
    if (opts.profile) {
      const { profile } = await cdp.send('Profiler.stop');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = path.join(ROOT, 'bench-results', `${stamp}-${label.replace(/[^\w.-]+/g, '_')}-orbit.cpuprofile`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(profile));
      result.orbitProfile = { file: path.relative(ROOT, file), topSelfTime: topSelfTime(profile, 20) };
      log('Orbit CPU profile, top self time:');
      for (const row of result.orbitProfile.topSelfTime.slice(0, 12)) log(`  ${String(row.pct).padStart(5)} %  ${row.fn}`);
    }
    log(`Orbit (fit):   ${result.orbitFit.medianFps} fps median, p95 ${result.orbitFit.p95FrameMs} ms, render CPU ${result.orbitFit.renderCpuMedianMs} ms`);
    result.orbitClose = await orbit(opts.closeScale);
    log(`Orbit (close): ${result.orbitClose.medianFps} fps median, p95 ${result.orbitClose.p95FrameMs} ms, render CPU ${result.orbitClose.renderCpuMedianMs} ms`);
    // The same two orbits with a GPU sync after every frame. Once the CPU cost
    // is small, an unthrottled run (vsync off) can report frame rates the GPU
    // never drew; these say what each frame cost the GPU too.
    result.orbitFitSynced = await orbit(1, true);
    log(`Orbit (fit, GPU-synced):   ${result.orbitFitSynced.syncedFps} fps (frame ${result.orbitFitSynced.syncedFrameMedianMs} ms median, p95 ${result.orbitFitSynced.syncedFrameP95Ms} ms; GPU wait ${result.orbitFitSynced.gpuWaitMedianMs} ms)`);
    result.orbitCloseSynced = await orbit(opts.closeScale, true);
    log(`Orbit (close, GPU-synced): ${result.orbitCloseSynced.syncedFps} fps (frame ${result.orbitCloseSynced.syncedFrameMedianMs} ms median, p95 ${result.orbitCloseSynced.syncedFrameP95Ms} ms; GPU wait ${result.orbitCloseSynced.gpuWaitMedianMs} ms)`);
    }

    // Private bytes per Chrome process: peak over the cold load and orbits,
    // and the level now that the model is loaded and has been drawn.
    result.processMemoryCold = memSnapshot();
    log(`Process memory (cold): peak total ${result.processMemoryCold.peakTotalMB} MB; peak per process ${JSON.stringify(result.processMemoryCold.peakByTypeMB)}`);

    // ── Warm load: reload, let session restore bring it back ──
    if (opts.warm) {
      log('Waiting for the geometry cache write…');
      const cacheStart = Date.now();
      let records = 0;
      while (Date.now() - cacheStart < 5 * 60000) {
        records = await page.evaluate(geometryCacheCount);
        if (records > 0) break;
        // Written and immediately evicted: the model is bigger than the cache.
        if (result.errors.some((e) => /GeometryCache: evicted/.test(e.text ?? ''))) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      result.cacheWrite = { records, waitedMs: Date.now() - cacheStart };
      if (records <= 0) log('  no geometry-cache record appeared within 5 min; the reload will parse again');

      log('Reloading (same profile)…');
      await page.reload();
      await page.waitForFunction(() => !!window.__ifcPerf, null, { timeout: 30000 });
      await waitForLoads(page, 1, opts.timeoutMin * 60000, events);
      await page
        .waitForFunction(() => window.__ifcPerf.loads[0].firstGeometryAt !== null, null, { timeout: 60000 })
        .catch(() => {});
      const [warm] = await page.evaluate(() => window.__ifcPerf.loads);
      result.warm = { ...loadTimes(warm), note: 'times from navigation start (session restore)' };
      log(`Warm load (${warm.fromCache ? 'geometry cache' : 'full parse'}): first geometry ${result.warm.firstGeometryMs} ms, loaded ${result.warm.loadedMs} ms`);
      logPhases('Warm load', result.warm.phases);
      result.processMemoryRun = memSnapshot();
      log(`Process memory (whole run): peak total ${result.processMemoryRun.peakTotalMB} MB`);
    }
  } catch (err) {
    result.failure = String(err?.message ?? err);
    log(`FAILED: ${result.failure}`);
  } finally {
    result.progress = events.progress;
    sampler.stop();
    await context?.close().catch(() => {});
    server?.stop();
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }

  const outDir = path.join(ROOT, 'bench-results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(outDir, `${stamp}-${label.replace(/[^\w.-]+/g, '_')}-${opts.gpu}-vsync${opts.vsync}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  log(`Wrote ${path.relative(ROOT, file)}`);
  if (result.failure) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
