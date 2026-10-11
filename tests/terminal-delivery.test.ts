import { describe, it, expect } from 'vitest';
import { TerminalOutputDelivery, type TerminalDelivery } from '../src/main/terminal-delivery';

describe('bounded renderer output delivery', () => {
  it('limits unacknowledged bytes and resumes from one newest replay hint', () => {
    const sent: TerminalDelivery[] = [];
    const delivery = new TerminalOutputDelivery(value => sent.push(value));
    for (let seq = 1; seq <= 100; seq++) delivery.offer({ id: 'terminal', seq, data: 'x'.repeat(150000) });
    expect(sent.reduce((bytes, item) => bytes + Buffer.byteLength(item.output.data), 0)).toBeLessThanOrEqual(256 * 1024);
    expect(sent).toHaveLength(32);
    delivery.acknowledge(sent[0].deliveryId);
    expect(sent.at(-1)?.output).toEqual({ id: 'terminal', seq: 100, data: '', gap: true });
    const count = sent.length;
    delivery.acknowledge(sent[0].deliveryId);
    expect(sent).toHaveLength(count);
    delivery.clear();
    delivery.offer({ id: 'terminal', seq: 101, data: 'fresh' });
    expect(sent.at(-1)?.output.data).toBe('fresh');
  });
  it('retains a replay hint when the view disappears without blocking the service', () => {
    const sent: TerminalDelivery[] = [];
    let unavailable = true;
    const delivery = new TerminalOutputDelivery(value => {
      if (unavailable) throw Error('View destroyed');
      sent.push(value);
    });
    expect(() => delivery.offer({ id: 'terminal', seq: 1, data: 'retained by PTY owner' })).not.toThrow();
    unavailable = false;
    delivery.offer({ id: 'terminal', seq: 2, data: 'fresh' });
    delivery.acknowledge(sent[0].deliveryId);
    expect(sent.at(-1)?.output.gap).toBe(true);
  });
});
