import { Viewer } from '../viewer/Viewer';

export class App {
  private viewer: Viewer;

  constructor(canvas: HTMLCanvasElement) {
    this.viewer = new Viewer(canvas);
  }

  start(): void {
    this.viewer.animate();
  }

  dispose(): void {
    this.viewer.dispose();
  }
}
