/** A single reader with a retained invalidation, including while operator writes are pending. */
export class RefreshQueue {
  private version = 0;
  private pending = false;
  private running = false;
  private scheduled = false;
  private holds = 0;
  private waiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];

  constructor(
    private readonly read: (isCurrent: () => boolean) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Notifications need no promise, but must never be discarded during a read or write. */
  invalidate(): void {
    this.version++;
    this.pending = true;
    this.schedule();
  }

  /** Operator actions wait for the coherent read, including invalidations received in flight. */
  request(): Promise<void> {
    const done = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    this.invalidate();
    return done;
  }

  /** Pausing invalidates a running result without cancelling or reordering persistent writes. */
  pause(): () => void {
    this.holds++;
    if (this.running) {
      this.version++;
      this.pending = true;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.schedule();
    };
  }

  private schedule(): void {
    if (this.scheduled || this.running || this.holds || !this.pending) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running || this.holds || !this.pending) return;
    this.running = true;
    try {
      while (this.pending && !this.holds) {
        this.pending = false;
        const version = this.version;
        try {
          await this.read(() => version === this.version && this.holds === 0);
        } catch (error) {
          for (const waiter of this.waiters.splice(0)) waiter.reject(error);
          this.onError(error);
        }
      }
      if (!this.pending && !this.holds)
        for (const waiter of this.waiters.splice(0)) waiter.resolve();
    } finally {
      this.running = false;
      this.schedule();
    }
  }
}
