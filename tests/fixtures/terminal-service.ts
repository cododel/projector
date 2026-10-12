import { app } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TerminalManager } from '../../src/main/terminals';
import { TerminalOutputReader } from '../../src/renderer/terminal-output';
const data = process.argv[2],
  servicePath = process.argv[3];
app.setPath('userData', data);
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
const until = async (condition: () => Promise<boolean>) => {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Terminal fixture timed out.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
void app.whenReady().then(async () => {
  let manager = new TerminalManager(),
    reader: TerminalOutputReader | undefined;
  let rendered = '',
    readerTerminal = '',
    stage = 'startup';
  try {
    await manager.start(data, servicePath, { scrollback: 20000 });
    const record = await manager.create({
      projectId: 'isolated-project',
      cwd: data,
      kind: 'shell',
      executable: '/bin/sh',
      args: [
        '-c',
        'stty -echo; printf "READY\\n"; read line; printf "INPUT:%s\\n" "$line"; printf "SIZE:"; stty size; awk \'BEGIN { for (i=0; i<10050; i++) printf "RESTORE_HISTORY:%05d\\n", i }\'; read finish',
      ],
    });
    await until(async () => (await manager.screen(record.id)).content.includes('READY'));
    await manager.resize(record.id, { cols: 101, rows: 37, viewId: 'pane', active: true });
    await manager.input(record.id, 'Привет 🙂 日本語\r', 'pane');
    await until(async () =>
      (await manager.screen(record.id)).content.includes('RESTORE_HISTORY:10049'),
    );
    const screen = await manager.screen(record.id);
    if (
      !screen.content.includes('INPUT:Привет 🙂 日本語') ||
      !screen.content.includes('SIZE:37 101') ||
      !screen.content.includes('RESTORE_HISTORY:00000')
    )
      throw new Error('Wrong PTY content, history or viewport.');
    await manager.shutdown();
    stage = 'restart without terminal history';
    manager = new TerminalManager({
      onOutput: (output) => {
        if (output.id === readerTerminal) reader?.push(output);
      },
    });
    await manager.start(data, servicePath, { scrollback: 20000 });
    const restored = await manager.snapshot();
    if (restored.length) throw new Error('Ended terminal was restored.');
    await manager.updateOptions({ scrollback: 100, maxReplayBytes: 1024 });
    let invalidOptionsRejected = false;
    try {
      await manager.updateOptions({ scrollback: 99 });
    } catch {
      invalidOptionsRejected = true;
    }
    if (!invalidOptionsRejected) throw new Error('Invalid history limit was accepted.');
    const crash = await manager.create({
      projectId: 'isolated-project',
      cwd: data,
      kind: 'shell',
      executable: '/bin/sh',
      args: ['-c', 'sleep 120 & printf "CRASH_CHILD:%s\\n" "$!"; wait'],
    });
    let child = 0;
    await until(async () => {
      child = Number((await manager.screen(crash.id)).content.match(/CRASH_CHILD:(\d+)/)?.[1]);
      return child > 0;
    });
    const helper = app.getAppMetrics().find((entry) => entry.name === 'Projector Terminals');
    if (!helper || !crash.pid) throw new Error('Missing owned process.');
    process.kill(helper.pid, 'SIGKILL');
    stage = 'confirmed crash cleanup';
    await until(async () => {
      try {
        return (await manager.snapshot()).length === 0;
      } catch {
        return false;
      }
    });
    for (const pid of [crash.pid, child]) {
      try {
        process.kill(pid, 0);
        throw new Error('Crash left an owned process alive.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const fresh = await manager.create({
      projectId: 'isolated-project',
      cwd: data,
      kind: 'shell',
      executable: '/bin/sh',
      args: [
        '-c',
        'stty -echo; printf "EXPLICIT_NEW\\n"; read start; i=0; while [ "$i" -lt 400 ]; do printf "RESTART_LINE:%04d long fixture history\\n" "$i"; i=$((i+1)); done; read line',
      ],
    });
    if (fresh.id === crash.id || fresh.pid === crash.pid)
      throw new Error('New terminal reused the ended process.');
    readerTerminal = fresh.id;
    reader = new TerminalOutputReader({
      screen: () => manager.screen(fresh.id),
      replay: (seq) => manager.replay(fresh.id, seq),
      reset: async (frame) => {
        rendered = frame.content;
      },
      write: async (output) => {
        rendered += output;
      },
      error: (error) => {
        throw error;
      },
    });
    await reader.start();
    await manager.resize(fresh.id, { cols: 80, rows: 24, viewId: 'pane', active: true });
    await manager.input(fresh.id, '\r', 'pane');
    await until(async () => rendered.includes('RESTART_LINE:0399'));
    const configuredScreen = await manager.screen(fresh.id),
      configuredReplay = await manager.replay(fresh.id, 0);
    if (
      !configuredScreen.truncated ||
      configuredScreen.content.includes('RESTART_LINE:0000') ||
      !configuredReplay.gap ||
      configuredReplay.events.reduce((bytes, event) => bytes + Buffer.byteLength(event.data), 0) >
        1024
    )
      throw new Error('Service recovery lost configured bounds.');
    reader.stop();
    stage = 'shutdown';
    const closing = manager.shutdown();
    let shutdownCreateRejected = false;
    try {
      await manager.create({
        projectId: 'isolated-project',
        cwd: data,
        kind: 'shell',
        executable: '/bin/sh',
        args: ['-c', 'sleep 120'],
      });
    } catch (error) {
      shutdownCreateRejected = (error as Error).message.includes('shutting down');
    }
    await closing;
    if (!shutdownCreateRejected) throw new Error('Create during shutdown was accepted.');
    const catalog = JSON.parse(await readFile(join(data, 'terminals', 'catalog.json'), 'utf8'));
    if (catalog.terminals.length) throw new Error('Shutdown retained terminals.');
    await writeFile(
      join(data, 'result.json'),
      JSON.stringify({
        success: true,
        versions: process.versions,
        restored,
        screen,
        configuredScreen,
        configuredReplay,
        freshOutputDisplayed: true,
        shutdownCreateRejected,
      }),
    );
    app.exit(0);
  } catch (error) {
    reader?.stop();
    await manager.shutdown().catch(() => {});
    await writeFile(
      join(data, 'result.json'),
      JSON.stringify({
        success: false,
        stage,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    );
    app.exit(1);
  }
});
