import { randomUUID } from 'node:crypto';
import type { TerminalOutput } from '../shared/terminal';

export interface TerminalDelivery {
  deliveryId: string;
  output: TerminalOutput;
}

/** Bound Electron's delivery queue independently of PTY/service acknowledgement.
 * A stalled view receives one replay hint per terminal when it recovers. The
 * service remains the authoritative output owner and never waits for a view.
 */
export class TerminalOutputDelivery {
  private pending = new Map<string, number>();
  private skipped = new Map<string, TerminalOutput>();
  private bytes = 0;
  constructor(private readonly send: (delivery: TerminalDelivery) => void,
    private readonly maxEvents = 32, private readonly maxBytes = 256 * 1024) {}
  offer(output: TerminalOutput): void {
    const bytes = Buffer.byteLength(output.data);
    if (this.pending.size >= this.maxEvents || this.bytes + bytes > this.maxBytes) {
      this.skipped.set(output.id, { ...output, data: '', gap: true });
      this.flush();
      return;
    }
    this.deliver(output, bytes);
  }
  acknowledge(id: string): void {
    const bytes = this.pending.get(id);
    if (bytes === undefined) return;
    this.pending.delete(id);
    this.bytes -= bytes;
    this.flush();
  }
  clear(): void {
    this.pending.clear(); this.skipped.clear(); this.bytes = 0;
  }
  private deliver(output: TerminalOutput, bytes: number) {
    const deliveryId = randomUUID();
    this.pending.set(deliveryId, bytes);
    this.bytes += bytes;
    try { this.send({ deliveryId, output }); }
    catch {
      this.pending.delete(deliveryId); this.bytes -= bytes;
      this.skipped.set(output.id, { ...output, data: '', gap: true });
      return false;
    }
    return true;
  }
  private flush() {
    while (this.skipped.size && this.pending.size < this.maxEvents) {
      const [id, output] = this.skipped.entries().next().value!;
      this.skipped.delete(id);
      if (!this.deliver(output, 0)) break;
    }
  }
}
