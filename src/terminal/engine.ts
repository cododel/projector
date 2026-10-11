import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '../runtime/files';
import { readOwnedProcessWorkingDirectory, terminateOwnedProcessTree } from './processes';
import { spawn, type IPty } from 'node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type {
  CreateTerminal,
  TerminalRecord,
  TerminalScreen,
  TerminalOutput,
  TerminalResize,
  TerminalOptions,
  TerminalReplay,
} from '../shared/terminal';

const optionsSchema = z.object({
  scrollback: z.number().int().min(100).max(50000).optional(),
  maxReplayBytes: z
    .number()
    .int()
    .min(1024)
    .max(8 * 1024 * 1024)
    .optional(),
});
const createSchema = z.object({
  projectId: z.string().min(1).max(256),
  cwd: z.string().min(1).max(4096),
  kind: z.enum(['shell', 'codex']),
  executable: z.string().min(1).max(4096).optional(),
  args: z.array(z.string().max(32768)).max(128).optional(),
  env: z.record(z.string(), z.string()).optional(),
  harnessSessionId: z.string().max(256).optional(),
  operationId: z.string().min(1).max(256).optional(),
  title: z.string().min(1).max(200).optional(),
});
const recordSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1),
  cwd: z.string().min(1),
  kind: z.enum(['shell', 'codex']),
  title: z.string(),
  createdAt: z.string(),
  status: z.enum(['running', 'exited', 'inactive', 'error']),
  exitCode: z.number().nullable(),
  signal: z.number().optional(),
  harnessSessionId: z.string().optional(),
  operationId: z.string().optional(),
  error: z.string().optional(),
  truncated: z.boolean().optional(),
});
const screenSchema = z.object({
  id: z.string().uuid(),
  generation: z.string().optional(),
  seq: z.number().int().min(0),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
  content: z.string().max(8 * 1024 * 1024),
  truncated: z.boolean(),
});
const resizeSchema = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
  viewId: z.string().min(1).max(256),
  active: z.boolean(),
});
export class TerminalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
interface Context {
  generation: string;
  registered: boolean;
  record: TerminalRecord;
  terminal: Terminal;
  serializer: SerializeAddon;
  pty?: IPty;
  seq: number;
  replay: TerminalOutput[];
  replayBytes: number;
  truncated: boolean;
  activeView: string | null;
  pending: Promise<void>;
  pendingBytes: number;
  paused: boolean;
  timer?: ReturnType<typeof setTimeout>;
  exit?: Promise<void>;
  resolveExit?: () => void;
}
interface Events {
  output?: (event: TerminalOutput) => void;
  change?: (records: TerminalRecord[]) => void;
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TerminalService {
  private contexts = new Map<string, Context>();
  private creations = new Map<string, Promise<TerminalRecord>>();
  private options: Required<TerminalOptions>;
  private writing: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private closed = false;
  private directory: string;
  constructor(
    readonly data: string,
    readonly events: Events = {},
    options: TerminalOptions = {},
  ) {
    this.options = {
      scrollback: 10000,
      maxReplayBytes: 2 * 1024 * 1024,
      ...optionsSchema.parse(options),
    };
    this.directory = join(data, 'terminals');
  }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let catalog: unknown;
    try {
      catalog = JSON.parse(await readFile(join(this.directory, 'catalog.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new TerminalError('TERMINAL_STORAGE_FAILED', 'Terminal history could not be read.');
    }
    const parsed = z
      .object({ formatVersion: z.literal(1), terminals: z.array(recordSchema).max(1000) })
      .safeParse(catalog);
    if (!parsed.success)
      throw new TerminalError(
        'TERMINAL_STORAGE_FAILED',
        'Terminal history is incompatible or damaged.',
      );
    for (const stored of parsed.data.terminals) {
      const context = this.context({ ...stored, status: 'inactive' });
      try {
        const screen = screenSchema.parse(
          JSON.parse(await readFile(this.screenPath(stored.id), 'utf8')),
        );
        if (screen.id !== stored.id) throw new Error('Screen identity mismatch');
        context.terminal.resize(screen.cols, screen.rows);
        await this.write(context, screen.content);
        context.seq = screen.seq;
        context.truncated = screen.truncated;
        context.record.truncated = screen.truncated;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          context.record.error = 'Saved terminal screen could not be restored.';
      }
      context.registered = true;
      this.contexts.set(stored.id, context);
    }
  }
  snapshot(): TerminalRecord[] {
    return [...this.contexts.values()].map((c) => ({ ...c.record }));
  }
  private context(record: TerminalRecord): Context {
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: this.options.scrollback,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    return {
      generation: randomUUID(),
      record,
      registered: false,
      terminal,
      serializer,
      seq: 0,
      replay: [],
      replayBytes: 0,
      truncated: false,
      activeView: null,
      pending: Promise.resolve(),
      pendingBytes: 0,
      paused: false,
    };
  }
  private get(id: string): Context {
    const context = this.contexts.get(id);
    if (!context) throw new TerminalError('TERMINAL_NOT_FOUND', 'Terminal is not available.');
    return context;
  }
  private available() {
    if (this.closed)
      throw new TerminalError('TERMINAL_CLOSED', 'Terminal service is shutting down.');
  }
  private changed() {
    this.events.change?.(this.snapshot());
  }
  private screenPath(id: string) {
    return join(this.directory, `${id}.json`);
  }
  private write(context: Context, text: string) {
    return new Promise<void>((resolve) => context.terminal.write(text, resolve));
  }
  private atomic(path: string, value: unknown): Promise<void> {
    const next = this.writing
      .catch(() => {})
      .then(() => atomicJson(path, value))
      .catch((error) => {
        if (error instanceof Error && 'code' in error && error.code === 'UNKNOWN_RESULT')
          throw new TerminalError(
            'UNKNOWN_RESULT',
            'Terminal data was written but durability acknowledgement failed. Reconcile before retrying.',
          );
        throw error;
      });
    this.writing = next;
    return next;
  }
  private catalog() {
    return this.atomic(join(this.directory, 'catalog.json'), {
      formatVersion: 1,
      terminals: this.snapshot().map((record) => {
        const persisted = { ...record };
        delete persisted.pid;
        return persisted;
      }),
    });
  }
  private schedule(context: Context) {
    if (context.timer || this.closed || !context.registered) return;
    context.timer = setTimeout(() => {
      context.timer = undefined;
      void this.persistScreen(context).catch(() => {
        context.record.error = 'Terminal screen could not be saved. Check local storage.';
        this.changed();
      });
    }, 100);
  }
  private async persistScreen(context: Context) {
    await this.atomic(this.screenPath(context.record.id), await this.screen(context.record.id));
    if (context.record.error === 'Terminal screen could not be saved. Check local storage.') {
      delete context.record.error;
      this.changed();
    }
  }
  private output(context: Context, data: string) {
    const bytes = Buffer.byteLength(data);
    context.pendingBytes += bytes;
    if (context.pendingBytes > 4 * 1024 * 1024 && !context.paused && context.pty) {
      context.paused = true;
      context.pty.pause();
    }
    context.pending = context.pending
      .then(async () => {
        await this.write(context, data);
        const output = {
          id: context.record.id,
          generation: context.generation,
          seq: ++context.seq,
          data,
        };
        context.replay.push(output);
        context.replayBytes += bytes;
        this.trimReplay(context);
        if (context.terminal.buffer.normal.baseY >= this.options.scrollback)
          this.markTruncated(context);
        this.events.output?.(output);
        this.schedule(context);
      })
      .finally(() => {
        context.pendingBytes -= bytes;
        if (context.paused && context.pendingBytes < 1024 * 1024) {
          context.paused = false;
          context.pty?.resume();
        }
      });
  }
  private markTruncated(context: Context) {
    if (context.truncated && context.record.truncated) return;
    context.truncated = true;
    context.record.truncated = true;
    if (context.registered) this.changed();
  }
  private trimReplay(context: Context) {
    while (context.replayBytes > this.options.maxReplayBytes) {
      const removed = context.replay.shift()!;
      context.replayBytes -= Buffer.byteLength(removed.data);
    }
  }
  private async launch(context: Context, input: CreateTerminal) {
    context.record.status = 'running';
    context.record.exitCode = null;
    delete context.record.signal;
    delete context.record.error;
    context.exit = new Promise((resolve) => {
      context.resolveExit = resolve;
    });
    try {
      context.pty = spawn(
        input.executable ??
          process.env.SHELL ??
          (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'),
        input.args ?? [],
        {
          name: 'xterm-256color',
          cols: context.terminal.cols,
          rows: context.terminal.rows,
          cwd: context.record.cwd,
          env: { ...process.env, TERM: 'xterm-256color', ...input.env },
        },
      );
      context.record.pid = context.pty.pid;
      context.pty.onData((data) => this.output(context, data));
      context.pty.onExit(({ exitCode, signal: exitSignal }) => {
        context.pty = undefined;
        delete context.record.pid;
        context.record.status = 'exited';
        context.record.exitCode = exitCode;
        context.record.signal = exitSignal;
        context.resolveExit?.();
        if (!context.registered) return;
        this.changed();
        void context.pending
          .then(async () => {
            await this.persistScreen(context);
            await this.catalog();
          })
          .catch(() => {
            context.record.error = 'Terminal exit state could not be saved.';
            this.changed();
          });
      });
    } catch {
      context.record.status = 'error';
      context.resolveExit?.();
      throw new TerminalError(
        'TERMINAL_START_FAILED',
        'Terminal could not start. Check its executable and working folder.',
      );
    }
  }
  async create(value: CreateTerminal): Promise<TerminalRecord> {
    const parsed = createSchema.parse(value);
    const prior = parsed.operationId ? this.creations.get(parsed.operationId) : undefined;
    if (prior) return prior;
    const creation = this.createOnce(parsed);
    if (parsed.operationId) this.creations.set(parsed.operationId, creation);
    try {
      return await creation;
    } finally {
      if (parsed.operationId) this.creations.delete(parsed.operationId);
    }
  }
  private async createOnce(value: CreateTerminal): Promise<TerminalRecord> {
    this.available();
    const input = createSchema.parse(value);
    if (input.operationId) {
      const prior = [...this.contexts.values()].find(
        (c) => c.record.operationId === input.operationId,
      );
      if (prior) return { ...prior.record };
    }
    if (!isAbsolute(input.cwd) || !(await stat(input.cwd)).isDirectory())
      throw new TerminalError('TERMINAL_CWD_INVALID', 'Terminal working folder is unavailable.');
    const cwd = await realpath(input.cwd);
    const context = this.context({
      id: randomUUID(),
      projectId: input.projectId,
      cwd,
      kind: input.kind,
      title: input.title ?? (input.kind === 'codex' ? 'Codex' : 'Shell'),
      createdAt: new Date().toISOString(),
      status: 'inactive',
      exitCode: null,
      ...(input.harnessSessionId ? { harnessSessionId: input.harnessSessionId } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
    });
    this.contexts.set(context.record.id, context);
    try {
      await this.launch(context, input);
      await this.catalog();
    } catch (error) {
      let cleanupFailed = false;
      await this.terminate(context).catch(() => {
        cleanupFailed = true;
      });
      await context.pending.catch(() => {});
      if (context.timer) clearTimeout(context.timer);
      if (cleanupFailed) {
        context.registered = true;
        context.record.error =
          'Creation failed and process termination was not confirmed. Stop this retained terminal and check local storage.';
        this.changed();
        throw new TerminalError('TERMINAL_CLEANUP_UNKNOWN', context.record.error);
      }
      if (error instanceof Error && 'code' in error && error.code === 'UNKNOWN_RESULT') {
        context.record.status = 'inactive';
        context.record.error =
          'Terminal creation was interrupted after a local write. The process was stopped; review the retained terminal before retrying.';
        context.registered = true;
        this.changed();
        throw new TerminalError(
          'UNKNOWN_RESULT',
          'Terminal creation acknowledgement failed. Reconcile its operation ID before retrying.',
        );
      }
      this.contexts.delete(context.record.id);
      context.terminal.dispose();
      if (error instanceof TerminalError) throw error;
      throw new TerminalError(
        'TERMINAL_STORAGE_FAILED',
        'Terminal could not be saved. No running terminal was retained.',
      );
    }
    context.registered = true;
    this.schedule(context);
    this.changed();
    return { ...context.record };
  }
  async screen(id: string): Promise<TerminalScreen> {
    const context = this.get(id);
    await context.pending;
    let scrollback = this.options.scrollback;
    let content = context.serializer.serialize({ scrollback });
    while (Buffer.byteLength(content) > 8 * 1024 * 1024 && scrollback > 0) {
      scrollback = Math.floor(scrollback / 2);
      content = context.serializer.serialize({ scrollback });
      this.markTruncated(context);
    }
    if (Buffer.byteLength(content) > 8 * 1024 * 1024)
      throw new TerminalError(
        'TERMINAL_SCREEN_TOO_LARGE',
        'Terminal screen exceeds the local storage limit.',
      );
    return {
      id,
      generation: context.generation,
      seq: context.seq,
      cols: context.terminal.cols,
      rows: context.terminal.rows,
      content,
      truncated: context.truncated,
    };
  }
  replay(id: string, afterSeq: number): TerminalReplay {
    const context = this.get(id);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      throw new TerminalError('TERMINAL_INPUT_INVALID', 'Invalid output sequence.');
    return {
      id,
      generation: context.generation,
      seq: context.seq,
      events: context.replay.filter((e) => e.seq > afterSeq),
      gap:
        afterSeq < context.seq && (!context.replay.length || context.replay[0].seq > afterSeq + 1),
    };
  }
  input(id: string, data: string, viewId: string) {
    this.available();
    const context = this.get(id);
    if (context.activeView !== viewId)
      throw new TerminalError('TERMINAL_VIEW_INACTIVE', 'Select the terminal pane before typing.');
    if (!context.pty)
      throw new TerminalError('TERMINAL_INACTIVE', 'Start or resume this terminal explicitly.');
    if (typeof data !== 'string' || Buffer.byteLength(data) > 65536)
      throw new TerminalError('TERMINAL_INPUT_INVALID', 'Terminal input exceeds the limit.');
    context.pty.write(data);
  }
  resize(id: string, value: TerminalResize) {
    this.available();
    const context = this.get(id);
    const input = resizeSchema.parse(value);
    if (!input.active) {
      if (context.activeView === input.viewId) context.activeView = null;
      return;
    }
    context.activeView = input.viewId;
    context.terminal.resize(input.cols, input.rows);
    context.pty?.resize(input.cols, input.rows);
    this.schedule(context);
  }
  async bindSession(id: string, sessionId: string) {
    this.available();
    const context = this.get(id);
    if (context.record.kind !== 'codex')
      throw new TerminalError(
        'TERMINAL_KIND_INVALID',
        'Only a Codex terminal can be bound to a session.',
      );
    const exact = z.string().min(1).max(256).parse(sessionId);
    if (context.record.harnessSessionId && context.record.harnessSessionId !== exact)
      throw new TerminalError(
        'TERMINAL_SESSION_CONFLICT',
        'This terminal belongs to another Codex session.',
      );
    const old = context.record.harnessSessionId;
    context.record.harnessSessionId = exact;
    try {
      await this.catalog();
    } catch (error) {
      if (error instanceof TerminalError && error.code === 'UNKNOWN_RESULT') {
        this.changed();
        throw error;
      }
      context.record.harnessSessionId = old;
      throw new TerminalError('TERMINAL_STORAGE_FAILED', 'Session binding could not be saved.');
    }
    this.changed();
    return { ...context.record };
  }
  async configure(value: TerminalOptions) {
    this.available();
    this.options = { ...this.options, ...optionsSchema.parse(value) };
    for (const context of this.contexts.values()) {
      if (context.terminal.buffer.normal.baseY > this.options.scrollback)
        this.markTruncated(context);
      context.terminal.options.scrollback = this.options.scrollback;
      this.trimReplay(context);
      this.schedule(context);
    }
  }
  private async terminate(context: Context) {
    const pty = context.pty;
    if (!pty) return;
    let failure: unknown;
    await terminateOwnedProcessTree(pty.pid).catch((error) => {
      failure = error;
    });
    await Promise.race([context.exit, delay(2000)]);
    if (context.pty || failure)
      throw new TerminalError(
        'TERMINAL_STOP_FAILED',
        'Terminal process termination or descendant cleanup was not confirmed.',
        failure ? { cause: failure } : undefined,
      );
  }
  private async liveCwd(context: Context): Promise<string> {
    const pty = context.pty;
    if (!pty || context.record.status !== 'running')
      throw new TerminalError(
        'TERMINAL_CWD_UNAVAILABLE',
        'The terminal process is no longer running.',
      );
    let cwd: string;
    try {
      cwd = await readOwnedProcessWorkingDirectory(pty.pid);
      if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('Invalid cwd');
      cwd = await realpath(cwd);
    } catch {
      throw new TerminalError(
        'TERMINAL_CWD_UNAVAILABLE',
        'The current terminal working folder could not be verified. Split was not started. Live cwd discovery is qualified only on macOS.',
      );
    }
    if (
      context.pty !== pty ||
      context.record.status !== 'running' ||
      context.record.pid !== pty.pid
    )
      throw new TerminalError(
        'TERMINAL_CWD_UNAVAILABLE',
        'The terminal exited while its working folder was being read. Split was not started.',
      );
    return cwd;
  }
  async currentCwd(id: string): Promise<string> {
    this.available();
    const context = this.get(id);
    const cwd = context.pty ? await this.liveCwd(context) : context.record.cwd;
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error('Missing cwd');
    } catch {
      throw new TerminalError(
        'TERMINAL_CWD_UNAVAILABLE',
        'The confirmed terminal working folder is no longer available. Split was not started.',
      );
    }
    if (cwd === context.record.cwd) return cwd;
    const previous = context.record.cwd;
    context.record.cwd = cwd;
    try {
      await this.catalog();
    } catch (error) {
      if (error instanceof TerminalError && error.code === 'UNKNOWN_RESULT') {
        this.changed();
        throw error;
      }
      context.record.cwd = previous;
      throw new TerminalError(
        'TERMINAL_STORAGE_FAILED',
        'The current terminal working folder could not be saved. Split was not started.',
      );
    }
    this.changed();
    return cwd;
  }
  private async checkpointCwd(context: Context) {
    if (!context.pty || context.record.kind !== 'shell') return;
    try {
      context.record.cwd = await this.liveCwd(context);
    } catch {
      context.record.error =
        'The last terminal working folder could not be verified; the previous confirmed folder is retained.';
    }
  }
  async stop(id: string) {
    this.available();
    const context = this.get(id);
    await this.checkpointCwd(context);
    await this.terminate(context);
    await context.pending;
    await this.persistScreen(context);
    await this.catalog();
    this.changed();
    return { ...context.record };
  }
  async restart(id: string, options: Pick<CreateTerminal, 'executable' | 'args' | 'env'> = {}) {
    this.available();
    const context = this.get(id);
    if (context.record.kind !== 'shell')
      throw new TerminalError(
        'TERMINAL_RESUME_REQUIRED',
        'Codex requires an explicit session Resume.',
      );
    if (context.pty)
      throw new TerminalError('TERMINAL_ALREADY_RUNNING', 'This terminal is already running.');
    await this.launch(
      context,
      createSchema.parse({
        ...options,
        projectId: context.record.projectId,
        cwd: context.record.cwd,
        kind: 'shell',
      }),
    );
    try {
      await this.catalog();
    } catch {
      await this.terminate(context);
      throw new TerminalError(
        'TERMINAL_STORAGE_FAILED',
        'The restarted terminal could not be saved and was stopped.',
      );
    }
    this.changed();
    return { ...context.record };
  }
  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const errors: unknown[] = [];
      for (const context of this.contexts.values()) {
        if (context.timer) clearTimeout(context.timer);
        try {
          await this.checkpointCwd(context);
          await this.terminate(context);
          await context.pending;
          await this.persistScreen(context);
        } catch (error) {
          errors.push(error);
        }
        context.terminal.dispose();
      }
      await this.catalog().catch((error) => errors.push(error));
      await this.writing.catch(() => {});
      if (errors.length)
        throw new TerminalError(
          'TERMINAL_SHUTDOWN_FAILED',
          'Terminal shutdown or local saving was not confirmed.',
        );
    })();
    return this.closing;
  }
}
