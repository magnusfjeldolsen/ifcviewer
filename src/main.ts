import { App } from './core/App';

const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
if (!canvas) {
  throw new Error('Canvas element #viewer-canvas not found');
}

const app = new App(canvas);
app.start();

// Enable drag-drop on the full page
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
