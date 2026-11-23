/**
 * Transient status messages: each clears itself after a while, unless a
 * newer message has been shown by then. Messages are told apart by a
 * counter, not by their text, so the same text shown twice is not cleared
 * early by the first one's timer.
 */
export class StatusTimer {
  private serial = 0;

  constructor(
    private readonly clear: () => void,
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  ) {}

  /** A message was shown (any message, including an empty one). */
  shown(): void {
    this.serial++;
  }

  /** Clear the message shown last after `ms`, unless another is shown first. */
  clearAfter(ms: number): void {
    const serial = this.serial;
    this.schedule(() => {
      if (this.serial === serial) this.clear();
    }, ms);
  }
}
