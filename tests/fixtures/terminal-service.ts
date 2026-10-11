import { app } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TerminalManager } from '../../src/main/terminals';
import { TerminalOutputReader } from '../../src/renderer/terminal-output';
import type { TerminalScreen } from '../../src/shared/terminal';
const data = process.argv[2];
const servicePath = process.argv[3];
app.setPath('userData', data);
if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
const until = async (
  condition: () => Promise<boolean>,
  message = 'Terminal fixture timed out.',
) => {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((r) => setTimeout(r, 20));
  }
};
void app.whenReady().then(async () => {
  let manager = new TerminalManager();
  let reader: TerminalOutputReader | undefined;
  let rendered = '',
    observedSeq = 0,
    readerTerminal = '';
  let savedSeq = 0;
  let stage = 'initial startup';
  try {
    await manager.start(data, servicePath, { scrollback: 20000 });
    stage = 'create Unicode terminal';
    const record = await manager.create({
      projectId: 'isolated-project',
      cwd: data,
      kind: 'shell',
      executable: '/bin/sh',
      args: [
        '-c',
        'stty -echo; printf "READY\\n"; read line; printf "INPUT:%s\\n" "$line"; printf "SIZE:"; stty size; awk \'BEGIN { for (i=0; i<10050; i++) printf "RESTORE_HISTORY:%05d\\n", i }\'; exit 7',
      ],
    });
    await until(async () => (await manager.screen(record.id)).content.includes('READY'));
    stage = 'write Unicode terminal';
    await manager.resize(record.id, { cols: 101, rows: 37, viewId: 'pane', active: true });
    await manager.input(record.id, 'Привет 🙂 日本語\r', 'pane');
    await until(async () => (await manager.snapshot())[0].status === 'exited');
    stage = 'read large terminal screen';
    const screen = await manager.screen(record.id);
    if (
      !screen.content.includes('INPUT:Привет 🙂 日本語') ||
      !screen.content.includes('SIZE:37 101')
    )
      throw new Error('Wrong PTY content or viewport.');
    await manager.shutdown();
    stage = 'restore large terminal history';
    manager = new TerminalManager({
      onOutput: (output) => {
        if (output.id === readerTerminal) {
          observedSeq = output.seq;
          reader?.push(output);
        }
      },
    });
    await manager.start(data, servicePath, { scrollback: 20000 });
    stage = 'read restored large history';
    const restored = await manager.snapshot();
    const restoredScreen = await manager.screen(record.id);
    if (
      restored[0].status !== 'inactive' ||
      restored[0].pid !== undefined ||
      !restoredScreen.content.includes('Привет 🙂 日本語') ||
      !restoredScreen.content.includes('RESTORE_HISTORY:00000') ||
      !restoredScreen.content.includes('RESTORE_HISTORY:10049')
    )
      throw new Error('Restore executed a process or lost the screen.');
    await manager.updateOptions({ scrollback: 100, maxReplayBytes: 1024 });
    stage = 'create crash terminal';
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
      args: [
        '-c',
        'stty -echo; sleep 120 & printf "CRASH_CHILD:%s\\n" "$!"; read line; printf "UNPERSISTED_OUTPUT\\n"; wait',
      ],
    });
    let child = 0;
    await until(async () => {
      const match = (await manager.screen(crash.id)).content.match(/CRASH_CHILD:(\d+)/);
      child = Number(match?.[1]);
      return child > 0;
    });
    const helper = app.getAppMetrics().find((entry) => entry.name === 'Blueprint Terminals');
    if (!helper || !crash.pid) throw new Error('Missing owned terminal service or shell PID.');
    await until(async () => {
      const persisted = await readFile(join(data, 'terminals', `${crash.id}.json`), 'utf8').catch(
        () => 'null',
      );
      const saved = JSON.parse(persisted) as TerminalScreen | null;
      savedSeq = saved?.seq ?? 0;
      return Boolean(saved?.content.includes('CRASH_CHILD:'));
    });
    readerTerminal = crash.id;
    reader = new TerminalOutputReader({
      screen: () => manager.screen(crash.id),
      replay: (seq) => manager.replay(crash.id, seq),
      reset: async (screen) => {
        rendered = screen.content;
      },
      write: async (output) => {
        rendered += output;
      },
      error: (error) => {
        throw error;
      },
    });
    await reader.start();
    await manager.resize(crash.id, { cols: 80, rows: 24, viewId: 'crash-reader', active: true });
    await manager.input(crash.id, '\r', 'crash-reader');
    await until(async () => rendered.includes('UNPERSISTED_OUTPUT'));
    process.kill(helper.pid, 'SIGKILL');
    stage = 'recover crash terminal';
    await until(async () => {
      try {
        return (await manager.snapshot()).find((r) => r.id === crash.id)?.status === 'inactive';
      } catch (error) {
        if ((error as Error).message.includes('Terminal service disconnected')) return false;
        throw error;
      }
    });
    const recoveredScreen = await manager.screen(crash.id);
    if (
      recoveredScreen.seq !== savedSeq ||
      recoveredScreen.seq >= observedSeq ||
      recoveredScreen.content.includes('UNPERSISTED_OUTPUT')
    )
      throw new Error('The real crash did not enter the unpersisted output window.');
    const crashSequence = {
      persisted: savedSeq,
      observed: observedSeq,
      restored: recoveredScreen.seq,
    };
    for (const pid of [crash.pid, child]) {
      try {
        process.kill(pid, 0);
        throw new Error(`Terminal service crash left owned process ${pid} running.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const restarted = await manager.restart(crash.id, {
      executable: '/bin/sh',
      args: [
        '-c',
        'stty -echo; printf "EXPLICIT_RESTART\\n"; read start; i=0; while [ "$i" -lt 400 ]; do printf "RESTART_LINE:%04d long fixture history\\n" "$i"; i=$((i+1)); done; read line',
      ],
    });
    stage = 'read restarted terminal';
    if (restarted.pid === crash.pid || restarted.id !== crash.id || restarted.status !== 'running')
      throw new Error('Explicit shell restart did not preserve identity with a new process.');
    await until(
      async () => rendered.includes('EXPLICIT_RESTART'),
      `Fresh output was lost after service sequence rollback ${crashSequence.observed} → ${crashSequence.restored}.`,
    );
    if (rendered.includes('UNPERSISTED_OUTPUT'))
      throw new Error('The old unconfirmed screen was retained after service recovery.');
    await manager.resize(crash.id, { cols: 80, rows: 24, viewId: 'crash-reader', active: true });
    await manager.input(crash.id, '\r', 'crash-reader');
    await until(async () => (await manager.screen(crash.id)).content.includes('RESTART_LINE:0399'));
    const configuredScreen = await manager.screen(crash.id);
    const configuredReplay = await manager.replay(crash.id, 0);
    if (!configuredScreen.truncated || configuredScreen.content.includes('RESTART_LINE:0000'))
      throw new Error('Service recovery lost the latest accepted scrollback setting.');
    if (
      !configuredReplay.gap ||
      configuredReplay.events.reduce((bytes, event) => bytes + Buffer.byteLength(event.data), 0) >
        1024
    )
      throw new Error('Service recovery lost the latest accepted replay byte limit.');
    reader.stop();
    stage = 'reject terminal creation during shutdown';
    const closing = manager.shutdown();
    let shutdownCreateRejected = false;
    try {
      await manager.create({ projectId: 'isolated-project', cwd: data, kind: 'shell',
        executable: '/bin/sh', args: ['-c', 'sleep 120'] });
    } catch (error) {
      shutdownCreateRejected = (error as Error).message.includes('shutting down');
    }
    await closing;
    if (!shutdownCreateRejected) throw new Error('Terminal creation was not rejected during shutdown.');
    await writeFile(
      join(data, 'result.json'),
      JSON.stringify({
        success: true,
        versions: process.versions,
        restored,
        screen: restoredScreen,
        configuredScreen,
        configuredReplay,
        crashSequence,
        restartedOutputDisplayed: true,
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
