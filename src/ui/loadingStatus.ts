import type { StreamProgress } from '../parser/types';

/**
 * The status line while a model streams in. The total comes from the model's
 * type index before any geometry exists, and counts a few products that turn
 * out to have no body, so it is "about": the count runs up to it, and may stop
 * a little short. The exact number is in the "Loaded" line that follows.
 */
export function loadingStatus(name: string, progress: StreamProgress): string {
  const total = Math.max(progress.total, progress.loaded);
  return `Loading ${name}… (${progress.loaded.toLocaleString()} of about ${total.toLocaleString()} elements)`;
}
