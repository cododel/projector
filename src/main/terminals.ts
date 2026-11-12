import { diagnostic, observeDiagnosticStream, bindDiagnosticError } from '../shared/test-diagnostics';
import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { terminateOwnedProcessTree } from '../terminal/processes';
import type {
  CreateTerminal,
  TerminalRecord,
  TerminalScreen,
  TerminalOutput,
  TerminalResize,
  TerminalOptions,
  TerminalReplay,
} from '../shared/terminal';
const record = z.object({
  id: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  kind: z.enum(['shell', 'codex']),
  title: z.string(),
  createdAt: z.string(),
  status: z.enum(['running', 'exited', 'inactive', 'error']),
  exitCode: z.number().nullable(),
  signal: z.number().optional(),
  pid: z.number().optional(),
  harnessSessionId: z.string().optional(),
  operationId: z.string().optional(),
  error: z.string().optional(),
  truncated: z.boolean().optional(),
});
const screen = z.object({
  id: z.string(),
  generation: z.string().optional(),
  seq: z.number(),
  cols: z.number(),
  rows: z.number(),
  content: z.string(),
  truncated: z.boolean(),
});
const output = z.object({
  id: z.string(),
  generation: z.string().optional(),
  seq: z.number(),
  data: z.string(),
  gap: z.boolean().optional(),
});
interface Callbacks {
  onChange?: (records: TerminalRecord[]) => void;
  onOutput?: (event: TerminalOutput) => void;
  scrollback?: number;
}
export class TerminalManager {
  private worker?: UtilityProcess;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closing?: Promise<void>;
  private stoppedWorkers = new WeakSet<Electron.UtilityProcess>();
  private records: TerminalRecord[] = [];
  private recovering: Promise<void> = Promise.resolve();
  private configuration?: { data: string; servicePath: string; options: TerminalOptions };
  private startup?: Promise<void>;
  constructor(private callbacks: Callbacks = {}) {}
  start(data: string, servicePath: string, options: TerminalOptions = {}): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Terminal manager is shutting down.'));
    if (this.startup) return this.startup;
    const initialOptions = {
      ...(this.callbacks.scrollback ? { scrollback: this.callbacks.scrollback } : {}),
      ...options,
    };
    this.configuration = { data, servicePath, options: initialOptions };
    this.startup = new Promise<void>((resolve, reject) => {
      const worker = utilityProcess.fork(servicePath, [], {
        env: {
          ...process.env,
          PROJECTOR_DATA: data,
          PROJECTOR_TERMINAL_OPTIONS: JSON.stringify(initialOptions),
        },
        stdio: 'pipe',
        serviceName: 'Projector Terminals',
      });
      this.worker = worker;
      let servicePid = worker.pid;
      worker.once('spawn', () => { servicePid = worker.pid; });
      const timeout = setTimeout(() => {
        worker.kill();
        reject(new Error('Terminal service did not become ready.'));
      }, 10000);
      observeDiagnosticStream(worker.stderr, 'terminal-service', () => servicePid, 'stderr');
      observeDiagnosticStream(worker.stdout, 'terminal-service', () => servicePid, 'stdout');
      worker.once('exit', (code) => {
        diagnostic('terminal-service','process-exit',`code=${code}`,
          code === 0 || this.stoppedWorkers.has(worker) ? 'info' : 'error', {pid:servicePid});
        clearTimeout(timeout);
        this.worker = undefined;
        this.startup = undefined;
        if (!this.closing) this.recovering = this.recoverAfterExit();
        reject(new Error('Terminal service exited.'));
        for (const call of this.pending.values()) {
          clearTimeout(call.timer);
          call.reject(new Error('Terminal service disconnected; operation result is unknown.'));
        }
        this.pending.clear();
      });
      worker.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const envelope = z
          .object({
            type: z.string(),
            id: z.string().optional(),
            result: z.unknown().optional(),
            error: z.object({ code: z.string(), message: z.string(), diagnosticId: z.string().uuid().optional() }).optional(),
            terminals: z.unknown().optional(),
            output: z.unknown().optional(),
          })
          .safeParse(message);
        if (!envelope.success) return;
        const event = envelope.data;
        if (event.type === 'ready') {
          clearTimeout(timeout);
          resolve();
        } else if (event.type === 'change') {
          const parsed = z.array(record).safeParse(event.terminals);
          if (parsed.success) {
            this.records = parsed.data;
            this.callbacks.onChange?.(parsed.data);
          }
        } else if (event.type === 'output') {
          const parsed = output.safeParse(event.output);
          if (!parsed.success) return;
          worker.postMessage({ type: 'output-ack', id: parsed.data.id, seq: parsed.data.seq });
          this.callbacks.onOutput?.(parsed.data);
        } else if (event.type === 'response' && event.id) {
          const call = this.pending.get(event.id);
          if (!call) return;
          clearTimeout(call.timer);
          this.pending.delete(event.id);
          if (event.error) {
            const failure = Object.assign(new Error(event.error.message), { code: event.error.code });
            bindDiagnosticError(failure, event.error.diagnosticId);
            call.reject(failure);
          } else call.resolve(event.result);
        }
      });
    }).then(async () => {
      await this.configure(initialOptions);
    });
    return this.startup;
  }
  private request(method: string, args?: unknown): Promise<unknown> {
    if (this.closing && method !== 'shutdown')
      return Promise.reject(new Error('Terminal manager is shutting down.'));
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('Terminal service is unavailable.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(new Error('Terminal operation timed out; its result is unknown.'), {
            code: 'UNKNOWN_RESULT',
          }),
        );
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, method, args });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('Terminal service disconnected.'));
      }
    });
  }
  async snapshot(): Promise<TerminalRecord[]> {
    if (!this.worker) {
      await this.recovering;
      return this.records.map((r) => ({ ...r }));
    }
    this.records = z.array(record).parse(await this.request('snapshot'));
    return this.records;
  }
  async create(input: CreateTerminal): Promise<TerminalRecord> {
    await this.ensure();
    const result = record.parse(await this.request('create', input));
    this.records = this.records.filter((r) => r.id !== result.id).concat(result);
    return result;
  }
  async currentCwd(id: string): Promise<string> {
    await this.ensure();
    return z
      .string()
      .min(1)
      .parse(await this.request('cwd', { id }));
  }
  async screen(id: string): Promise<TerminalScreen> {
    if (!this.worker && this.configuration && this.records.some((r) => r.id === id)) {
      await this.recovering;
      return screen.parse(
        JSON.parse(
          await readFile(join(this.configuration.data, 'terminals', `${id}.json`), 'utf8'),
        ),
      );
    }
    return screen.parse(await this.request('screen', { id }));
  }
  async replay(id: string, afterSeq: number): Promise<TerminalReplay> {
    return z
      .object({
        id: z.string(),
        generation: z.string().optional(),
        seq: z.number(),
        events: z.array(output),
        gap: z.boolean(),
      })
      .parse(await this.request('replay', { id, afterSeq }));
  }
  async input(id: string, data: string, viewId: string, encoding: 'utf8' | 'binary' = 'utf8') {
    await this.request('input', { id, data, viewId, encoding });
  }
  async resize(id: string, dimensions: TerminalResize) {
    if (this.closing || !this.worker) return { resized: false };
    return z.object({resized:z.boolean()}).parse(await this.request('resize', { id, ...dimensions }));
  }
  async stop(id: string): Promise<void> {
    await this.ensure();
    await this.request('stop', { id });
  }
  async restart(
    id: string,
    options?: Pick<CreateTerminal, 'executable' | 'args' | 'env'>,
  ): Promise<TerminalRecord> {
    await this.ensure();
    return record.parse(await this.request('restart', { id, options }));
  }
  async bindSession(id: string, sessionId: string): Promise<TerminalRecord> {
    return record.parse(await this.request('bindSession', { id, sessionId }));
  }
  async updateOptions(options: TerminalOptions) {
    await this.configure(options);
  }
  async configure(options: TerminalOptions) {
    await this.request('configure', options);
    // A utility restart must use the latest acknowledged settings. A rejected
    // update leaves the previous configuration intact.
    if (this.configuration)
      this.configuration.options = { ...this.configuration.options, ...options };
  }
  private async recoverAfterExit() {
    let failed = false;
    for (const entry of this.records)
      if (entry.pid) {
        await terminateOwnedProcessTree(entry.pid).catch(() => {
          failed = true;
        });
      }
    this.records = failed
      ? this.records.map((entry) => ({
          ...entry,
          status: 'error' as const,
          error: 'Terminal service exited; process cleanup could not be verified.',
        }))
      : [];
    this.callbacks.onChange?.(this.records);
  }
  private async ensure() {
    if (this.closing) throw new Error('Terminal manager is shutting down.');
    await this.recovering;
    if (this.closing) throw new Error('Terminal manager is shutting down.');
    if (this.worker) return;
    if (this.records.some((record) => record.pid)) {
      await this.recoverAfterExit();
      if (this.records.some((record) => record.pid))
        throw new Error(
          'Terminal process cleanup is not confirmed. Retry Stop before starting another service.',
        );
    }
    const config = this.configuration;
    if (!config) throw new Error('Terminal service is unavailable.');
    await this.start(config.data, config.servicePath, config.options);
  }
  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.recovering;
      const worker = this.worker;
      if (!worker) return;
      const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
      try {
        await this.request('shutdown');
        await exited;
      } catch (error) {
        for (const entry of this.records)
          if (entry.pid) await terminateOwnedProcessTree(entry.pid).catch(error =>
            diagnostic('terminal-service','process-cleanup-error',String(error)));
        this.stoppedWorkers.add(worker);
        worker.kill();
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
        if (this.worker === worker && worker.pid) process.kill(worker.pid, 'SIGKILL');
        await exited;
        throw error;
      }
    })();
    return this.closing;
  }
}
