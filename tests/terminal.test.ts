import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnostics } from './support/vitest-diagnostics';
import { DiagnosticCollector } from './support/diagnostics';
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
      'stty -echo; printf "PTY_READY\\n"; IFS= read -r line; printf "INPUT:%s\\n" "$line"; printf "SIZE:"; stty size; read finish; exit 7',
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
  await until(() =>
    output
      .map((e) => e.data)
      .join('')
      .includes('SIZE:37 101'),
  );
  const frame = await service.screen(terminal.id);
  expect(frame.content).toContain('INPUT:Привет 🙂 日本語');
  expect(frame.content).toContain('SIZE:37 101');
  service.input(terminal.id, '\r', 'active');
  await until(() => service.snapshot().length === 0);
  expect(output.map((e) => e.seq)).toEqual(output.map((_, i) => i + 1));
  expect(output.map((e) => e.data).join('')).not.toContain('wrong');
});
it('preserves a detached live terminal and removes it after Quit without executing again', async () => {
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
  expect(restored.snapshot()).toEqual([]);
  await expect(restored.screen(terminal.id)).rejects.toMatchObject({ code: 'TERMINAL_NOT_FOUND' });
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
it('reads the owned shell cwd after cd for split and removes ended terminals', async () => {
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
  expect(restored.snapshot()).toEqual([]);
  await expect(restored.currentCwd(source.id)).rejects.toMatchObject({
    code: 'TERMINAL_NOT_FOUND',
  });
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
    env: { PROJECTOR_FIXTURE_SECRET: 'synthetic-auth-token' },
    operationId: 'same-create',
  };
  const [a, b] = await Promise.all([service.create(input), service.create(input)]);
  expect(a.id).toBe(b.id);
  expect(service.snapshot()).toHaveLength(1);
  await service.stop(a.id);
  const disk = await readFile(join(data, 'terminals', 'catalog.json'), 'utf8');
  expect(disk).not.toContain('launch-only-secret');
  expect(disk).not.toContain('synthetic-auth-token');
  expect(disk).not.toContain('PROJECTOR_FIXTURE_SECRET');
  expect(disk).not.toContain('"pid"');
  await expect(service.create(input)).rejects.toMatchObject({ code: 'TERMINAL_PROCESS_ENDED' });
  expect(service.snapshot()).toEqual([]);
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
  expect(service.snapshot()).toEqual([]);
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
it('removes an exited PTY and its saved screen instead of retaining terminal history', async () => {
  const { data, service, output } = await setup();
  const terminal = await service.create({
    projectId: 'project',
    cwd: data,
    kind: 'shell',
    executable: '/bin/sh',
    args: ['-c', 'stty -echo; printf "EXIT_READY\\n"; read line; exit 7'],
    operationId: 'finished-process',
  });
  await until(() => output.some((event) => event.data.includes('EXIT_READY')));
  service.resize(terminal.id, { cols: 80, rows: 24, viewId: 'pane', active: true });
  service.input(terminal.id, '\r', 'pane');
  await until(() => service.snapshot().length === 0);
  await expect(readFile(join(data, 'terminals', `${terminal.id}.json`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(
    JSON.parse(await readFile(join(data, 'terminals', 'catalog.json'), 'utf8')).terminals,
  ).toEqual([]);
  await expect(
    service.create({
      projectId: 'project',
      cwd: data,
      kind: 'shell',
      executable: '/bin/sh',
      operationId: 'finished-process',
    }),
  ).rejects.toMatchObject({ code: 'TERMINAL_PROCESS_ENDED' });
});
it('drops legacy inactive and exited screens on startup without touching unrelated files', async () => {
  const { data, service } = await setup();
  await service.shutdown();
  services.splice(services.indexOf(service), 1);
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const directory = join(data, 'terminals');
  await writeFile(
    join(directory, 'catalog.json'),
    JSON.stringify({
      formatVersion: 1,
      terminals: [
        {
          id,
          projectId: 'project',
          cwd: data,
          kind: 'shell',
          title: 'Shell',
          createdAt: new Date().toISOString(),
          status: 'inactive',
          exitCode: null,
          operationId: 'legacy-create',
        },
      ],
    }),
  );
  await writeFile(join(directory, `${id}.json`), 'old screen');
  await writeFile(join(data, 'unrelated.json'), 'preserve');
  const restored = new TerminalService(data);
  services.push(restored);
  await restored.open();
  expect(restored.snapshot()).toEqual([]);
  await expect(readFile(join(directory, `${id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(data, 'unrelated.json'), 'utf8')).toBe('preserve');
  await expect(
    restored.create({
      projectId: 'project',
      cwd: data,
      kind: 'shell',
      operationId: 'legacy-create',
    }),
  ).rejects.toMatchObject({ code: 'TERMINAL_PROCESS_ENDED' });
});

it('publishes PTY exit before descendant cleanup and keeps input forbidden', async () => {
  const { service, data, output, changes } = await setup();
  const terminal = await service.create({
    projectId: 'project', cwd: data, kind: 'shell', executable: '/bin/sh',
    args: ['-c', 'stty -echo; printf "EXIT_READY\\n"; read finish; exit 0'],
  });
  await until(() => output.some(event => event.data.includes('EXIT_READY')));
  service.resize(terminal.id, { cols: 80, rows: 24, viewId: 'active', active: true });
  service.input(terminal.id, '\r', 'active');
  await until(() => service.snapshot().some(record => record.id === terminal.id && record.status === 'exited'));
  // The real PTY has ended; descendant cleanup still owns the record. The renderer
  // must learn that input is disabled before that asynchronous cleanup completes.
  expect(changes.at(-1)?.find(record => record.id === terminal.id)?.status).toBe('exited');
  expect(() => service.input(terminal.id, '\x03', 'active')).toThrow('Start or resume this terminal explicitly.');
  await until(() => service.snapshot().length === 0);
  expect(changes.at(-1)).toEqual([]);
});

it('ignores late geometry for an ended process without enabling terminal input', async () => {
  const {service,data} = await setup();
  const record = await service.create({projectId:'project',cwd:data,kind:'shell',executable:'/bin/sh',args:['-i']});
  await service.stop(record.id);
  expect(service.resize(record.id,{cols:80,rows:24,viewId:'departing-pane',active:true})).toEqual({resized:false});
  expect(() => service.input(record.id,'unexpected','departing-pane')).toThrow('Terminal is not available.');
  expect(service.snapshot()).toEqual([]);
});

it('restores SGR mouse encoding with the terminal screen and follows encoding resets', async () => {
  const { data, service, output } = await setup();
  const terminal = await service.create({ projectId:'project',cwd:data,kind:'shell',executable:'/bin/sh',
    args:['-c', 'stty -echo; printf "\\033[?1049h\\033[?1000h\\033[?1006hSGR_READY\\n"; read first; printf "\\033[?1016hPIXEL_READY\\n"; read second; printf "\\033[?1006lDEFAULT_READY\\n"; read finish'] });
  await until(() => output.some(event => event.data.includes('SGR_READY')));
  expect((await service.screen(terminal.id)).content).toContain('\x1b[?1006h');
  service.resize(terminal.id,{cols:80,rows:24,viewId:'pane',active:true});
  service.input(terminal.id,'\r','pane');
  await until(() => output.some(event => event.data.includes('PIXEL_READY')));
  expect((await service.screen(terminal.id)).content).toContain('\x1b[?1016h');
  service.input(terminal.id,'\r','pane');
  await until(() => output.some(event => event.data.includes('DEFAULT_READY')));
  const restored = (await service.screen(terminal.id)).content;
  expect(restored).not.toContain('\x1b[?1006h');
  expect(restored).not.toContain('\x1b[?1016h');
});

it('preserves ordered UTF-8 and binary input as exact raw PTY bytes', async () => {
  const { data, service, output } = await setup();
  const expected = '41f09f99820080ffe697a5e69cac1b5b4d608384';
  const terminal = await service.create({
    projectId: 'project', cwd: data, kind: 'shell', executable: process.execPath,
    args: ['-e', `process.stdin.setRawMode(true);let input=Buffer.alloc(0);process.stdout.write('BYTE_INPUT_READY\\r\\n');process.stdin.on('data',bytes=>{input=Buffer.concat([input,bytes]);if(input.length>=${expected.length / 2})process.stdout.write('RAW_HEX:'+input.toString('hex')+'\\r\\n')});`],
  });
  await until(() => output.some(event => event.data.includes('BYTE_INPUT_READY')));
  service.resize(terminal.id, { cols: 160, rows: 24, viewId: 'active', active: true });
  expect(() => service.input(terminal.id, '\x80', 'inactive', 'binary')).toThrow('Select the terminal pane');
  expect(() => service.input(terminal.id, '\u0100', 'active', 'binary')).toThrow('Terminal input exceeds the limit');
  service.input(terminal.id, 'A🙂', 'active');
  service.input(terminal.id, '\x00\x80\xff', 'active', 'binary');
  service.input(terminal.id, '日本', 'active');
  service.input(terminal.id, '\x1b[M\x60\x83\x84', 'active', 'binary');
  await until(() => output.map(event => event.data).join('').includes(`RAW_HEX:${expected}`));
  expect((await service.screen(terminal.id)).content).toContain(`RAW_HEX:${expected}`);
});

it('owns a failed harness exit while retaining ordinary shell failures as external evidence', async () => {
  const {service,data} = await setup();
  const audit = diagnostics();
  for (const kind of ['codex','shell'] as const) {
    const terminal = await service.create({projectId:'p',cwd:data,kind,executable:'/bin/sh',
      args:['-c', 'printf "Error is terminal data\\n"; read line; exit 7']});
    service.resize(terminal.id,{cols:80,rows:24,active:true,viewId:'failure-view'});
    if (kind === 'codex') audit.expect({role:'codex-tui',kind:'process-exit',phase:'test',message:'code=7 signal=0',count:1});
    service.input(terminal.id,'finish\r','failure-view');
    await until(() => service.snapshot().every(record => record.id !== terminal.id));
    const exit = audit.events().find(event => event.kind === 'process-exit' && event.workerId === terminal.id);
    expect(exit).toMatchObject({pid:terminal.pid,workerId:terminal.id,level:'error',
      ...(kind === 'shell' ? {external:true} : {role:'codex-tui'})});
    const independent = new DiagnosticCollector({testId:audit.testId,runId:audit.runId,directory:data});
    independent.append(exit!);
    if (kind === 'codex') expect(() => independent.assertClean()).toThrow('Unexpected error');
    else expect(() => independent.assertClean()).not.toThrow();
  }
});
