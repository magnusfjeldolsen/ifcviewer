import { describe, it, expect } from 'vitest';
import { OUT_OF_MEMORY_MESSAGE, isOutOfMemory, loadErrorStatus } from '../src/core/loadErrors';

/** Out-of-memory failures as the browser, V8, emscripten and web-ifc phrase them. */
const OUT_OF_MEMORY: unknown[] = [
  new RangeError('Array buffer allocation failed'), // new Float32Array(n) with no memory left
  'RangeError: Array buffer allocation failed', // the same, posted from a worker as text
  new RangeError('Out of memory'),
  // emscripten's abort() when malloc fails, as web-ifc's build words it:
  new Error('Aborted(OOM). Build with -sASSERTIONS for more info.'),
  // emscripten's heap at its 4 GB limit (web-ifc-api.js, _emscripten_resize_heap):
  'Cannot enlarge memory, requested 4294967296 bytes, but the limit is 4294901760 bytes!',
  'std::bad_alloc',
  new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded'),
  new RangeError('WebAssembly.Memory(): could not allocate memory'),
  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
  // The worker died during the parse (WorkerIfcParser):
  new Error('IFC worker crashed'),
  new Error('IFC worker crashed: Uncaught RangeError: Array buffer allocation failed'),
];

/** Failures that are not about memory keep their own text. */
const OTHER: unknown[] = [
  new Error('Invalid IFC file: no FILE_SCHEMA'),
  new RangeError('Invalid typed array length: -3'),
  new WebAssembly.RuntimeError('memory access out of bounds'),
  new Error('chunk coordinator crashed'),
  'storage is blocked by another tab of the viewer',
];

describe('isOutOfMemory', () => {
  it.each(OUT_OF_MEMORY.map((e) => [String(e), e]))('recognises %s', (_label, err) => {
    expect(isOutOfMemory(err)).toBe(true);
  });

  it.each(OTHER.map((e) => [String(e), e]))('leaves %s alone', (_label, err) => {
    expect(isOutOfMemory(err)).toBe(false);
  });

  it('copes with nothing at all', () => {
    expect(isOutOfMemory(undefined)).toBe(false);
    expect(isOutOfMemory(null)).toBe(false);
  });
});

describe('loadErrorStatus', () => {
  it('says plainly that the device ran out of memory, and what to do', () => {
    expect(loadErrorStatus(new Error('Aborted(OOM). Build with -sASSERTIONS for more info.'))).toBe(OUT_OF_MEMORY_MESSAGE);
    expect(OUT_OF_MEMORY_MESSAGE).toMatch(/more memory than this device has free/);
  });

  it('keeps any other error as it was', () => {
    expect(loadErrorStatus(new Error('Invalid IFC file'))).toBe('Error: Invalid IFC file');
    expect(loadErrorStatus('weird')).toBe('Error: Unknown error');
  });
});
