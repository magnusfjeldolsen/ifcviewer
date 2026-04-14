export interface LoadedFile {
  name: string;
  buffer: ArrayBuffer;
}

export class FileLoader {
  private dropZone: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private onFileLoaded: ((file: LoadedFile) => void) | null = null;

  setupDropZone(element: HTMLElement): void {
    this.dropZone = element;

    element.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.add('drag-over');
    });

    element.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');
    });

    element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove('drag-over');

      const file = e.dataTransfer?.files[0];
      if (file && file.name.toLowerCase().endsWith('.ifc')) {
        this.readFile(file);
      }
    });
  }

  setupFileInput(input: HTMLInputElement): void {
    this.fileInput = input;

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) {
        this.readFile(file);
        input.value = '';
      }
    });
  }

  onLoad(callback: (file: LoadedFile) => void): void {
    this.onFileLoaded = callback;
  }

  private async readFile(file: File): Promise<void> {
    const buffer = await file.arrayBuffer();
    this.onFileLoaded?.({ name: file.name, buffer });
  }

  dispose(): void {
    this.dropZone = null;
    this.fileInput = null;
    this.onFileLoaded = null;
  }
}
