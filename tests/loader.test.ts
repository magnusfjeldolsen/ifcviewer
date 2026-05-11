// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileLoader } from '../src/loader/FileLoader';

function makeDragEvent(type: string, files: File[] = [], types?: string[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const resolvedTypes = types ?? (files.length ? ['Files'] : []);
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files,
      types: resolvedTypes,
      items: files.map(f => ({ kind: 'file', getAsFile: () => f })),
    },
  });
  return event;
}

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

describe('FileLoader', () => {
  it('should be instantiable', () => {
    const loader = new FileLoader();
    expect(loader).toBeDefined();
    loader.dispose();
  });

  it('should register onLoad callback', () => {
    const loader = new FileLoader();
    const callback = vi.fn();
    loader.onLoad(callback);
    expect(loader).toBeDefined();
    loader.dispose();
  });

  it('should clean up on dispose', () => {
    const loader = new FileLoader();
    loader.dispose();
    expect(loader).toBeDefined();
  });
});

describe('FileLoader document-level drag-drop', () => {
  let dropZone: HTMLElement;
  let loader: FileLoader;

  beforeEach(() => {
    document.body.innerHTML = '';
    dropZone = document.createElement('div');
    dropZone.id = 'drop-zone';
    document.body.appendChild(dropZone);
    loader = new FileLoader();
    loader.setupDropZone(dropZone);
  });

  afterEach(() => {
    loader.dispose();
    document.body.innerHTML = '';
  });

  it('routes .ifc drops to onLoad', async () => {
    const onLoad = vi.fn();
    loader.onLoad(onLoad);
    const file = new File(['ISO-10303-21;'], 'model.ifc');
    document.dispatchEvent(makeDragEvent('drop', [file]));
    await flushMicrotasks();
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad.mock.calls[0][0].name).toBe('model.ifc');
  });

  it('still works after upload-prompt is hidden (after first model loaded)', async () => {
    // After first load the App hides #upload-prompt; verify drop still fires.
    const prompt = document.createElement('div');
    prompt.id = 'upload-prompt';
    prompt.style.display = 'none';
    dropZone.appendChild(prompt);

    const onLoad = vi.fn();
    loader.onLoad(onLoad);
    const file = new File(['ISO-10303-21;'], 'second.ifc');
    document.dispatchEvent(makeDragEvent('drop', [file]));
    await flushMicrotasks();
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad.mock.calls[0][0].name).toBe('second.ifc');
  });

  it('adds drag-over class on dragenter when files are being dragged', () => {
    document.dispatchEvent(makeDragEvent('dragenter', [new File(['x'], 'x.ifc')]));
    expect(dropZone.classList.contains('drag-over')).toBe(true);
  });

  it('does not add drag-over class for non-file drags', () => {
    document.dispatchEvent(makeDragEvent('dragenter', [], ['text/plain']));
    expect(dropZone.classList.contains('drag-over')).toBe(false);
  });

  it('keeps drag-over class until the counter returns to zero (handles nested children)', () => {
    const file = new File(['x'], 'x.ifc');
    document.dispatchEvent(makeDragEvent('dragenter', [file]));
    document.dispatchEvent(makeDragEvent('dragenter', [file]));
    expect(dropZone.classList.contains('drag-over')).toBe(true);

    document.dispatchEvent(makeDragEvent('dragleave', [file]));
    expect(dropZone.classList.contains('drag-over')).toBe(true);

    document.dispatchEvent(makeDragEvent('dragleave', [file]));
    expect(dropZone.classList.contains('drag-over')).toBe(false);
  });

  it('drop clears the drag-over class', () => {
    const file = new File(['x'], 'x.ifc');
    document.dispatchEvent(makeDragEvent('dragenter', [file]));
    expect(dropZone.classList.contains('drag-over')).toBe(true);
    document.dispatchEvent(makeDragEvent('drop', [file]));
    expect(dropZone.classList.contains('drag-over')).toBe(false);
  });

  it('ignores files that are not .ifc', async () => {
    const onLoad = vi.fn();
    loader.onLoad(onLoad);
    document.dispatchEvent(makeDragEvent('drop', [new File(['x'], 'photo.jpg')]));
    await flushMicrotasks();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('removes document listeners on dispose', async () => {
    const onLoad = vi.fn();
    loader.onLoad(onLoad);
    loader.dispose();
    document.dispatchEvent(makeDragEvent('drop', [new File(['x'], 'x.ifc')]));
    await flushMicrotasks();
    expect(onLoad).not.toHaveBeenCalled();
  });
});
