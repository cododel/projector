/** App-owned metadata polling. It never starts/resumes a harness or reads turns. */
export class HarnessSync {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private stopped = true;
  constructor(
    private readonly synchronize: () => Promise<void>,
    private readonly interval = 15000,
  ) {}
  start() {
    this.stopped = false;
    void this.refresh().catch(() => {});
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Harness synchronization is stopped.'));
    if (this.pending) return this.pending;
    clearTimeout(this.timer);
    const operation = Promise.resolve().then(this.synchronize);
    this.pending = operation;
    void operation
      .finally(() => {
        if (this.pending === operation) this.pending = undefined;
        if (!this.stopped) {
          this.timer = setTimeout(() => {
            void this.refresh().catch(() => {});
          }, this.interval);
          this.timer.unref();
        }
      })
      .catch(() => {});
    return operation;
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
  async settled() {
    await this.pending?.catch(() => {});
  }
}
