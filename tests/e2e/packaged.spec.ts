import { randomUUID } from 'node:crypto';
import { test, expect, _electron as electron } from '@playwright/test';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import type { McpSetup } from '../../src/shared/protocol';
import type { TerminalRecord, TerminalScreen } from '../../src/shared/terminal';
import type { ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';

test('relocated packaged app uses its own stdio helper without system Node and preserves runtime lifecycle', async () => {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), 'bp-packaged-'));
  let child: ChildProcessWithoutNullStreams | undefined;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', resolve('tests/fixtures/offline-network.mjs'), 'scripts/package-mac.mjs'],
      {
        cwd: resolve('.'),
        timeout: 90000,
        env: {
          ...process.env,
          PROJECTOR_NODE: process.execPath,
          PROJECTOR_PACKAGE_OUTPUT: join(root, 'package'),
        },
      },
    );
    const source = stdout.trim().split('\n').at(-1)!;
    expect(source).toBe(join(root, 'package', `Projector-darwin-${process.arch}`, 'Projector.app'));
    const plist = await promisify(execFile)('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      join(source, 'Contents', 'Info.plist'),
    ]);
    expect(JSON.parse(plist.stdout)).toMatchObject({
      CFBundleName: 'Projector',
      CFBundleIdentifier: 'dev.cododel.projector',
    });
    const license = await readFile(resolve('LICENSE'), 'utf8');
    const appResources = join(source, 'Contents', 'Resources');
    expect(await readFile(join(appResources, 'app', 'LICENSE'), 'utf8')).toBe(license);
    expect(await readFile(join(appResources, 'mcp', 'PROJECTOR-LICENSE'), 'utf8')).toBe(license);
    expect(
      JSON.parse(await readFile(join(appResources, 'app', 'package.json'), 'utf8')).license,
    ).toBe('SEE LICENSE IN LICENSE');
    const relocated = join(root, 'Moved app with spaces', 'Projector.app');
    await mkdir(join(root, 'Moved app with spaces'));
    // Framework symlinks must stay relative when an application bundle is relocated.
    await cp(source, relocated, { recursive: true, verbatimSymlinks: true });
    const socket = join(root, 'service.sock');
    const executable = join(relocated, 'Contents', 'MacOS', 'Projector');
    app = await electron.launch({
      executablePath: executable,
      args: [],
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        PROJECTOR_NODE: '/missing/system/node',
        PROJECTOR_DATA: join(root, 'data'),
        PROJECTOR_RUNTIME_DESCRIPTOR: socket,
      },
    });
    let applicationStderr = '';
    app.process().stderr?.on('data', (chunk) => {
      applicationStderr += String(chunk);
    });
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (_details, callback) => callback({ cancel: true }),
      );
    });
    const page = await app.firstWindow().catch((error) => {
      throw new Error(`${String(error)}\n${applicationStderr}`);
    });
    await page.getByRole('button', { name: 'Projector guide', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Projector guide' })).toContainText(
      'Available offline',
    );
    await page
      .getByRole('dialog', { name: 'Projector guide' })
      .getByRole('button', { name: 'Close', exact: true })
      .click();

    await expect(
      page.getByRole('heading', { name: 'Make decisions before implementation' }),
    ).toBeVisible();
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const setup: McpSetup = await page.evaluate(async () => {
      const bridge = (
        window as unknown as { projector: { invoke: (name: string) => Promise<McpSetup> } }
      ).projector;
      return bridge.invoke('setup');
    });
    expect(setup.mode).toBe('packaged');
    expect(setup.executable).toContain(
      'Moved app with spaces/Projector.app/Contents/Resources/mcp/projector-mcp',
    );
    expect(setup.args).toEqual([]);
    expect(setup.env.PROJECTOR_RUNTIME_DESCRIPTOR).toBe(socket);
    await page.getByRole('button', { name: 'MCP connection', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Packaged application');
    await expect(page.getByRole('dialog')).toContainText(setup.executable);
    child = spawn(setup.executable, setup.args, {
      env: {
        ...process.env,
        ...setup.env,
        PATH: '/usr/bin:/bin',
        NODE_OPTIONS: '--definitely-invalid-node-option',
      },
    });
    const pending = new Map<number, (value: Record<string, unknown>) => void>();
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    lines.on('line', (line) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.id === 'number') {
        pending.get(value.id)?.(value);
        pending.delete(value.id);
      }
    });
    let next = 0;
    const request = (method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(
          () => reject(new Error(`MCP response timed out: ${stderr}`)),
          10000,
        );
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    const initialized = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'packaged-test', version: '1' },
    });
    expect(initialized.result).toMatchObject({ serverInfo: { name: 'projector' } });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    const tools = await request('tools/list', {});
    expect(JSON.stringify(tools.result)).toContain('publish_artifact');
    // The packaged compiler worker must run as well, beyond a successful handshake.
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const project = join(root, 'project');
    await mkdir(project);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    await page.getByRole('button', { name: '+ Open project folder' }).click();
    const tool = async (name: string, args: unknown) => {
      const response = await request('tools/call', { name, arguments: args });
      const result = response.result as { content: { text: string }[]; isError?: boolean };
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    };
    const context = await tool('get_projector_context', {});
    const a = await tool('create_artifact', {
      projectId: (context.project as { id: string }).id,
      kind: 'projector',
      title: 'Packaged plan',
      originSession: { harness: 'codex', sessionId: 'packaged-test' },
      operationId: randomUUID(),
    });
    await writeFile(
      join(String(a.sourcePath), 'plan.mdx'),
      '# Packaged plan\n\n<TextAnswer id="decision" meaning="Decision" semanticsVersion="1" defaultValue="" />',
    );
    const r = await tool('publish_artifact', {
      artifactId: a.artifactId,
      expectedLatestRevision: null,
      operationId: randomUUID(),
    });
    await tool('show_artifact', { artifactId: a.artifactId, revisionId: r.revisionId });
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('heading', { name: 'Packaged plan' })).toBeVisible();
    await frame.getByLabel('Decision', { exact: true }).fill('Saved through the bundled helper');
    await expect(page.getByText('Saved locally')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect(
      String((await tool('read_artifact', { artifactId: a.artifactId, part: 'state' })).content),
    ).toContain('Saved through the bundled helper');
    // Exercise the relocated native PTY payload and real renderer input as well
    // as the bundled bridge/compiler. No system Node or external network is available.
    const invoke = <T>(name: string, args?: Record<string, unknown>) =>
      page.evaluate(
        ({ name, args }) =>
          (
            window as unknown as {
              projector: { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> };
            }
          ).projector.invoke(name, args),
        { name, args },
      ) as Promise<T>;
    type Application = ApplicationWorkspaceSnapshot & { terminals: TerminalRecord[] };
    const application = await invoke<Application>('applicationSnapshot');
    await invoke('applicationSettings', {
      ...application.settings,
      shell: '/bin/sh',
      shellArgs: ['-i'],
    });
    await page.getByRole('button', { name: 'New terminal', exact: true }).first().click();
    await expect
      .poll(async () => (await invoke<Application>('applicationSnapshot')).terminals.length)
      .toBe(1);
    const terminal = (await invoke<Application>('applicationSnapshot')).terminals[0];
    await page.locator('.terminal-pane .xterm-helper-textarea').focus();
    await page.keyboard.insertText('stty -echo; printf "\\nPACKAGED_NATIVE_輸入🙂\\n"');
    await page.keyboard.press('Enter');
    await expect
      .poll(
        async () => (await invoke<TerminalScreen>('terminalScreen', { id: terminal.id })).content,
      )
      .toContain('\r\nPACKAGED_NATIVE_輸入🙂\r\n');
    await expect(page.locator('.terminal-pane .xterm-rows')).toContainText(
      'PACKAGED_NATIVE_輸入🙂',
    );
    await page.getByRole('button', { name: 'Close shell tab', exact: true }).click();
    expect((await invoke<Application>('applicationSnapshot')).terminals[0].pid).toBe(terminal.pid);
    await invoke('applicationCommand', {
      action: 'showTerminal',
      projectId: terminal.projectId,
      key: application.selectedWorkspace,
      terminalId: terminal.id,
    });
    await expect(page.locator('.terminal-pane .xterm-rows')).toContainText(
      'PACKAGED_NATIVE_輸入🙂',
    );
    expect((await invoke<Application>('applicationSnapshot')).terminals[0].pid).toBe(terminal.pid);
    const terminalImage = test.info().outputPath('installed-production-terminal.png');
    await page.screenshot({ path: terminalImage });
    await test.info().attach('installed-production-terminal', {
      path: terminalImage,
      contentType: 'image/png',
    });
    await page.close();
    expect(
      await app.evaluate((_, pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }, terminal.pid!),
    ).toBe(true);
    const guide = await request('tools/call', { name: 'get_projector_guide', arguments: {} });
    expect(JSON.stringify(guide.result)).toContain('guideVersion');
    const exit = once(child, 'exit');
    child.stdin.end();
    expect((await exit)[0]).toBe(0);
    child = undefined;
    await expect.poll(() => app!.evaluate(({ app }) => app.isReady())).toBe(true);
    await app.close();
    app = undefined;
    expect(() => process.kill(terminal.pid!, 0)).toThrow();
    // A disconnected runtime must not cause the helper to start the app.
    await expect(
      promisify(execFile)(setup.executable, [], {
        env: { ...process.env, ...setup.env, PATH: '/usr/bin:/bin' },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('Start the application manually'),
    });
  } finally {
    if (child && child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
