import { App } from './core/App';
import { parseDeepLink, moveUrlParamToHash } from './core/deepLink';

// Read the address and scrub it *first*, before the App exists and long
// before analytics could load. A share URL is its own credential, and in the
// query string it would be reported to Google Analytics as `page_location`
// and kept in browser history. Moving it to the fragment keeps it in the
// recipient's browser. Links already handed out in `?url=` form still work;
// they are rewritten in place by `history.replaceState`, which leaves no
// history entry behind.
const deepLink = parseDeepLink(window.location.search, window.location.hash);
if (deepLink.fromQuery) {
  window.history.replaceState(null, '', moveUrlParamToHash(window.location.href));
}

const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
if (!canvas) {
  throw new Error('Canvas element #viewer-canvas not found');
}

const app = new App(canvas);

// `?stats` turns on the performance readout and the `window.__ifcPerf` hook
// the benchmark drives. Imported on demand, so without the parameter none of
// it is downloaded. Installed before `start()` so a session restore is timed.
const statsReady = new URLSearchParams(window.location.search).has('stats')
  ? import('./debug/perfSurface')
      .then((m) => {
        m.installPerfSurface(app.debugHandles());
      })
      .catch((err) => console.warn('Stats surface failed to load', err))
  : Promise.resolve();

statsReady.then(() => app.start()).then(() => {
  if (!deepLink.url) return;

  let domain: string;
  try {
    domain = new URL(deepLink.url).hostname;
  } catch {
    return; // Not a URL at all — nothing to offer.
  }

  // Consent before fetching: the link was authored by whoever sent it, not
  // by the person opening it. `loadFromUrl` re-checks with `'link'`
  // strictness, so agreeing here cannot reach a private network address.
  if (window.confirm(`Load model from ${domain}?\n\n${deepLink.url}`)) {
    void app.loadFromUrl(deepLink.url, 'link');
  }
});
