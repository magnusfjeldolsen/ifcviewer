/**
 * What the status line says when a load fails.
 *
 * Running out of memory surfaces in many shapes — a V8 RangeError on the
 * page, an emscripten abort inside web-ifc, a WebAssembly memory that cannot
 * grow, a worker that dies outright — and none of them means anything to
 * someone opening a model. They all become one plain sentence that says what
 * to do. Every other error keeps its own text.
 */

export const OUT_OF_MEMORY_MESSAGE =
  'This model needs more memory than this device has free. Close other tabs or programs and try again.';

/** Messages that mean the load ran out of memory, wherever it happened. */
const OUT_OF_MEMORY_PATTERNS: readonly RegExp[] = [
  /array buffer allocation failed/i, // V8: new ArrayBuffer / typed array on the page or in a worker
  /out of memory/i, // V8 "Out of memory", "JavaScript heap out of memory"
  /aborted\(oom\)/i, // emscripten abort when malloc fails
  /cannot enlarge memory/i, // emscripten: wasm heap at its limit
  /bad_alloc/i, // a C++ allocation failure reaching JS
  /webassembly\.memory(\(\)|\.grow\(\))?:.*(maximum memory size|could not allocate|out of memory)/i, // wasm memory grow / create
  /could not allocate memory/i,
  /allocation failed/i, // "Allocation failed - process out of memory" and kin
  /ifc worker crashed/i, // the worker died during a parse: by far the likeliest cause is memory
];

/** Whether `err` (an Error, a message, anything thrown) means the load ran out of memory. */
export function isOutOfMemory(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return OUT_OF_MEMORY_PATTERNS.some((p) => p.test(text));
}

/** The status line for a failed load. */
export function loadErrorStatus(err: unknown): string {
  if (isOutOfMemory(err)) return OUT_OF_MEMORY_MESSAGE;
  const msg = err instanceof Error ? err.message : 'Unknown error';
  return `Error: ${msg}`;
}
