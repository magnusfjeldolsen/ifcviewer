import { App } from './core/App';

const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
if (!canvas) {
  throw new Error('Canvas element #viewer-canvas not found');
}

const app = new App(canvas);
app.start().then(() => {
  // Check for ?url= query parameter
  const params = new URLSearchParams(window.location.search);
  const url = params.get('url');
  if (url) {
    try {
      const domain = new URL(url).hostname;
      const confirmed = window.confirm(
        `Load model from ${domain}?\n\n${url}`,
      );
      if (confirmed) {
        app.loadFromUrl(url);
      }
    } catch {
      // Invalid URL — ignore silently
    }
  }
});
