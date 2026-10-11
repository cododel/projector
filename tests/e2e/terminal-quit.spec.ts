import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TerminalRecord, TerminalScreen } from '../../src/shared/terminal';
import type { ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

test('Quit cleans owned PTYs when an alive runtime cannot answer a workspace mutation', async ({ playwright }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'bp-quit-stopped-runtime-'));
  const data = join(root, 'data'), project = join(root, 'project');
  await Promise.all([data, project].map(path => mkdir(path)));
  const app = await playwright._electron.launch({ args: [resolve('.')], env: { ...process.env,
    BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: join(root, 'runtime.json') } });
  const main = app.process().pid!;
  let child: number | undefined, parent: number | undefined, runtime: number | undefined;
  let stopped = false;
  try {
    const page = await app.firstWindow();
    const invoke = <T>(name: string, args: Record<string, unknown> = {}) => page.evaluate(
      ({ name, args }) => (window as unknown as { blueprint: { invoke(name: string, args: Record<string, unknown>): Promise<unknown> } }).blueprint.invoke(name, args), { name, args },
    ) as Promise<T>;
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
    await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
    const projectId = (await invoke<{ projects: { id: string }[] }>('snapshot')).projects[0].id;
    const configuration = await invoke<ApplicationWorkspaceSnapshot>('applicationSnapshot');
    await invoke('applicationSettings', { ...configuration.settings, shell: '/bin/sh', shellArgs: ['-i'] });
    await invoke('applicationCommand', { action: 'newTerminal', projectId, operationId: randomUUID() });
    const value = await invoke<ApplicationWorkspaceSnapshot & { terminals: TerminalRecord[] }>('applicationSnapshot');
    const terminal = value.terminals[0], viewId = value.workspaces[value.selectedWorkspace!].activePaneId;
    parent = terminal.pid;
    await invoke('terminalResize', { id: terminal.id, viewId, cols: 90, rows: 24, active: true });
    await invoke('terminalInput', { id: terminal.id, viewId,
      data: "stty -echo; trap '' HUP TERM; sleep 120 & printf '\\nQUIT_CHILD:'; jobs -p\r" });
    await expect.poll(async () => (await invoke<TerminalScreen>('terminalScreen', { id: terminal.id })).content)
      .toMatch(/\r\nQUIT_CHILD:\d+\r\n/);
    child = Number((await invoke<TerminalScreen>('terminalScreen', { id: terminal.id })).content.match(/QUIT_CHILD:(\d+)/)![1]);
    const probe = join(root, 'utility-probe.cjs');
    await writeFile(probe, 'process.parentPort.on("message",()=>{});');
    await app.evaluate(({ utilityProcess }, file) => {
      const probe = utilityProcess.fork(file, [], { stdio: 'ignore' });
      const prototype = Object.getPrototypeOf(probe), post = prototype.postMessage;
      probe.kill();
      const state = { runtime: 0, requests: 0 };
      Object.assign(globalThis, { quitRuntimeProbe: state });
      prototype.postMessage = function (value: { type?: string; name?: string }) {
        if (value.type === 'operator' && value.name === 'snapshot') {
          state.runtime = this.pid;
          state.requests++;
        }
        return Reflect.apply(post, this, [value]);
      };
      // Shorten only the main runtime deadline/diagnostic, never utility cleanup.
      const timeout = globalThis.setTimeout;
      globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        timeout(handler, delay === 10000 ? 50 : delay, ...args)) as typeof setTimeout;
    }, probe);
    await invoke('snapshot');
    const before = await app.evaluate(({ app }) => {
      const state = (globalThis as unknown as { quitRuntimeProbe: { runtime: number; requests: number } }).quitRuntimeProbe;
      return { ...state, metrics: app.getAppMetrics().map(({ pid, type, name }) => ({ pid, type, name })) };
    });
    runtime = before.runtime;
    expect(runtime).toBeGreaterThan(0);
    expect(runtime).not.toBe(main);
    expect(runtime).not.toBe(parent);
    expect(before.metrics.some(metric => metric.pid === runtime && metric.type === 'Utility')).toBe(true);
    expect(before.metrics.find(metric => metric.pid === runtime)?.name).not.toBe('Blueprint Terminals');
    process.kill(runtime, 'SIGSTOP');
    stopped = true;
    await page.evaluate(({ projectId, operationId }) => {
      const state = { result: 'pending' };
      Object.assign(window, { quitMutationProbe: state });
      void (window as unknown as { blueprint: { invoke(name: string, args: Record<string, unknown>): Promise<unknown> } })
        .blueprint.invoke('applicationCommand', { action: 'bottomToggle', projectId, operationId })
        .then(() => { state.result = 'resolved'; }, () => { state.result = 'rejected'; });
    }, { projectId, operationId: randomUUID() });
    await expect.poll(() => app.evaluate(() =>
      (globalThis as unknown as { quitRuntimeProbe: { requests: number } }).quitRuntimeProbe.requests))
      .toBeGreaterThan(before.requests);
    expect(await page.evaluate(() => (window as unknown as { quitMutationProbe: { result: string } }).quitMutationProbe.result)).toBe('pending');
    expect(alive(runtime)).toBe(true);
    expect(alive(child)).toBe(true);
    expect(alive(parent!)).toBe(true);
    await testInfo.attach('owned-runtime-before-quit', { contentType: 'application/json', body: JSON.stringify({
      main, runtime, parent, child, runtimeAlive: alive(runtime), childAlive: alive(child),
      mutationResult: 'pending', requestsBefore: before.requests,
    }) });
    await app.evaluate(({ app }) => { app.quit(); });
    // A diagnostic timer does not cancel the operation. Quit must still release
    // its owned process tree instead of awaiting that unbounded RPC first.
    await expect.poll(() => alive(child!), { timeout: 3000 }).toBe(false);
    await expect.poll(() => alive(main), { timeout: 3000 }).toBe(false);
    expect(alive(parent!)).toBe(false);
    expect(alive(runtime)).toBe(false);
  } finally {
    // Resume only the runtime captured from this app's actual operator boundary.
    if (stopped && runtime && alive(runtime)) {
      try { process.kill(runtime, 'SIGCONT'); } catch { /* Already exited. */ }
    }
    await Promise.race([app.close().catch(() => {}), new Promise<void>(resolve => setTimeout(resolve, 3000))]);
    for (const pid of [child, parent, runtime, main]) if (pid && alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* This fixture already exited. */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('Quit drains a normally delayed workspace mutation before exiting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-quit-write-drain-'));
  const data = join(root, 'data'), project = join(root, 'project');
  await Promise.all([data, project].map(path => mkdir(path)));
  const app = await electron.launch({ args: [resolve('.')], env: { ...process.env,
    BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: join(root, 'runtime.json') } });
  const main = app.process().pid!;
  try {
    const page = await app.firstWindow();
    const invoke = <T>(name: string, args: Record<string, unknown> = {}) => page.evaluate(
      ({ name, args }) => (window as unknown as { blueprint: { invoke(name: string, args: Record<string, unknown>): Promise<unknown> } }).blueprint.invoke(name, args), { name, args },
    ) as Promise<T>;
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
    await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
    const projectId = (await invoke<{ projects: { id: string }[] }>('snapshot')).projects[0].id;
    const before = await invoke<ApplicationWorkspaceSnapshot>('applicationSnapshot');
    expect(before.bottom[projectId]?.visible ?? false).toBe(false);
    const probe = join(root, 'utility-probe.cjs');
    await writeFile(probe, 'process.parentPort.on("message",()=>{});');
    await app.evaluate(({ utilityProcess }, file) => {
      const probe = utilityProcess.fork(file, [], { stdio: 'ignore' });
      const prototype = Object.getPrototypeOf(probe), post = prototype.postMessage, emit = prototype.emit;
      probe.kill();
      const state = { held: false, released: false };
      Object.assign(globalThis, { quitWriteProbe: state });
      let requestId: string | undefined;
      prototype.postMessage = function (value: { type?: string; name?: string; id?: string }) {
        if (!requestId && value.type === 'operator' && value.name === 'snapshot') requestId = value.id;
        return Reflect.apply(post, this, [value]);
      };
      prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
        const response = args[0] as { type?: string; id?: string } | undefined;
        if (!state.held && event === 'message' && response?.type === 'operator-response' && response.id === requestId) {
          state.held = true;
          setTimeout(() => {
            state.released = true;
            Reflect.apply(emit, this, [event, ...args]);
          }, 500);
          return true;
        }
        return Reflect.apply(emit, this, [event, ...args]);
      };
    }, probe);
    await page.evaluate(({ projectId, operationId }) => {
      void (window as unknown as { blueprint: { invoke(name: string, args: Record<string, unknown>): Promise<unknown> } })
        .blueprint.invoke('applicationCommand', { action: 'bottomToggle', projectId, operationId }).catch(() => {});
    }, { projectId, operationId: randomUUID() });
    await expect.poll(() => app.evaluate(() =>
      (globalThis as unknown as { quitWriteProbe: { held: boolean } }).quitWriteProbe.held)).toBe(true);
    expect(await app.evaluate(() =>
      (globalThis as unknown as { quitWriteProbe: { released: boolean } }).quitWriteProbe.released)).toBe(false);
    await app.evaluate(({ app }) => { app.quit(); });
    await expect.poll(() => alive(main), { timeout: 3000 }).toBe(false);
    const saved = JSON.parse(await readFile(join(data, 'application-workspace.json'), 'utf8')) as ApplicationWorkspaceSnapshot;
    expect(saved.bottom[projectId].visible).toBe(true);
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise<void>(resolve => setTimeout(resolve, 3000))]);
    if (alive(main)) { try { process.kill(main, 'SIGKILL'); } catch { /* Already exited. */ } }
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime quit deadline cannot interrupt owned PTY descendant cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-quit-order-'));
  const data = join(root, 'data'), project = join(root, 'project');
  await Promise.all([data, project].map(path => mkdir(path)));
  const app = await electron.launch({ args: [resolve('.')], env: { ...process.env,
    BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: join(root, 'runtime.json') } });
  let child: number | undefined, parent: number | undefined;
  try {
    const page = await app.firstWindow();
    const invoke = <T>(name: string, args: Record<string, unknown> = {}) => page.evaluate(
      ({ name, args }) => (window as unknown as { blueprint: { invoke(name: string, args: Record<string, unknown>): Promise<unknown> } }).blueprint.invoke(name, args), { name, args },
    ) as Promise<T>;
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
    await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
    const projectId = (await invoke<{ projects: { id: string }[] }>('snapshot')).projects[0].id;
    const configuration = await invoke<ApplicationWorkspaceSnapshot>('applicationSnapshot');
    await invoke('applicationSettings', { ...configuration.settings, shell: '/bin/sh', shellArgs: ['-i'] });
    await invoke('applicationCommand', { action: 'newTerminal', projectId, operationId: randomUUID() });
    const value = await invoke<ApplicationWorkspaceSnapshot & { terminals: TerminalRecord[] }>('applicationSnapshot');
    const terminal = value.terminals[0], viewId = value.workspaces[value.selectedWorkspace!].activePaneId;
    parent = terminal.pid;
    await invoke('terminalResize', { id: terminal.id, viewId, cols: 90, rows: 24, active: true });
    await invoke('terminalInput', { id: terminal.id, viewId,
      data: "stty -echo; trap '' HUP TERM; sleep 120 & printf '\\nQUIT_CHILD:'; jobs -p\r" });
    await expect.poll(async () => (await invoke<TerminalScreen>('terminalScreen', { id: terminal.id })).content)
      .toMatch(/\r\nQUIT_CHILD:\d+\r\n/);
    child = Number((await invoke<TerminalScreen>('terminalScreen', { id: terminal.id })).content.match(/QUIT_CHILD:(\d+)/)![1]);
    expect(alive(child)).toBe(true);
    // Compress only the main-process runtime deadline. Real utility cleanup still
    // needs its normal grace period and must finish before this deadline starts.
    await app.evaluate(() => {
      const original = globalThis.setTimeout;
      globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        original(handler, delay === 10000 ? 10 : delay, ...args)) as typeof setTimeout;
    });
    await app.close();
    expect(alive(child)).toBe(false);
    expect(alive(parent!)).toBe(false);
  } finally {
    await app.close().catch(() => {});
    // Clean only this fixture's confirmed PIDs if the regression leaves them alive.
    for (const pid of [child, parent]) if (pid && alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* The fixture already exited. */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});
