import type { TerminalOutput, TerminalReplay, TerminalScreen } from '../shared/terminal';

/** A renderer is a resumable consumer, never a source of PTY backpressure. */
export class TerminalOutputReader {
  private seq = 0;
  private generation: string | undefined;
  private retiredGenerations = new Set<string>();
  private ready = false;
  private stopped = false;
  private draining = false;
  private pending: TerminalOutput[] = [];
  private bytes = 0;
  constructor(
    private readonly source: {
      screen(): Promise<TerminalScreen>;
      replay(afterSeq: number): Promise<TerminalReplay>;
      reset(screen: TerminalScreen): Promise<void>;
      write(data: string): Promise<void>;
      error(error: unknown): void;
    },
    private readonly maxBytes = 2 * 1024 * 1024,
  ) {}
  async start(): Promise<void> {
    await this.restore();
    if (this.stopped) return;
    this.ready = true;
    void this.drain();
  }
  stop(): void {
    this.stopped = true;
    this.pending = [];
    this.bytes = 0;
  }
  push(output: TerminalOutput): void {
    if (
      this.stopped ||
      (output.generation && this.retiredGenerations.has(output.generation)) ||
      (this.sameGeneration(output) && output.seq <= this.seq)
    )
      return;
    this.pending.push(output);
    this.bytes += output.data.length * 2;
    if (this.bytes > this.maxBytes || this.pending.length > 256) {
      this.pending = [{ ...output, data: '', gap: true }];
      this.bytes = 0;
    }
    if (this.ready) void this.drain();
  }
  private async restore(): Promise<void> {
    const screen = await this.source.screen();
    if (this.stopped) return;
    await this.source.reset(screen);
    if (this.generation && this.generation !== screen.generation) {
      this.retiredGenerations.add(this.generation);
      if (this.retiredGenerations.size > 32)
        this.retiredGenerations.delete(this.retiredGenerations.values().next().value!);
    }
    this.generation = screen.generation;
    this.seq = screen.seq;
  }
  private sameGeneration(output: { generation?: string }): boolean {
    return output.generation === undefined || output.generation === this.generation;
  }
  private async accept(output: TerminalOutput): Promise<void> {
    if (this.stopped || (output.generation && this.retiredGenerations.has(output.generation)))
      return;
    if (!this.sameGeneration(output)) {
      // Sequence numbers belong to a service incarnation. A crash can restore an
      // older confirmed sequence; read that incarnation's authoritative screen.
      await this.restore();
      if (!this.sameGeneration(output)) return;
    }
    if (output.seq <= this.seq || this.stopped) return;
    if (output.gap || output.seq !== this.seq + 1) {
      const replay = await this.source.replay(this.seq);
      if (this.stopped) return;
      if (replay.gap || !this.sameGeneration(replay)) await this.restore();
      else
        for (const event of replay.events) {
          if (this.stopped) return;
          if (event.seq <= this.seq) continue;
          if (!this.sameGeneration(event) || event.seq !== this.seq + 1) {
            await this.restore();
            break;
          }
          await this.source.write(event.data);
          this.seq = event.seq;
        }
    }
    if (!this.sameGeneration(output) || output.seq <= this.seq || this.stopped) return;
    if (output.seq !== this.seq + 1) {
      await this.restore();
      return;
    }
    await this.source.write(output.data);
    this.seq = output.seq;
  }
  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (this.pending.length && !this.stopped) {
        const event = this.pending.shift()!;
        this.bytes -= event.data.length * 2;
        // Batch only an already contiguous live stream. Gaps and incarnation
        // changes still reconcile through the authoritative screen/replay path.
        if (!event.gap && this.sameGeneration(event) && event.seq === this.seq + 1) {
          const batch = [event];
          let size = event.data.length * 2;
          while (this.pending.length) {
            const next = this.pending[0];
            if (
              next.gap ||
              next.generation !== event.generation ||
              next.seq !== batch[batch.length - 1].seq + 1 ||
              size + next.data.length * 2 > 65536
            )
              break;
            this.pending.shift();
            this.bytes -= next.data.length * 2;
            size += next.data.length * 2;
            batch.push(next);
          }
          await this.source.write(batch.map((item) => item.data).join(''));
          this.seq = batch[batch.length - 1].seq;
        } else await this.accept(event);
      }
    } catch (error) {
      if (!this.stopped) {
        // The parser may already have consumed part of a rejected write. Do not
        // replay it or continue drawing until a new view restores a fresh screen.
        this.stop();
        this.source.error(error);
      }
    } finally {
      this.draining = false;
    }
  }
}
