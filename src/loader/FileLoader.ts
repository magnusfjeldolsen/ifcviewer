export interface LoadedFile {
  name: string;
  buffer: ArrayBuffer;
}

export class FileLoader {
  private dropZone: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private onFileLoaded: ((file: LoadedFile) => void) | null = null;
  private dragCounter = 0;
  private docDragEnter: ((e: DragEvent) => void) | null = null;
  private docDragOver: ((e: DragEvent) => void) | null = null;
  private docDragLeave: ((e: DragEvent) => void) | null = null;
  private docDrop: ((e: DragEvent) => void) | null = null;

  setupDropZone(element: HTMLElement): void {
    this.dropZone = element;

    const hasFiles = (e: DragEvent): boolean => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      // types is DOMStringList in some browsers, array-like in jsdom
      for (let i = 0; i < types.length; i++) {
        if (types[i] === 'Files') return true;
      }
      return false;
    };

    this.docDragEnter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.dragCounter++;
      element.classList.add('drag-over');
    };

    this.docDragOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    };

    this.docDragLeave = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.dragCounter = Math.max(0, this.dragCounter - 1);
      if (this.dragCounter === 0) {
        element.classList.remove('drag-over');
      }
    };

    this.docDrop = (e) => {
      e.preventDefault();
      this.dragCounter = 0;
      element.classList.remove('drag-over');

      const file = e.dataTransfer?.files[0];
      if (file && file.name.toLowerCase().endsWith('.ifc')) {
        this.readFile(file);
      }
    };

    document.addEventListener('dragenter', this.docDragEnter);
    document.addEventListener('dragover', this.docDragOver);
    document.addEventListener('dragleave', this.docDragLeave);
    document.addEventListener('drop', this.docDrop);
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
    if (this.docDragEnter) document.removeEventListener('dragenter', this.docDragEnter);
    if (this.docDragOver) document.removeEventListener('dragover', this.docDragOver);
    if (this.docDragLeave) document.removeEventListener('dragleave', this.docDragLeave);
    if (this.docDrop) document.removeEventListener('drop', this.docDrop);
    this.docDragEnter = null;
    this.docDragOver = null;
    this.docDragLeave = null;
    this.docDrop = null;
    this.dropZone = null;
    this.fileInput = null;
    this.onFileLoaded = null;
  }
}
