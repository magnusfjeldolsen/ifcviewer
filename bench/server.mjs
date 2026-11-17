// Shared by bench/run.mjs and bench/lighthouse.mjs: build the app and serve it
// with `vite preview`, or attach to a server that is already running.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/** Production build into dist/. Throws if it fails. */
export function build() {
  const r = spawnSync(process.execPath, [VITE, 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`vite build failed (exit ${r.status})`);
}

async function reachable(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Serve dist/ on `port` and resolve once it answers. Returns { url, stop }.
 * `url` is the app's root (vite.config.ts sets base '/ifcviewer/').
 */
export async function startPreview(port = 4173) {
  const url = `http://localhost:${port}/ifcviewer/`;
  if (await reachable(url)) {
    throw new Error(`Something is already serving ${url}; stop it or pass --url to attach to it`);
  }
  const child = spawn(process.execPath, [VITE, 'preview', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite preview exited early:\n${log}`);
    if (await reachable(url)) {
      return {
        url,
        stop: () => {
          if (child.exitCode === null) child.kill();
        },
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`vite preview did not answer on ${url} within 30 s:\n${log}`);
}
