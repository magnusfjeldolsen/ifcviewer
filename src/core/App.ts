import { Viewer } from '../viewer/Viewer';
import { ModelManager } from '../viewer/ModelManager';
import { FileLoader } from '../loader/FileLoader';
import { IfcParser } from '../parser/IfcParser';
import type { LoadedFile } from '../loader/FileLoader';

export class App {
  private viewer: Viewer;
  private modelManager: ModelManager;
  private fileLoader: FileLoader;
  private parser: IfcParser;
  private statusEl: HTMLElement | null;

  constructor(canvas: HTMLCanvasElement) {
    this.viewer = new Viewer(canvas);
    this.modelManager = new ModelManager(this.viewer.getScene());
    this.fileLoader = new FileLoader();
    this.parser = new IfcParser();
    this.statusEl = document.getElementById('status');
  }

  async start(): Promise<void> {
    this.setStatus('Initializing IFC engine...');
    await this.parser.init();
    this.setStatus('');

    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input') as HTMLInputElement | null;

    if (dropZone) this.fileLoader.setupDropZone(dropZone);
    if (fileInput) this.fileLoader.setupFileInput(fileInput);

    this.fileLoader.onLoad((file) => this.handleFile(file));

    this.viewer.animate();
    this.showUploadPrompt(true);
  }

  private async handleFile(file: LoadedFile): Promise<void> {
    try {
      this.showUploadPrompt(false);
      this.setStatus(`Loading ${file.name}...`);

      const parsed = await this.parser.parse(file.buffer, file.name);
      this.modelManager.addModel(parsed);

      const box = this.modelManager.getBoundingBox();
      this.viewer.fitToBox(box);

      this.setStatus(`Loaded ${file.name} (${parsed.meshes.length} objects)`);
      setTimeout(() => this.setStatus(''), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.setStatus(`Error: ${msg}`);
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private showUploadPrompt(show: boolean): void {
    const prompt = document.getElementById('upload-prompt');
    if (prompt) prompt.style.display = show ? 'flex' : 'none';
  }

  dispose(): void {
    this.modelManager.dispose();
    this.fileLoader.dispose();
    this.parser.dispose();
    this.viewer.dispose();
  }
}
