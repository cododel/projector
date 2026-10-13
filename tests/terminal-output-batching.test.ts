import { expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnostics } from './support/vitest-diagnostics';
import { TerminalService } from '../src/terminal/engine';
import type { TerminalOutput } from '../src/shared/terminal';

// Control PTY fragment boundaries while retaining real process ownership and xterm parsing.
const delivery = vi.hoisted(() => ({
  output: (data: string) => {
    void data;
  },
  pauses: 0,
  resumes: 0,
}));
vi.mock('node-pty', async (original) => {
  const actual = await original<typeof import('node-pty')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const pty = actual.spawn(...args);
      return new Proxy(pty, {
        get(target, key) {
          if (key === 'onData')
            return (listener: (data: string) => void) => {
              delivery.output = listener;
              return target.onData(listener);
            };
          if (key === 'pause' || key === 'resume')
            return () => {
              if (key === 'pause') delivery.pauses++;
              else delivery.resumes++;
              target[key]();
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});
it('parses waiting PTY fragments in bounded batches but preserves original replay and drains on Stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-output-batch-'));
  const output: TerminalOutput[] = [],
    writes: string[] = [];
  const service = new TerminalService(root, { output: (event) => output.push(event) });
  const original = Terminal.prototype.write;
  let release!: () => void;
  let entered!: () => void;
  const firstParsed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const spy = vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (
    this: Terminal,
    data,
    callback,
  ) {
    writes.push(String(data));
    original.call(this, data, () => {
      if (data === 'hold\r\n') {
        release = () => callback?.();
        entered();
      } else callback?.();
    });
  });
  try {
    await service.open();
    const terminal = await service.create({
      projectId: 'p',
      cwd: root,
      kind: 'shell',
      executable: '/bin/sh',
      args: ['-c', 'read line'],
    });
    delivery.output('hold\r\n');
    await firstParsed;
    const fragments = [
      '\x1b[',
      '31m',
      '日本語 🙂',
      '\x1b[0m\r\n',
      ...Array.from({ length: 100 }, () => 'x'.repeat(1024) + '\r\n'),
    ];
    fragments.forEach(delivery.output);
    const frame = service.screen(terminal.id);
    const stopping = service.stop(terminal.id);
    release();
    const saved = await frame;
    await stopping;
    expect(writes.length).toBeLessThan(10);
    expect(writes.slice(1).every((data) => Buffer.byteLength(data) <= 65536)).toBe(true);
    expect(writes.join('')).toBe('hold\r\n' + fragments.join(''));
    expect(output.map((event) => event.data)).toEqual(['hold\r\n', ...fragments]);
    expect(output.map((event) => event.seq)).toEqual(output.map((_, i) => i + 1));
    expect(saved.content).toContain('日本語 🙂');
    expect(saved.seq).toBe(fragments.length + 1);
    expect(service.snapshot()).toEqual([]);
  } finally {
    release?.();
    spy.mockRestore();
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it('reports unknown parser results without publishing output and still releases the owned process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-output-failure-'));
  const output: TerminalOutput[] = [];
  const service = new TerminalService(root, { output: (event) => output.push(event) });
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await service.open();
    const terminal = await service.create({
      projectId: 'p',
      cwd: root,
      kind: 'shell',
      executable: '/bin/sh',
      args: ['-c', 'read line'],
    });
    spy = vi.spyOn(Terminal.prototype, 'write').mockImplementation(() => {
      throw new Error('Synthetic parser failure');
    });
    diagnostics().expect({role:'terminal-service',kind:'output-error',phase:'test',message:'Error: Synthetic parser failure',count:1});
    delivery.output('uncertain');
    delivery.output('queued');
    await expect(service.screen(terminal.id)).rejects.toThrow('Synthetic parser failure');
    delivery.output('later');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(output).toEqual([]);
    expect(service.snapshot()[0].error).toContain('could not be parsed');
    await service.stop(terminal.id);
    expect(service.snapshot()).toEqual([]);
    expect(() => process.kill(terminal.pid!, 0)).toThrow();
  } finally {
    spy?.mockRestore();
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it('pauses a pressured PTY and resumes only after confirmed parser progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-output-pressure-'));
  const service = new TerminalService(root);
  const original = Terminal.prototype.write;
  let release!: () => void;
  let entered!: () => void;
  const parsed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const spy = vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (
    this: Terminal,
    data,
    callback,
  ) {
    original.call(this, data, () => {
      if (data === 'hold') {
        release = () => callback?.();
        entered();
      } else callback?.();
    });
  });
  delivery.pauses = delivery.resumes = 0;
  try {
    await service.open();
    const terminal = await service.create({
      projectId: 'p',
      cwd: root,
      kind: 'shell',
      executable: '/bin/sh',
      args: ['-c', 'read line'],
    });
    delivery.output('hold');
    await parsed;
    for (let i = 0; i < 80; i++) delivery.output('x'.repeat(65536));
    expect(delivery.pauses).toBe(1);
    expect(delivery.resumes).toBe(0);
    const frame = service.screen(terminal.id);
    release();
    expect((await frame).seq).toBe(81);
    expect(delivery.resumes).toBe(1);
    await service.stop(terminal.id);
  } finally {
    release?.();
    spy.mockRestore();
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
it('does not extend an in-flight screen read with output arriving after its confirmation barrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-output-barrier-'));
  const service = new TerminalService(root);
  const original = Terminal.prototype.write;
  let release!: () => void;
  let entered!: () => void;
  const parsed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const spy = vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (
    this: Terminal,
    data,
    callback,
  ) {
    original.call(this, data, () => {
      if (data === 'FIRST\r\n') {
        release = () => callback?.();
        entered();
      } else callback?.();
    });
  });
  try {
    await service.open();
    const terminal = await service.create({
      projectId: 'p',
      cwd: root,
      kind: 'shell',
      executable: '/bin/sh',
      args: ['-c', 'read line'],
    });
    delivery.output('FIRST\r\n');
    await parsed;
    const first = service.screen(terminal.id);
    delivery.output('LATER\r\n');
    release();
    const saved = await first;
    expect(saved.seq).toBe(1);
    expect(saved.content).not.toContain('LATER');
    expect((await service.screen(terminal.id)).seq).toBe(2);
    await service.stop(terminal.id);
  } finally {
    release?.();
    spy.mockRestore();
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
