import { describe, expect, it } from 'vitest';
import { TerminalOutputReader } from '../src/renderer/terminal-output';
import type { TerminalOutput, TerminalScreen } from '../src/shared/terminal';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const screen = (seq: number, content: string): TerminalScreen => ({
  id: 'terminal',
  seq,
  content,
  rows: 24,
  cols: 80,
  truncated: false,
});
const event = (seq: number, data: string, gap?: boolean): TerminalOutput => ({
  id: 'terminal',
  seq,
  data,
  gap,
});
describe('ordered renderer terminal consumption', () => {
  it('buffers events racing screen restoration and ignores older/duplicate output', async () => {
    let resolve!: (value: TerminalScreen) => void;
    const output: string[] = [];
    const reader = new TerminalOutputReader({
      screen: () =>
        new Promise((done) => {
          resolve = done;
        }),
      replay: async () => {
        throw new Error('Unexpected replay');
      },
      reset: async (value) => {
        output.push(value.content);
      },
      write: async (data) => {
        output.push(data);
      },
      error: (error) => {
        throw error;
      },
    });
    const start = reader.start();
    reader.push(event(1, 'old'));
    reader.push(event(3, 'new'));
    reader.push(event(3, 'duplicate'));
    resolve(screen(2, 'saved'));
    await start;
    await tick();
    expect(output).toEqual(['saved', 'new']);
    reader.stop();
  });
  it('replays a sequence gap once and does not repeat the live event', async () => {
    const output: string[] = [],
      after: number[] = [];
    const reader = new TerminalOutputReader({
      screen: async () => screen(5, 'saved'),
      replay: async (seq) => {
        after.push(seq);
        return {
          id: 'terminal',
          seq: 8,
          gap: false,
          events: [event(6, 'a'), event(7, 'b'), event(8, 'c')],
        };
      },
      reset: async (value) => {
        output.push(value.content);
      },
      write: async (data) => {
        output.push(data);
      },
      error: (error) => {
        throw error;
      },
    });
    await reader.start();
    reader.push(event(8, 'c'));
    await tick();
    expect(after).toEqual([5]);
    expect(output).toEqual(['saved', 'a', 'b', 'c']);
    reader.stop();
  });
  it('bounds pending output while the renderer is slow and reseeks the authoritative screen', async () => {
    let release!: () => void;
    let reads = 0;
    const output: string[] = [],
      after: number[] = [];
    const reader = new TerminalOutputReader(
      {
        screen: async () => screen(reads++ === 0 ? 0 : 20, reads === 1 ? 'initial' : 'latest'),
        replay: async (seq) => {
          after.push(seq);
          return { id: 'terminal', seq: 20, gap: true, events: [] };
        },
        reset: async (value) => {
          output.push(value.content);
        },
        write: async (data) => {
          output.push(data);
          if (data === 'hold')
            await new Promise<void>((done) => {
              release = done;
            });
        },
        error: (error) => {
          throw error;
        },
      },
      32,
    );
    await reader.start();
    reader.push(event(1, 'hold'));
    await tick();
    for (let seq = 2; seq <= 20; seq++) reader.push(event(seq, 'large output'));
    release();
    await tick();
    await tick();
    expect(output).toEqual(['initial', 'hold', 'latest']);
    expect(after).toEqual([1]);
    expect(reads).toBe(2);
    reader.stop();
  });
  it('does not draw a late screen after its pane was closed', async () => {
    let resolve!: (value: TerminalScreen) => void;
    const output: string[] = [];
    const reader = new TerminalOutputReader({
      screen: () =>
        new Promise((done) => {
          resolve = done;
        }),
      replay: async () => ({ id: 'terminal', seq: 0, events: [], gap: false }),
      reset: async (value) => {
        output.push(value.content);
      },
      write: async (data) => {
        output.push(data);
      },
      error: (error) => {
        throw error;
      },
    });
    const start = reader.start();
    reader.stop();
    resolve(screen(1, 'late'));
    await start;
    expect(output).toEqual([]);
  });
  it('resets a rolled-back sequence on a new stream generation and discards late old output', async () => {
    let current = { ...screen(9, 'old saved'), generation: 'old' };
    const output: string[] = [];
    const reader = new TerminalOutputReader({
      screen: async () => current,
      replay: async () => {
        throw new Error('Unexpected replay');
      },
      reset: async (value) => {
        output.push('reset:' + value.content);
      },
      write: async (data) => {
        output.push(data);
      },
      error: (error) => {
        throw error;
      },
    });
    await reader.start();
    reader.push({ ...event(10, 'unconfirmed'), generation: 'old' });
    await tick();
    current = { ...screen(2, 'new saved with fresh'), generation: 'new' };
    reader.push({ ...event(2, 'fresh'), generation: 'new' });
    await tick();
    reader.push({ ...event(11, 'late old'), generation: 'old' });
    reader.push({ ...event(3, 'next'), generation: 'new' });
    reader.push({ ...event(3, 'duplicate'), generation: 'new' });
    await tick();
    expect(output).toEqual([
      'reset:old saved',
      'unconfirmed',
      'reset:new saved with fresh',
      'next',
    ]);
    reader.stop();
  });
});
