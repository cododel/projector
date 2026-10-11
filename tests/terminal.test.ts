import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalService } from '../src/terminal/engine';
import type { TerminalOutput, TerminalRecord } from '../src/shared/terminal';
const services: TerminalService[] = [];
const dirs: string[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(services.splice(0).map((s) => s.shutdown()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  const failure = results.find((r) => r.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
});
async function setup(options = {}) {
  const data = await mkdtemp(join(tmpdir(), 'bp-terminal-'));
  dirs.push(data);
  const output: TerminalOutput[] = [];
  const changes: TerminalRecord[][] = [];
  const service = new TerminalService(
    data,
    { output: (e) => output.push(e), change: (r) => changes.push(r) },
    options,
  );
  services.push(service);
  await service.open();
  return { data, service, output, changes };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error('Terminal did not reach the expected observable state.');
    await new Promise((r) => setTimeout(r, 10));
  }
}
it('starts a real PTY, routes Unicode only through its active view and applies the active viewport size', async () => {
  const { data, service, output } = await setup();
  const terminal = await service.create({
    projectId: 'project',
    cwd: data,
    kind: 'shell',
    executable: '/bin/sh',
    args: [
      '-c',
      'stty -echo; printf "PTY_READY\\n"; IFS= read -r line; printf "INPUT:%s\\n" "$line"; printf "SIZE:"; stty size; exit 7',
    ],
  });
  expect(terminal.status).toBe('running');
  await until(() => output.some((e) => e.data.includes('PTY_READY')));
  service.resize(terminal.id, { cols: 101, rows: 37, viewId: 'active', active: true });
  service.resize(terminal.id, { cols: 20, rows: 5, viewId: 'background', active: false });
  expect(() => service.input(terminal.id, 'wrong\r', 'background')).toThrow(
    /Select the terminal pane/,
  );
  service.input(terminal.id, 'Привет 🙂 日本語\r', 'active');
  await until(() => service.snapshot()[0].status === 'exited');
  const frame = await service.screen(terminal.id);
  expect(frame.content).toContain('INPUT:Привет 🙂 日本語');
  expect(frame.content).toContain('SIZE:37 101');
  expect(service.snapshot()[0].exitCode).toBe(7);
  expect(output.map((e) => e.seq)).toEqual(output.map((_, i) => i + 1));
  expect(output.map((e) => e.data).join('')).not.toContain('wrong');
});
it('preserves the real terminal after view detachment and restores its saved screen without executing again', async () => {
  const { data, service, output } = await setup();
  const terminal = await service.create({
    projectId: 'project',
    cwd: data,
    kind: 'shell',
    executable: '/bin/sh',
    args: [
      '-c',
      'stty -echo; printf "READY\\n"; read first; printf "DETACHED_OUTPUT\\n"; read second; printf "AFTER_REATTACH\\n"; read third',
    ],
  });
  await until(() => output.some((e) => e.data.includes('READY')));
  service.resize(terminal.id, { cols: 80, rows: 24, viewId: 'pane', active: true });
  service.input(terminal.id, '\r', 'pane');
  service.resize(terminal.id, { cols: 80, rows: 24, viewId: 'pane', active: false });
  await until(() => output.some((e) => e.data.includes('DETACHED_OUTPUT')));
  expect(service.snapshot()[0].pid).toBe(terminal.pid);
  expect(service.snapshot()[0].status).toBe('running');
  service.resize(terminal.id, { cols: 80, rows: 24, viewId: 'reopened', active: true });
  service.input(terminal.id, '\r', 'reopened');
  await until(() => output.some((e) => e.data.includes('AFTER_REATTACH')));
  await service.shutdown();
  services.splice(services.indexOf(service), 1);
  const restored = new TerminalService(data);
  services.push(restored);
  await restored.open();
  expect(restored.snapshot()).toMatchObject([
    { id: terminal.id, status: 'inactive', cwd: await realpath(data), projectId: 'project' },
  ]);
  expect(restored.snapshot()[0].pid).toBeUndefined();
  expect((await restored.screen(terminal.id)).content).toContain('AFTER_REATTACH');
  expect(() => restored.input(terminal.id, 'run again\r', 'pane')).toThrow();
});
it('limits scrollback and replay and discloses removed history', async () => {
  const { data, service, output } = await setup({ scrollback: 100, maxReplayBytes: 1024 });
  const terminal = await service.create({
    projectId: 'p',
    cwd: data,
    kind: 'shell',
    executable: '/bin/sh',
    args: [
      '-c',
      'i=0; while [ "$i" -lt 400 ]; do printf "LINE:%04d long fixture text for replay bytes\\n" "$i"; i=$((i+1)); done; read line',
    ],
  });
  await until(() =>
    output
      .map((e) => e.data)
      .join('')
      .includes('LINE:0399'),
  );
  const frame = await service.screen(terminal.id);
  expect(frame.truncated).toBe(true);
  expect(frame.content).toContain('LINE:0399');
  expect(frame.content).not.toContain('LINE:0000');
  const replay = service.replay(terminal.id, 0);
  expect(replay.gap).toBe(true);
  expect(replay.events.reduce((n, e) => n + Buffer.byteLength(e.data), 0)).toBeLessThanOrEqual(
    1024,
  );
  await expect(service.configure({ scrollback: 99 })).rejects.toThrow();
});
it('reads the owned shell current cwd after cd and preserves it after Stop and inactive restoration', async () => {
  const { data, service, output } = await setup();
  const nested = join(data, 'nested folder 日本語');
  await mkdir(nested);
  const canonical = await realpath(nested);
  const source = await service.create({
    projectId: 'project',
    cwd: data,
    kind: 'shell',
    executable: '/bin/sh',
    args: [],
  });
  service.resize(source.id, { cols: 100, rows: 24, viewId: 'source', active: true });
  service.input(
    source.id,
    `stty -echo; cd '${nested.replaceAll("'", "'\\''")}'; printf 'CWD_READY\\n'\r`,
    'source',
  );
  await until(() =>
    output
      .map((event) => event.data)
      .join('')
      .includes('\r\nCWD_READY\r\n'),
  );
  expect(await service.currentCwd(source.id)).toBe(canonical);
  expect(service.snapshot()[0].cwd).toBe(canonical);
  const split = await service.create({
    projectId: 'project',
    cwd: await service.currentCwd(source.id),
    kind: 'shell',
    executable: '/bin/sh',
    args: ['-c', 'printf "SPLIT_CWD:"; pwd -P; read line'],
  });
  await until(() =>
    output
      .filter((event) => event.id === split.id)
      .map((event) => event.data)
      .join('')
      .includes(`SPLIT_CWD:${canonical}`),
  );
  await service.stop(source.id);
  await service.shutdown();
  services.splice(services.indexOf(service), 1);
  const restored = new TerminalService(data);
  services.push(restored);
  await restored.open();
  expect(restored.snapshot()).toHaveLength(2);
  expect(
    restored
      .snapshot()
      .every(
        (record) =>
          record.status === 'inactive' && record.cwd === canonical && record.pid === undefined,
      ),
  ).toBe(true);
  expect(await restored.currentCwd(source.id)).toBe(canonical);
});
it('applies smaller history limits immediately and discloses truncation without waiting for more output', async () => {
  const { data, service, output } = await setup();
  const terminal = await service.create({
    projectId: 'p',
    cwd: data,
    kind: 'shell',
    executable: '/bin/sh',
    args: [
      '-c',
      'i=0; while [ "$i" -lt 400 ]; do printf "CONFIG_LINE:%04d long fixture history\\n" "$i"; i=$((i+1)); done; read line',
    ],
  });
  await until(() =>
    output
      .map((event) => event.data)
      .join('')
      .includes('CONFIG_LINE:0399'),
  );
  const before = await service.screen(terminal.id);
  expect(before.content).toContain('CONFIG_LINE:0000');
  expect(before.truncated).toBe(false);
  await service.configure({ scrollback: 100, maxReplayBytes: 1024 });
  const after = await service.screen(terminal.id);
  expect(after.truncated).toBe(true);
  expect(after.content).not.toContain('CONFIG_LINE:0000');
  expect(after.content).toContain('CONFIG_LINE:0399');
  const replay = service.replay(terminal.id, 0);
  expect(replay.gap).toBe(true);
  expect(
    replay.events.reduce((sum, event) => sum + Buffer.byteLength(event.data), 0),
  ).toBeLessThanOrEqual(1024);
});
it('does not persist launch arguments or environment credentials and deduplicates concurrent creation', async () => {
  const { data, service } = await setup();
  const input = {
    projectId: 'p',
    cwd: data,
    kind: 'shell' as const,
    executable: '/bin/sh',
    args: ['-c', '# launch-only-secret\nread line'],
    env: { BLUEPRINT_FIXTURE_SECRET: 'synthetic-auth-token' },
    operationId: 'same-create',
  };
  const [a, b] = await Promise.all([service.create(input), service.create(input)]);
  expect(a.id).toBe(b.id);
  expect(service.snapshot()).toHaveLength(1);
  await service.stop(a.id);
  const disk = await readFile(join(data, 'terminals', 'catalog.json'), 'utf8');
  expect(disk).not.toContain('launch-only-secret');
  expect(disk).not.toContain('synthetic-auth-token');
  expect(disk).not.toContain('BLUEPRINT_FIXTURE_SECRET');
  expect(disk).not.toContain('"pid"');
  expect((await service.create(input)).id).toBe(a.id);
  expect(service.snapshot()).toHaveLength(1);
});
it('terminates both its PTY and a child process when Stop is requested', async () => {
  const { data, service, output } = await setup();
  const terminal = await service.create({
    projectId: 'p',
    cwd: data,
    kind: 'shell',
    executable: '/bin/sh',
    args: ['-c', 'sleep 30 & child=$!; printf "CHILD:%s\\n" "$child"; wait'],
  });
  await until(() => output.some((e) => e.data.includes('CHILD:')));
  const child = Number(
    output
      .map((e) => e.data)
      .join('')
      .match(/CHILD:(\d+)/)![1],
  );
  await service.stop(terminal.id);
  expect(() => process.kill(terminal.pid!, 0)).toThrow();
  expect(() => process.kill(child, 0)).toThrow();
  await service.stop(terminal.id);
  expect(service.snapshot()[0].status).toBe('exited');
});
it('rejects failed registry writes and keeps no live terminal or false successful result', async () => {
  const { data, service } = await setup();
  await mkdir(join(data, 'terminals', 'catalog.json'));
  await expect(
    service.create({
      projectId: 'p',
      cwd: data,
      kind: 'shell',
      executable: '/bin/sh',
      args: ['-c', 'read line'],
    }),
  ).rejects.toMatchObject({ code: 'TERMINAL_STORAGE_FAILED' });
  expect(service.snapshot()).toEqual([]);
  await rm(join(data, 'terminals', 'catalog.json'), { recursive: true });
});
it('binds the exact Codex session explicitly and rejects another session or shell binding', async () => {
  const { data, service } = await setup();
  const codex = await service.create({
    projectId: 'p',
    cwd: data,
    kind: 'codex',
    executable: '/bin/sh',
    args: ['-c', 'read line'],
  });
  expect((await service.bindSession(codex.id, 'exact-session-id')).harnessSessionId).toBe(
    'exact-session-id',
  );
  await expect(service.bindSession(codex.id, 'other-session-id')).rejects.toMatchObject({
    code: 'TERMINAL_SESSION_CONFLICT',
  });
  await expect(service.restart(codex.id)).rejects.toMatchObject({
    code: 'TERMINAL_RESUME_REQUIRED',
  });
  const shell = await service.create({
    projectId: 'p',
    cwd: data,
    kind: 'shell',
    executable: '/bin/sh',
    args: ['-c', 'read line'],
  });
  await expect(service.bindSession(shell.id, 'exact-session-id')).rejects.toMatchObject({
    code: 'TERMINAL_KIND_INVALID',
  });
});
