import { App } from './core/App';

const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
if (!canvas) {
  throw new Error('Canvas element #viewer-canvas not found');
}

const app = new App(canvas);
app.start();
