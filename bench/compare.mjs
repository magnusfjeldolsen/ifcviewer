#!/usr/bin/env node
// Is the model on screen still the same one? — `npm run compare -- <model.ifc> (--base <git ref> | --cache) [options]`.
//
// When loading or drawing changes, no element should go missing, appear twice
// or change colour. This loads one model in two situations, reads what the
// viewer holds for every element (expressID) and reports whether the two
// agree. It uses the same machinery as `npm run bench`: it builds and serves
// the app with `vite preview`, opens the locally installed Chrome through
// Playwright (headed, real GPU) and hands the file to the file input by path.
//
// Two modes (give exactly one)
//   --base <git ref>   two builds. The ref is built in a temporary git
//                      worktree under the system temp folder (node_modules
//                      linked in with a junction, the web-ifc wasm files
//                      copied from public/) and compared with a build of the
//                      current working tree. Both cold-load the model in a
//                      fresh browser profile, one after the other. The
//                      worktree is removed afterwards. Side A is the ref,
//                      side B the working tree.
//   --cache            cold load against a reload from the geometry cache,
//                      both in the current build. Side A is the cold load,
//                      side B the reload (the script waits for the cache write
//                      and checks that the reload really came from the cache).
//
// Per element it compares: piece count, triangle count, vertex count, bounding
// box (1e-3 m), base colour and opacity (per piece), and total surface area.
// An area that differs by less than a relative 1e-3 is reported separately as
// "rounding only": chunks store positions as 32-bit offsets from a per-chunk
// anchor, so the same element can differ by about 1e-4 between runs.
//
// It also screenshots the canvas at three fixed camera poses (set from side
// A's scene box, so both sides see the same pose) and reports the share of
// pixels that differ (any colour channel by more than 8 of 255).
//
// Output: a short summary on the console (counts for each side, elements
// identical, rounding only, different, the first 20 differences, the pixel
// shares) and, in the gitignored bench-results/ folder, a JSON file with every
// difference plus a folder with the screenshots and a difference image per pose.
// Exit code 1 if anything other than rounding differs (a load failed, an
// element differs, the scene box differs, a pose differs by more than
// --pixel-threshold percent of its pixels).
//
// How the elements are read: through three's `__THREE_DEVTOOLS__` hook (an
// init script collects every scene three announces) and the chunk meshes'
// `owner` ModelBatch, whose per-piece arrays hold expressID, counts, box,
// colour and the chunk's positions. That reaches into ModelBatch's private
// fields, so it has to be kept in step with them, but it is the only way that
// works on an older `--base` ref, which cannot have been given a newer debug
// surface. If a field goes missing the script says so instead of reporting
// nonsense. The `?stats` surface (`window.__ifcPerf`) is used for load records,
// the scene box, the GPU name and the camera.
//
// Options
//   --gpu integrated|discrete|default   as for bench (default integrated)
//   --viewport WxH      CSS pixels (default 1280x720)
//   --dpr <n>           device pixel ratio (default 1)
//   --label <name>      name used in the result files (default: the model's
//                       file name; use a neutral label for private models)
//   --no-build          serve the existing dist/ of the working tree
//   --port <n>          first port for `vite preview` (default 4860; a second
//                       one is used for the next side)
//   --pixel-threshold <pct>   share of differing pixels, per pose, above which
//                       the screenshots count as different (default 0.5)
//   --timeout-min <n>   give up waiting for a load after n minutes (default 30)
//
// Examples
//   npm run compare -- path/to/model.ifc --cache
//   npm run compare -- path/to/model.ifc --base origin/main --label big-model
//
// The model file is handed to Chrome by path; Node never reads it.

import { chromium } from 'playwright-core';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ROOT, build, startPreview } from './server.mjs';
import { PIXEL_THRESHOLD_PCT, cameraPoses, compareSignatures, pixelVerdict } from './compareLogic.mjs';

// ── Arguments ────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    model: null,
    base: null,
    cache: false,
    gpu: 'integrated',
    viewport: [1280, 720],
    dpr: 1,
    label: null,
    build: true,
    port: 4860,
    pixelThreshold: PIXEL_THRESHOLD_PCT,
    timeoutMin: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--base': opts.base = next(); break;
      case '--cache': opts.cache = true; break;
      case '--gpu': opts.gpu = next(); break;
      case '--viewport': opts.viewport = next().split('x').map(Number); break;
      case '--dpr': opts.dpr = Number(next()); break;
      case '--label': opts.label = next(); break;
      case '--no-build': opts.build = false; break;
      case '--port': opts.port = Number(next()); break;
      case '--pixel-threshold': opts.pixelThreshold = Number(next()); break;
      case '--timeout-min': opts.timeoutMin = Number(next()); break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
        if (opts.model) throw new Error('Give exactly one model file');
        opts.model = a;
    }
  }
  const usage = 'Usage: npm run compare -- <model.ifc> (--base <git ref> | --cache) [--gpu integrated|discrete|default] [--label name] ...  (see the header of bench/compare.mjs)';
  if (!opts.model) throw new Error(usage);
  if (!opts.base === !opts.cache) throw new Error(`Give exactly one of --base <git ref> and --cache.\n${usage}`);
  if (!['integrated', 'discrete', 'default'].includes(opts.gpu)) throw new Error('--gpu must be integrated, discrete or default');
  return opts;
}

const GPU_ARGS = {
  integrated: ['--force_low_power_gpu'],
  discrete: ['--force_high_performance_gpu'],
  default: [],
};

const log = (...a) => console.log(`[compare ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// ── Temporary worktree for --base ────────────────────────────

/** Check `ref` out into a worktree in the system temp folder, ready to build. */
function createBaseTree(tempDir, ref) {
  const dir = path.join(tempDir, 'base');
  git(['worktree', 'add', '--detach', dir, ref]);
  const tree = { dir, linked: false };
  // A junction, not a copy: node_modules is large.
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  tree.linked = true;
  mkdirSync(path.join(dir, 'public'), { recursive: true });
  for (const f of ['web-ifc.wasm', 'web-ifc-mt.wasm']) copyFileSync(path.join(ROOT, 'public', f), path.join(dir, 'public', f));
  return tree;
}

/**
 * Remove the worktree. The junction goes first and on its own (`rmdir` removes
 * only the link; a recursive delete would follow it into the real node_modules).
 */
function removeBaseTree(tree) {
  const link = path.join(tree.dir, 'node_modules');
  if (existsSync(link)) {
    if (process.platform === 'win32') spawnSync('cmd', ['/c', 'rmdir', link]);
    else rmSync(link, { force: true });
  }
  try {
    git(['worktree', 'remove', '--force', tree.dir]);
  } catch (e) {
    log(`Could not remove the worktree ${tree.dir}: ${e.message}`);
  }
  try {
    git(['worktree', 'prune']);
  } catch {
    // Nothing to prune.
  }
}

// ── Reading the model from a page ────────────────────────────

/** Runs before the app: answer the cookie question, and collect the scenes three announces. */
function initScript() {
  try {
    localStorage.setItem('ifcviewer:cookieConsent', 'declined');
  } catch {
    // Storage blocked: the banner will show, the comparison does not need it.
  }
  window.__compareScenes = [];
  const hook = new EventTarget();
  hook.addEventListener('observe', (e) => {
    if (e.detail && e.detail.isScene) window.__compareScenes.push(e.detail);
  });
  window.__THREE_DEVTOOLS__ = hook;
}

/**
 * Per-element signature of the model on screen. Runs in the page, so it must
 * stay self-contained. Reads ModelBatch's per-piece arrays (see the header).
 */
function readSignature() {
  const batches = new Set();
  for (const s of window.__compareScenes) s.traverse((o) => { if (o.isChunkMesh) batches.add(o.owner); });
  const fields = ['pieceExpressId', 'pieceIndexCount', 'pieceVertexCount', 'pieceIndexStart', 'pieceBox', 'pieceChunk', 'baseColor'];
  const models = [];
  for (const b of batches) {
    for (const f of fields) {
      if (!b[f]) throw new Error(`ModelBatch has no "${f}" any more: update readSignature in bench/compare.mjs`);
    }
    const els = new Map();
    let tris = 0, verts = 0, emptyPieces = 0;
    for (let p = 0; p < b.count; p++) {
      const id = b.pieceExpressId[p];
      const ic = b.pieceIndexCount[p], vc = b.pieceVertexCount[p];
      let e = els.get(id);
      if (!e) {
        e = { pieces: 0, tris: 0, verts: 0, box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], area: 0, colors: [] };
        els.set(id, e);
      }
      e.pieces++; e.tris += ic / 3; e.verts += vc; tris += ic / 3; verts += vc;
      if (ic > 0) {
        const o = p * 6;
        for (let k = 0; k < 3; k++) {
          e.box[k] = Math.min(e.box[k], b.pieceBox[o + k]);
          e.box[k + 3] = Math.max(e.box[k + 3], b.pieceBox[o + k + 3]);
        }
        const ch = b.pieceChunk[p];
        if (ch) {
          const P = ch.positions, I = ch.index, is = b.pieceIndexStart[p];
          let a = 0;
          for (let t = 0; t < ic; t += 3) {
            const i0 = I[is + t] * 3, i1 = I[is + t + 1] * 3, i2 = I[is + t + 2] * 3;
            const ux = P[i1] - P[i0], uy = P[i1 + 1] - P[i0 + 1], uz = P[i1 + 2] - P[i0 + 2];
            const vx = P[i2] - P[i0], vy = P[i2 + 1] - P[i0 + 1], vz = P[i2 + 2] - P[i0 + 2];
            const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
            a += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
          }
          e.area += a;
        }
      } else {
        emptyPieces++;
      }
      const c = b.baseColor;
      e.colors.push([c[p * 4], c[p * 4 + 1], c[p * 4 + 2], c[p * 4 + 3]].map((v) => Number(v.toFixed(3))).join(','));
    }
    const elements = {};
    for (const [id, e] of els) {
      e.colors.sort();
      elements[id] = {
        pieces: e.pieces,
        tris: e.tris,
        verts: e.verts,
        area: Number(e.area.toPrecision(7)),
        box: e.box.map((v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : null)),
        colors: e.colors.join('|'),
      };
    }
    models.push({ modelId: b.modelId, pieces: b.count, elementCount: els.size, tris, verts, emptyPieces, elements });
  }
  if (models.length === 0) throw new Error('No model geometry found in the scene: nothing loaded, or the chunk meshes changed (see readSignature in bench/compare.mjs)');
  models.sort((x, y) => x.modelId - y.modelId);
  return { models, sceneBox: window.__ifcPerf.model().box };
}

// Geometry-cache entries, counted only once the model file itself is saved
// too (the same check as bench/run.mjs).
const geometryCacheCount = () =>
  new Promise((resolve) => {
    const req = indexedDB.open('ifcviewer');
    req.onerror = () => resolve(-1);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('geometry-index') || !db.objectStoreNames.contains('models')) {
        db.close();
        resolve(0);
        return;
      }
      const tx = db.transaction(['geometry-index', 'models'], 'readonly');
      const entries = tx.objectStore('geometry-index').count();
      const models = tx.objectStore('models').count();
      tx.oncomplete = () => {
        db.close();
        resolve(models.result > 0 ? entries.result : 0);
      };
      tx.onerror = () => {
        db.close();
        resolve(-1);
      };
    };
  });

async function waitForLoads(page, count, timeoutMs, events) {
  const start = Date.now();
  for (;;) {
    if (events.crashed) throw new Error('The page crashed (renderer process died) while loading');
    const n = await Promise.race([
      page.evaluate(() => window.__ifcPerf?.loads.length ?? -1).catch(() => -2),
      sleep(5000).then(() => -3),
    ]);
    if (n >= count) return page.evaluate(() => window.__ifcPerf.loads.map((l) => ({ ...l, phases: undefined })));
    if (Date.now() - start > timeoutMs) throw new Error(`Load did not finish within ${Math.round(timeoutMs / 60000)} min`);
    await sleep(1000);
  }
}

// ── One browser session ──────────────────────────────────────

/**
 * Open `url` in a fresh Chrome profile, load the model, read the signature and
 * take the screenshots. With `reloadFromCache`, wait for the geometry cache
 * write, reload and capture again. Returns an array of captures (one, or the
 * cold load then the reload). `poses` null means "take them from this
 * session's first capture"; they are returned so the other side can reuse them.
 */
async function session(opts, url, shotDir, shotPrefix, { reloadFromCache, poses }) {
  const modelPath = path.resolve(opts.model);
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'ifcviewer-compare-profile-'));
  const args = [
    ...GPU_ARGS[opts.gpu],
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--ignore-gpu-blocklist',
  ];
  const events = { crashed: false };
  const problems = [];
  let context = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: false,
      args,
      viewport: { width: opts.viewport[0], height: opts.viewport[1] },
      deviceScaleFactor: opts.dpr,
    });
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('crash', () => { events.crashed = true; });
    page.on('pageerror', (e) => problems.push(`pageerror: ${String(e.message ?? e).slice(0, 300)}`));
    page.on('console', (m) => {
      if ((m.type() === 'error' || m.type() === 'warning') && problems.length < 30) problems.push(`console.${m.type()}: ${m.text().slice(0, 300)}`);
    });
    await page.addInitScript(initScript);
    const appUrl = new URL(url);
    appUrl.searchParams.set('stats', '');
    await page.goto(appUrl.toString());
    await page.waitForFunction(() => !!window.__ifcPerf, null, { timeout: 30000 });
    const gpu = await page.evaluate(() => window.__ifcPerf.gpu());
    log(`  GPU: ${gpu.renderer}`);
    if (/swiftshader/i.test(gpu.renderer)) log('  WARNING: software rendering (SwiftShader): screenshots will not match a real GPU');
    const want = { integrated: /intel/i, discrete: /nvidia|amd|radeon/i }[opts.gpu];
    if (want && !want.test(gpu.renderer)) log(`  WARNING: asked for the ${opts.gpu} GPU but got "${gpu.renderer}"`);

    const captures = [];
    const capture = async (tag, load) => {
      await sleep(1500);
      const signature = await page.evaluate(readSignature);
      let usedPoses = poses;
      if (!usedPoses) {
        if (!signature.sceneBox) throw new Error('The scene has no bounding box to place the camera by');
        usedPoses = cameraPoses(signature.sceneBox);
        poses = usedPoses;
      }
      await page.addStyleTag({ content: '.stats-overlay{display:none!important}' });
      const shots = [];
      for (const pose of usedPoses) {
        await page.evaluate(([p, t]) => window.__ifcPerf.setCamera(p, t), [pose.position, pose.target]);
        await sleep(1000);
        await page.evaluate(() => window.__ifcPerf.render());
        await sleep(500);
        const file = path.join(shotDir, `${shotPrefix}-${tag}-${pose.name}.png`);
        await page.locator('#viewer-canvas').screenshot({ path: file });
        shots.push({ pose: pose.name, file });
      }
      captures.push({ tag, load, signature, shots });
    };

    log('  Loading the model…');
    await page.setInputFiles('#file-input', modelPath);
    const [cold] = await waitForLoads(page, 1, opts.timeoutMin * 60000, events);
    log(`  Cold load: ${cold.ok ? 'ok' : `FAILED: ${cold.error}`}, ${cold.meshCount} meshes`);
    if (cold.ok) await capture(reloadFromCache ? 'cold' : 'load', cold);
    else captures.push({ tag: 'cold', load: cold, signature: null, shots: [] });

    if (reloadFromCache && cold.ok) {
      log('  Waiting for the geometry cache write…');
      const start = Date.now();
      let records = 0;
      while (Date.now() - start < 5 * 60000) {
        records = await page.evaluate(geometryCacheCount);
        if (records > 0) break;
        await sleep(1000);
      }
      if (records <= 0) throw new Error('No geometry-cache record appeared within 5 min (is the model larger than the cache?), so there is nothing to reload from');
      await sleep(1000);
      log(`  Reloading (${records} cache records)…`);
      await page.reload();
      await page.waitForFunction(() => !!window.__ifcPerf, null, { timeout: 30000 });
      const [warm] = await waitForLoads(page, 1, opts.timeoutMin * 60000, events);
      await page.waitForFunction(() => window.__ifcPerf.loads[0].firstGeometryAt !== null, null, { timeout: 60000 }).catch(() => {});
      log(`  Reload: ${warm.ok ? 'ok' : `FAILED: ${warm.error}`}, ${warm.fromCache ? 'from the geometry cache' : 'NOT from the geometry cache'}`);
      if (warm.ok) await capture('cache', warm);
      else captures.push({ tag: 'cache', load: warm, signature: null, shots: [] });
    }
    return { captures, poses, gpu: gpu.renderer, problems };
  } finally {
    await context?.close().catch(() => {});
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(500);
      }
    }
  }
}

// ── Screenshot difference ────────────────────────────────────

/** Compare PNG pairs in a headless Chrome page; writes a difference image per pair. */
async function pixelDiffs(pairs) {
  if (pairs.length === 0) return [];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const out = [];
    for (const { a, b, diff } of pairs) {
      const A = 'data:image/png;base64,' + readFileSync(a).toString('base64');
      const B = 'data:image/png;base64,' + readFileSync(b).toString('base64');
      const res = await page.evaluate(async ([A, B]) => {
        const load = (s) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = s; });
        const [ia, ib] = await Promise.all([load(A), load(B)]);
        const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, w, h).data;
        g.clearRect(0, 0, w, h); g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, w, h).data;
        const img = g.createImageData(w, h);
        let n8 = 0, n32 = 0;
        for (let p = 0; p < w * h; p++) {
          const o = p * 4;
          const d = Math.max(Math.abs(da[o] - db[o]), Math.abs(da[o + 1] - db[o + 1]), Math.abs(da[o + 2] - db[o + 2]));
          if (d > 8) n8++;
          if (d > 32) n32++;
          const gray = ((da[o] + da[o + 1] + da[o + 2]) / 3) * 0.3 + 170;
          img.data[o] = d > 8 ? 255 : gray; img.data[o + 1] = d > 8 ? 0 : gray; img.data[o + 2] = d > 8 ? 0 : gray; img.data[o + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        return {
          sameSize: ia.width === ib.width && ia.height === ib.height,
          pct8: (100 * n8) / (w * h),
          pct32: (100 * n32) / (w * h),
          png: c.toDataURL('image/png'),
        };
      }, [A, B]);
      writeFileSync(diff, Buffer.from(res.png.split(',')[1], 'base64'));
      out.push({ sameSize: res.sameSize, pct8: res.pct8, pct32: res.pct32 });
    }
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Main ─────────────────────────────────────────────────────

const round = (v, d = 3) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const modelPath = path.resolve(opts.model);
  if (!existsSync(modelPath)) throw new Error(`No such file: ${modelPath}`);
  const label = opts.label ?? path.basename(modelPath, path.extname(modelPath));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeLabel = label.replace(/[^\w.-]+/g, '_');
  const outDir = path.join(ROOT, 'bench-results');
  const shotDir = path.join(outDir, `${stamp}-compare-${safeLabel}`);
  mkdirSync(shotDir, { recursive: true });

  const result = { meta: { label, mode: opts.base ? 'two builds' : 'cache', date: new Date().toISOString(), commit: git(['rev-parse', '--short', 'HEAD']), base: opts.base, gpuOption: opts.gpu, viewport: opts.viewport, dpr: opts.dpr, pixelThresholdPct: opts.pixelThreshold }, sides: {} };
  let tempDir = null;
  let tree = null;
  let sideA, sideB;
  try {
    if (opts.base) {
      tempDir = mkdtempSync(path.join(os.tmpdir(), 'ifcviewer-compare-'));
      log(`Checking out ${opts.base} into a temporary worktree…`);
      result.meta.baseCommit = git(['rev-parse', '--short', opts.base]);
      tree = createBaseTree(tempDir, opts.base);
      log(`Building ${opts.base} (${result.meta.baseCommit})…`);
      build(tree.dir);
      if (opts.build) {
        log('Building the working tree…');
        build();
      }
      const base = await startPreview(opts.port, tree.dir);
      try {
        log(`Side A: ${opts.base}`);
        sideA = await session(opts, base.url, shotDir, 'A', { reloadFromCache: false, poses: null });
      } finally {
        base.stop();
      }
      const current = await startPreview(opts.port + 1, ROOT);
      try {
        log('Side B: working tree');
        sideB = await session(opts, current.url, shotDir, 'B', { reloadFromCache: false, poses: sideA.poses });
      } finally {
        current.stop();
      }
      result.sides = { A: { what: `build of ${opts.base} (${result.meta.baseCommit})`, ...describe(sideA) }, B: { what: 'build of the working tree', ...describe(sideB) } };
    } else {
      if (opts.build) {
        log('Building…');
        build();
      }
      const server = await startPreview(opts.port, ROOT);
      let both;
      try {
        log('Cold load, then reload from the geometry cache');
        both = await session(opts, server.url, shotDir, 'S', { reloadFromCache: true, poses: null });
      } finally {
        server.stop();
      }
      sideA = { captures: [both.captures[0]], gpu: both.gpu, problems: both.problems, poses: both.poses };
      sideB = { captures: [both.captures[1]], gpu: both.gpu, problems: [], poses: both.poses };
      result.sides = { A: { what: 'cold load', ...describe(sideA) }, B: { what: 'reload from the geometry cache', ...describe(sideB) } };
      if (!sideB.captures[0]?.load?.fromCache) result.cacheNotUsed = true;
    }
  } finally {
    if (tree) removeBaseTree(tree);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }

  // ── Judge ──
  const a = sideA.captures[0];
  const b = sideB.captures[0];
  const failures = [];
  for (const [name, c] of [['A', a], ['B', b]]) {
    if (!c?.load?.ok) failures.push(`side ${name} did not load: ${c?.load?.error ?? 'no result'}`);
  }
  if (result.cacheNotUsed) failures.push('the reload did not come from the geometry cache, so it is not a cache comparison');
  let cmp = null;
  let pixels = [];
  if (a?.signature && b?.signature) {
    cmp = compareSignatures(a.signature, b.signature);
    result.comparison = { summary: cmp.summary, differences: cmp.differences, roundingOnly: cmp.roundingOnly };
    if (!cmp.identical) failures.push(`${cmp.differences.length} difference(s) between the two models`);
    const diffs = await pixelDiffs(a.shots.map((s, i) => ({ a: s.file, b: b.shots[i].file, diff: path.join(shotDir, `diff-${s.pose}.png`) })));
    pixels = diffs.map((d, i) => ({ pose: a.shots[i].pose, pctDifferent: round(d.pct8), pctDifferentStrongly: round(d.pct32), sameSize: d.sameSize, verdict: d.sameSize ? pixelVerdict(d.pct8, opts.pixelThreshold) : 'different' }));
    result.screenshots = pixels;
    for (const p of pixels) if (p.verdict === 'different') failures.push(`screenshot "${p.pose}" differs (${p.pctDifferent} % of pixels)`);
  }
  result.problems = { A: sideA.problems, B: sideB.problems };
  result.failures = failures;

  report(result, cmp, pixels);
  const file = path.join(outDir, `${stamp}-compare-${safeLabel}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  log(`Wrote ${path.relative(ROOT, file)} and ${path.relative(ROOT, shotDir)}${path.sep}`);
  if (failures.length > 0) process.exitCode = 1;
}

/** The part of a side worth keeping in the result file (not the whole signature). */
function describe(side) {
  const c = side.captures[0];
  return {
    gpu: side.gpu,
    load: c?.load ? { ok: c.load.ok, error: c.load.error ?? null, fromCache: c.load.fromCache, meshCount: c.load.meshCount } : null,
    screenshots: c?.shots.map((s) => path.basename(s.file)) ?? [],
  };
}

function report(result, cmp, pixels) {
  console.log('');
  console.log(`Compare ${result.meta.label} — ${result.meta.mode}`);
  for (const k of ['A', 'B']) {
    const s = result.sides[k];
    console.log(`  ${k}: ${s.what}${s.load && !s.load.ok ? ` — LOAD FAILED: ${s.load.error}` : ''}`);
  }
  if (cmp) {
    cmp.summary.perModel.forEach((m, i) => {
      const c = m.counts;
      console.log(`  model ${i}:           A            B`);
      for (const [name, key] of [['elements', 'elementCount'], ['pieces', 'pieces'], ['triangles', 'tris'], ['vertices', 'verts'], ['empty pieces', 'emptyPieces']]) {
        console.log(`    ${name.padEnd(13)} ${String(c[key][0]).padStart(10)} ${String(c[key][1]).padStart(12)}`);
      }
      console.log(`    elements identical: ${m.elementsIdentical}, rounding only: ${m.elementsRoundingOnly}, different: ${m.elementsDifferent}`);
    });
    if (cmp.summary.models[0] !== cmp.summary.models[1]) console.log(`  model count: ${cmp.summary.models[0]} vs ${cmp.summary.models[1]}`);
    if (cmp.differences.length > 0) {
      console.log(`  First ${Math.min(20, cmp.differences.length)} of ${cmp.differences.length} difference(s):`);
      for (const d of cmp.differences.slice(0, 20)) console.log(`    ${d}`);
    }
    if (cmp.roundingOnly.length > 0) {
      console.log(`  Rounding only (area differs by less than a relative 1e-3): ${cmp.roundingOnly.length} element(s), e.g.`);
      for (const d of cmp.roundingOnly.slice(0, 3)) console.log(`    ${d}`);
    }
    console.log('  Screenshots (share of pixels that differ):');
    for (const p of pixels) console.log(`    ${p.pose.padEnd(6)} ${String(p.pctDifferent).padStart(7)} %   (strongly: ${p.pctDifferentStrongly} %)  ${p.verdict}`);
  }
  for (const k of ['A', 'B']) {
    const pr = result.problems[k];
    if (pr.length > 0) console.log(`  Browser messages on side ${k} (${pr.length}), first: ${pr[0]}`);
  }
  console.log('');
  console.log(result.failures.length === 0 ? 'RESULT: same (rounding aside)' : `RESULT: DIFFERENT — ${result.failures.join('; ')}`);
}

main().catch((err) => {
  console.error(`[compare] FAILED: ${err?.message ?? err}`);
  process.exit(1);
});
