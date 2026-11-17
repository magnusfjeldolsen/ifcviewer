#!/usr/bin/env node
// Lighthouse performance audit of the production build — `npm run lighthouse`.
//
// Builds the app, serves dist/ with `vite preview`, runs Lighthouse (desktop
// preset, performance category only) against it in headless Chrome, and prints
// the score, LCP, TBT and the size of the JavaScript the page ships. The full
// Lighthouse report is saved to bench-results/ (gitignored).
//
// Lighthouse is fetched by npx on first use (pinned below), so it is not a
// devDependency and `npm ci` stays lean.
//
// Options
//   --url <url>   audit a server that is already running instead
//   --no-build    serve the existing dist/ without rebuilding

import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, build, startPreview } from './server.mjs';

const LIGHTHOUSE = 'lighthouse@13.6.0';

const argv = process.argv.slice(2);
const urlArg = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : null;
const doBuild = !argv.includes('--no-build');

function jsBundles() {
  const dir = path.join(ROOT, 'dist', 'assets');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => {
      const buf = readFileSync(path.join(dir, f));
      return { file: f, kB: Math.round(statSync(path.join(dir, f)).size / 1024), gzipKB: Math.round(gzipSync(buf).length / 1024) };
    })
    .sort((a, b) => b.kB - a.kB);
}

let server = null;
try {
  let url = urlArg;
  if (!url) {
    if (doBuild) build();
    server = await startPreview();
    url = server.url;
  }

  const outDir = path.join(ROOT, 'bench-results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(outDir, `${stamp}-lighthouse.json`);

  // One quoted command line: npx is a .cmd shim on Windows, which needs a shell.
  const command = 'npx ' + [
    '--yes', LIGHTHOUSE, url,
    '--only-categories=performance',
    '--preset=desktop',
    '--output=json',
    `--output-path=${reportPath}`,
    '--chrome-flags=--headless=new',
    '--quiet',
  ].map((a) => `"${a}"`).join(' ');
  const r = spawnSync(command, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`lighthouse exited with ${r.status}`);

  const lhr = JSON.parse(readFileSync(reportPath, 'utf8'));
  const audit = (id) => lhr.audits[id]?.numericValue;
  const scripts = (lhr.audits['network-requests']?.details?.items ?? []).filter((i) => i.resourceType === 'Script');
  const summary = {
    url,
    score: Math.round((lhr.categories.performance.score ?? 0) * 100),
    fcpMs: Math.round(audit('first-contentful-paint')),
    lcpMs: Math.round(audit('largest-contentful-paint')),
    tbtMs: Math.round(audit('total-blocking-time')),
    cls: audit('cumulative-layout-shift'),
    speedIndexMs: Math.round(audit('speed-index')),
    totalTransferKB: Math.round(audit('total-byte-weight') / 1024),
    scriptTransferKB: Math.round(scripts.reduce((a, s) => a + (s.transferSize ?? 0), 0) / 1024),
    distJs: jsBundles(),
    report: path.relative(ROOT, reportPath),
  };
  console.log(JSON.stringify(summary, null, 2));
  writeFileSync(reportPath.replace(/\.json$/, '-summary.json'), JSON.stringify(summary, null, 2));
} finally {
  server?.stop();
}
