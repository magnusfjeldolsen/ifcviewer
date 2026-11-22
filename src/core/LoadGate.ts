/**
 * Knows whether a model is loading, so work that can wait — parameter
 * discovery — never starts during a load and competes with it.
 */
export class LoadGate {
  private active = 0;
  private waiters: Array<() => void> = [];

  /** A load starts. Call the returned function once when it ends, however it ends. */
  begin(): () => void {
    this.active++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.active--;
      if (this.active === 0) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters) w();
        for (const l of this.idleListeners) l();
      }
    };
  }

  private idleListeners: Array<() => void> = [];

  /** Call `listener` every time the last running load ends. */
  onIdle(listener: () => void): void {
    this.idleListeners.push(listener);
  }

  get busy(): boolean {
    return this.active > 0;
  }

  /** Settles when no load is running: at once if none is. */
  idle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
