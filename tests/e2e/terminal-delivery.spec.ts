import { test, expect, electron } from './test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TerminalRecord, TerminalScreen } from '../../src/shared/terminal';
import type { ApplicationSettings } from '../../src/shared/application-workspace';

test('lost renderer acknowledgements bound IPC output while PTY persists and subscription recovers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-delivery-'));
  const data = join(root, 'data'), project = join(root, 'project');
  await Promise.all([data, project].map(path => mkdir(path)));
  const app = await electron.launch({ args: [resolve('.')], env: { ...process.env,
    PROJECTOR_DATA: data, PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'runtime.json') } });
  try {
    const page = await app.firstWindow();
    const invoke = <T>(name: string, args: Record<string, unknown> = {}) => page.evaluate(
      ({ name, args }) => (window as unknown as { projector: { invoke(name: string, args: Record<string, unknown>): Promise<unknown> } }).projector.invoke(name, args), { name, args },
    ) as Promise<T>;
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
    await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
    const runtime = await invoke<{ projects: { id: string }[] }>('snapshot');
    const projectId = runtime.projects[0].id;
    const configured = await invoke<{ settings: ApplicationSettings }>('applicationSnapshot');
    await invoke('applicationSettings', { ...configured.settings, shell: '/bin/sh', shellArgs: ['-i'] });
    await invoke('applicationCommand', { action: 'newTerminal', projectId, operationId: randomUUID() });
    const state = await invoke<{ selectedWorkspace: string; workspaces: Record<string, { activePaneId: string }>; terminals: TerminalRecord[] }>('applicationSnapshot');
    const terminal = state.terminals[0], viewId = state.workspaces[state.selectedWorkspace].activePaneId;
    await invoke('terminalResize', { id: terminal.id, viewId, cols: 90, rows: 24, active: true });
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const output = { count: 0, bytes: 0, blocked: true, held: [] as unknown[][] };
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const send = contents.send.bind(contents), emit = ipcMain.emit.bind(ipcMain);
      contents.send = (channel, ...args) => {
        if (channel === 'projector:terminal-output') {
          output.count++;
          const value = args[0] as { data?: string; output?: { data: string } };
          output.bytes += Buffer.byteLength(value.output?.data ?? value.data ?? '');
        }
        send(channel, ...args);
      };
      ipcMain.emit = (channel, ...args) => {
        if (channel === 'projector:terminal-output-ack' && output.blocked) {
          output.held.push(args);
          return true;
        }
        return emit(channel, ...args);
      };
      Object.assign(globalThis, { terminalDeliveryProbe: output, releaseTerminalDelivery: () => {
        output.blocked = false;
        for (const args of output.held.splice(0)) emit('projector:terminal-output-ack', ...args);
      } });
    });
    await invoke('terminalInput', { id: terminal.id, viewId,
      data: "stty -echo; i=0; while [ \"$i\" -lt 120 ]; do printf '\\nIPC_PRESSURE_MARKER%08d\\n' \"$i\"; i=$((i+1)); sleep 0.005; done; printf '\\nIPC_PRESSURE_DONE\\n'\r" });
    await expect.poll(async () => (await invoke<TerminalScreen>('terminalScreen', { id: terminal.id })).content,
      { timeout: 20000 }).toContain('\r\nIPC_PRESSURE_DONE\r\n');
    const delivery = await app.evaluate(() => {
      const value = (globalThis as unknown as { terminalDeliveryProbe: { count: number; bytes: number } }).terminalDeliveryProbe;
      return { count: value.count, bytes: value.bytes };
    });
    // The peer has acknowledged no deliveries: neither event count nor bytes may grow with output.
    expect(delivery.count).toBeLessThanOrEqual(32);
    expect(delivery.bytes).toBeLessThanOrEqual(256 * 1024);
    expect((await invoke<{ terminals: TerminalRecord[] }>('applicationSnapshot')).terminals[0].pid).toBe(terminal.pid);
    await app.evaluate(() => (globalThis as unknown as { releaseTerminalDelivery(): void }).releaseTerminalDelivery());
    await expect(page.locator('.xterm-screen')).toContainText('IPC_PRESSURE_DONE');
    await invoke('terminalInput', { id: terminal.id, viewId, data: "printf '\\nIPC_RECOVERED\\n'\r" });
    await expect(page.locator('.xterm-screen')).toContainText('IPC_RECOVERED');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
