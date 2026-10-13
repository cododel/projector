import { homedir } from 'node:os';
import { observeChild, markChildStop, diagnostic, bindDiagnosticError, errorDiagnosticId } from '../shared/test-diagnostics';
import { linkedWorktreePath } from './worktree';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type {
  CodexCompatibility,
  CodexLaunch,
  HarnessProject,
  HarnessSession,
  HarnessSessionStatus,
  HarnessSnapshot,
  HarnessMcpStartup,
} from '../shared/harness';

class CodexShutdownError extends Error {
  constructor() { super('CODEX_MANAGER_STOPPED'); }
}

const QUALIFIED_VERSION = '0.162.1';
const RPC_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const ownedGroups = new WeakSet<ChildProcessWithoutNullStreams>();
const statusSchema = z.object({ type: z.string() }).passthrough();
const threadSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().nullable().optional(),
    cwd: z.string(),
    name: z.string().nullable().optional(),
    preview: z.string().optional(),
    updatedAt: z.number(),
    status: statusSchema.optional(),
    ephemeral: z.boolean().optional(),
    parentThreadId: z.string().nullable().optional(),
    source: z
      .union([
        z.string(),
        z
          .object({ subAgent: z.union([z.string(), z.record(z.string(), z.unknown())]) })
          .passthrough(),
        z.object({ custom: z.string() }).passthrough(),
      ])
      .nullable()
      .optional(),
    threadSource: z.string().nullable().optional(),
  })
  .passthrough();
const envelopeSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();
type Envelope = z.infer<typeof envelopeSchema>;
type Thread = z.infer<typeof threadSchema>;
const mcpStartupSchema = z.object({
  name: z.literal('projector'),
  status: z.enum(['starting', 'ready', 'failed', 'cancelled']),
  threadId: z.string().min(1).max(256).nullable().optional(),
  error: z.string().max(4096).nullable().optional(),
  failureReason: z.literal('reauthenticationRequired').nullable().optional(),
});
interface McpObservation {
  sequence: number;
  params: z.infer<typeof mcpStartupSchema>;
  observedAt: string;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface CodexManagerOptions {
  getExecutable: () => string;
  getEnvironment?: () => Record<string, string | undefined>;
  getProfile?: () => string | undefined;
  /** Dot-path TOML overrides for the app-owned Projector MCP bridge only. */
  getMcpOverrides: () => Record<string, unknown>;
  onIdentity?: (terminalId: string, sessionId: string) => void;
  onChange?: () => void;
  onError?: (message: string) => void;
}
interface LaunchRecord {
  id: string;
  projectId: string;
  cwd: string;
  mode: 'new' | 'resume';
  expectedId?: string;
  sessionId?: string;
  terminalId?: string;
  child: ChildProcessWithoutNullStreams;
  server: Server;
  gateway: WebSocketServer;
  sockets: Set<WebSocket>;
  startupTimer: ReturnType<typeof setTimeout>;
  stopped: boolean;
  cleanup?: Promise<void>;
  tuiConnected?: boolean;
  mcpSequence: number;
  mcpObservedSequence: number;
  pendingMcp: Map<string, McpObservation>;
}
function isAlive(child: ChildProcessWithoutNullStreams) {
  return child.exitCode === null && child.signalCode === null;
}
async function terminate(child: ChildProcessWithoutNullStreams) {
  const grouped = ownedGroups.has(child) && process.platform !== 'win32' && child.pid !== undefined;
  if (!isAlive(child) && !grouped) return;
  const signal = (value: NodeJS.Signals) => {
    try {
      if (grouped) process.kill(-child.pid!, value);
      else if (isAlive(child)) child.kill(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  markChildStop(child);
  signal('SIGTERM');
  if (!isAlive(child)) return;
  await new Promise<void>((done) => {
    const timeout = setTimeout(() => {
      signal('SIGKILL');
      done();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      done();
    });
  });
  // The backend can exit before an inherited worker. Only its owned group is targeted.
  if (grouped) signal('SIGKILL');
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function state(value: string | undefined): HarnessSessionStatus {
  switch (value) {
    case 'idle':
      return 'idle';
    case 'active':
      return 'active';
    case 'systemError':
      return 'error';
    default:
      return 'unknown';
  }
}
async function canonical(path: string) {
  return realpath(path).catch(() => resolve(path));
}
async function freePort() {
  const server = createNetServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('CODEX_BACKEND_ADDRESS_MISSING');
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}
function allowedToken(value: string | undefined, token: string) {
  if (!value?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** An owned, read-only protocol connection. Listing never resumes a thread. */
class DiscoveryClient {
  private sequence = 0;
  private pending = new Map<string | number, Pending>();
  private input = '';
  private inputBytes = 0;
  private failure: Error | null = null;
  private receive = (chunk: string) => {
    if (this.failure) return;
    this.input += chunk;
    this.inputBytes += Buffer.byteLength(chunk);
    let end: number;
    // JSONL is delimited by LF. Node readline also splits U+2028/U+2029,
    // which are legal characters inside a JSON string such as a thread preview.
    while ((end = this.input.indexOf('\n')) !== -1) {
      const line = this.input.slice(0, end);
      const bytes = Buffer.byteLength(line);
      this.input = this.input.slice(end + 1);
      this.inputBytes -= bytes + 1;
      if (bytes > MAX_MESSAGE_BYTES) {
        this.fail(new Error('CODEX_PROTOCOL_MESSAGE_TOO_LARGE'));
        return;
      }
      this.receiveLine(line);
      if (this.failure) return;
    }
    if (this.inputBytes > MAX_MESSAGE_BYTES)
      this.fail(new Error('CODEX_PROTOCOL_MESSAGE_TOO_LARGE'));
  };
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', this.receive);
    child.on('error', (error) => this.fail(new Error('CODEX_START_FAILED: ' + error.message)));
    child.on('exit', () => this.fail(new Error('CODEX_BACKEND_STOPPED')));
    observeChild(child, 'codex');
  }
  private receiveLine(line: string) {
    try {
      const value = envelopeSchema.parse(JSON.parse(line));
      if (value.id === undefined) return;
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error !== undefined) {
        const error = z.object({ code: z.number(), message: z.string() }).safeParse(value.error);
        const activeWriter = error.success && error.data.code === -32600 &&
          /^thread \S+ already has an active writer$/.test(error.data.message);
        pending.reject(new Error(activeWriter
          ? 'CODEX_SESSION_IN_USE: This session is already in use by another Codex process. Return to the existing launch, or retry after it releases the session. Projector will not take it over.'
          : 'CODEX_RPC_FAILED: ' + JSON.stringify(value.error), { cause: value.error }));
      } else pending.resolve(value.result);
    } catch {
      this.fail(new Error('CODEX_PROTOCOL_INVALID_MESSAGE'));
    }
  }
  private fail(error: Error) {
    // Keep the first terminal cause. The later OS exit notification must not
    // turn explicit shutdown into an unexplained backend failure, or conceal
    // a real earlier protocol failure behind shutdown.
    if (this.failure) return;
    this.failure = error;
    this.input = '';
    this.inputBytes = 0;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  call(method: string, params: unknown = {}): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CODEX_RPC_TIMEOUT: ' + method));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve: done, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) this.fail(new Error('CODEX_CONNECTION_FAILED: ' + error.message));
      });
    });
  }
  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'projector', title: 'Projector', version: '0.1.0-alpha.1' },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }
  async stop() {
    this.child.stdout.off('data', this.receive);
    this.child.stdout.resume();
    this.fail(new CodexShutdownError());
    await terminate(this.child);
  }
}

/** No model turns or terminal input are sent by this manager. */
export class CodexManager {
  private sessions = new Map<string, HarnessSession>();
  private projects: HarnessProject[] = [];
  private listedIds = new Set<string>();
  private compatibility: CodexCompatibility | null = null;
  private error: string | null = null;
  private discovery: DiscoveryClient | null = null;
  private discoveryStarting: Promise<DiscoveryClient> | null = null;
  private launches = new Map<string, LaunchRecord>();
  private mcpStartup = new Map<string, HarnessMcpStartup>();
  private startingLaunches = new Set<Promise<CodexLaunch>>();
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private discoveryKey: string | null = null;
  constructor(private options: CodexManagerOptions) {}

  private environment() {
    const merged = { ...process.env, ...this.options.getEnvironment?.() };
    return Object.fromEntries(
      Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  }
  private profileArguments() {
    const profile = this.options.getProfile?.();
    return profile ? ['-p', profile] : [];
  }
  private mcpArguments() {
    const overrides = this.options.getMcpOverrides();
    for (const key of Object.keys(overrides)) {
      if (!key.startsWith('mcp_servers.projector.'))
        throw new Error('CODEX_OVERRIDE_NOT_PROJECTOR_MCP');
    }
    return Object.entries(overrides).flatMap(([key, value]) => [
      '-c',
      `${key}=${JSON.stringify(value)}`,
    ]);
  }
  private changed() {
    this.options.onChange?.();
  }
  private failed(error: unknown) {
    const cause = errorDiagnosticId(error);
    const id = diagnostic('codex-manager', 'adapter-error', message(error), cause ? 'info' : 'error', {
      forwardedFrom: cause, stack: error instanceof Error ? error.stack : undefined,
    });
    bindDiagnosticError(error, cause ?? id);
    this.error = message(error);
    this.options.onError?.(this.error);
    this.changed();
  }
  snapshot(): HarnessSnapshot {
    return structuredClone({
      sessions: [...this.sessions.values()]
        .filter((session) => !session.isSubAgent && !session.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      compatibility: this.compatibility,
      error: this.error,
      mcpStartup: [...this.mcpStartup.values()],
    });
  }
  async checkCompatibility(): Promise<CodexCompatibility> {
    const executable = this.options.getExecutable();
    const child = spawn(executable, ['--version'], {
      env: this.environment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    observeChild(child, 'codex');
    try {
      await new Promise<void>((done, reject) => {
        const timeout = setTimeout(() => {
          void terminate(child);
          reject(new Error('CODEX_VERSION_TIMEOUT'));
        }, RPC_TIMEOUT_MS);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(new Error('CODEX_NOT_AVAILABLE: ' + error.message));
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          if (code === 0) done();
          else reject(new Error('CODEX_VERSION_FAILED'));
        });
      });
      const version = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
      if (!version) throw new Error('CODEX_VERSION_INVALID');
      if (version !== QUALIFIED_VERSION)
        throw new Error(`CODEX_VERSION_UNQUALIFIED: ${version}; qualified ${QUALIFIED_VERSION}`);
      this.compatibility = { executable, version, qualified: true };
      this.error = null;
    } catch (error) {
      const version = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
      this.compatibility = { executable, version, qualified: false, error: message(error) };
      this.failed(error);
    }
    this.changed();
    return { ...this.compatibility };
  }
  private async qualified() {
    const compatibility = await this.checkCompatibility();
    if (!compatibility.qualified) throw new Error(compatibility.error);
  }
  private async discoveryClient() {
    if (this.stopping) throw new CodexShutdownError();
    const key = JSON.stringify([
      this.options.getExecutable(),
      this.options.getProfile?.(),
      this.options.getEnvironment?.(),
      this.mcpArguments(),
    ]);
    if (this.discovery && this.discoveryKey !== key) {
      await this.discovery.stop();
      this.discovery = null;
    }
    if (this.discovery && isAlive(this.discovery.child)) return this.discovery;
    if (this.discoveryStarting) return this.discoveryStarting;
    const starting = (async () => {
      await this.qualified();
      const child = spawn(
        this.options.getExecutable(),
        [...this.profileArguments(), 'app-server', '--listen', 'stdio://', ...this.mcpArguments()],
        {
          env: this.environment(),
          cwd: homedir(),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        },
      );
      ownedGroups.add(child);
      const client = new DiscoveryClient(child);
      try {
        await client.initialize();
        if (this.stopping) throw new CodexShutdownError();
        this.discovery = client;
        this.discoveryKey = key;
        return client;
      } catch (error) {
        await client.stop();
        throw error;
      }
    })();
    this.discoveryStarting = starting;
    try {
      return await starting;
    } finally {
      if (this.discoveryStarting === starting) this.discoveryStarting = null;
    }
  }
  private async session(
    thread: Thread,
    launch?: LaunchRecord,
    worktrees?: Map<string, Promise<string | undefined>>,
  ): Promise<HarnessSession> {
    const cwd = await canonical(thread.cwd);
    let worktree = worktrees?.get(cwd);
    if (!worktree) {
      worktree = linkedWorktreePath(cwd);
      worktrees?.set(cwd, worktree);
    }
    const worktreePath = await worktree;
    const previous = this.sessions.get(thread.id);
    const project = this.projects.find((value) => value.path === cwd);
    const owned =
      launch ??
      (previous?.launchId ? this.launches.get(previous.launchId) : undefined) ??
      [...this.launches.values()].find(
        (record) => record.sessionId === thread.id && !record.stopped,
      );
    const running = owned && !owned.stopped;
    return {
      id: thread.id,
      harness: 'codex',
      ...(worktreePath ? { worktreePath } : {}),
      ...(thread.sessionId ? { rootSessionId: thread.sessionId } : {}),
      projectId: owned?.projectId ?? project?.id ?? null,
      cwd,
      title: thread.name || thread.preview || 'Untitled session',
      updatedAt: thread.updatedAt,
      isSubAgent:
        Boolean(thread.parentThreadId) ||
        (typeof thread.source === 'object' &&
          thread.source !== null &&
          Object.hasOwn(thread.source, 'subAgent')),
      ...(previous?.archived === undefined ? {} : { archived: previous.archived }),
      status: running
        ? thread.status?.type === 'notLoaded'
          ? (previous?.status ?? 'unknown')
          : state(thread.status?.type)
        : previous?.processState === 'stopped'
          ? previous.status
          : 'unknown',
      processState: running
        ? 'running'
        : previous?.processState === 'stopped'
          ? 'stopped'
          : 'unknown',
      ...(owned ? { launchId: owned.id } : {}),
      ...(owned?.terminalId
        ? { terminalId: owned.terminalId }
        : previous?.terminalId
          ? { terminalId: previous.terminalId }
          : {}),
    };
  }
  async discover(projects: HarnessProject[]): Promise<HarnessSession[]> {
    try {
      this.projects = await Promise.all(
        projects.map(async (project) => ({ ...project, path: await canonical(project.path) })),
      );
      // Quit can begin while canonical paths are being resolved. Discovery
      // is read-only; finish with the current catalog instead of starting a
      // new client after the lifecycle owner has stopped it.
      if (this.stopping) return this.snapshot().sessions;
      const client = await this.discoveryClient();
      const found = new Map<string, HarnessSession>();
      const worktrees = new Map<string, Promise<string | undefined>>();
      // Codex exposes archived/non-archived as exclusive filters. Read both
      // sets without invoking the optional rollout scan-and-repair behavior.
      for (const archived of [false, true]) {
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = z
            .object({ data: z.array(threadSchema), nextCursor: z.string().nullable() })
            .parse(
              await client.call('thread/list', {
                limit: 100,
                ...(cursor ? { cursor } : {}),
                archived,
                useStateDbOnly: true,
                modelProviders: [],
                sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
              }),
            );
          for (const thread of page.data)
            if (!thread.ephemeral)
              found.set(thread.id, {
                ...(await this.session(thread, undefined, worktrees)),
                archived,
              });
          cursor = page.nextCursor ?? undefined;
          if (cursor && cursors.has(cursor)) throw new Error('CODEX_PAGINATION_CYCLE');
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      this.listedIds = new Set(found.keys());
      // Listing can overlap Resume or Stop. Keep current process ownership while
      // retaining fresh catalog metadata, including archive/subagent classification.
      for (const session of this.sessions.values()) {
        const owned = session.launchId ? this.launches.get(session.launchId) : undefined;
        if (!owned && session.processState !== 'stopped') continue;
        const listed = found.get(session.id);
        if (listed) {
          delete listed.launchId;
          delete listed.terminalId;
          found.set(session.id, {
            ...listed,
            processState: session.processState,
            status: session.status,
            ...(owned ? { launchId: owned.id, projectId: owned.projectId } : {}),
            ...(session.terminalId ? { terminalId: session.terminalId } : {}),
          });
        } else if (owned) found.set(session.id, session);
      }
      this.sessions = found;
      this.error = null;
      this.changed();
      return this.snapshot().sessions;
    } catch (error) {
      if (this.stopping && error instanceof CodexShutdownError) return this.snapshot().sessions;
      this.failed(error);
      throw error;
    }
  }
  async read(sessionId: string): Promise<HarnessSession> {
    try {
      const client = await this.discoveryClient();
      const result = z
        .object({ thread: threadSchema })
        .parse(await client.call('thread/read', { threadId: sessionId, includeTurns: false }));
      if (result.thread.id !== sessionId) throw new Error('CODEX_THREAD_ID_MISMATCH');
      const session = await this.session(result.thread);
      this.sessions.set(session.id, session);
      this.changed();
      return { ...session };
    } catch (error) {
      const rpc = z.object({ code: z.number(), message: z.string() }).safeParse(
        error instanceof Error ? error.cause : undefined,
      );
      if (rpc.success && rpc.data.code === -32600 && rpc.data.message === `thread not loaded: ${sessionId}`) {
        // Confirm absence through authoritative history, rather than treating
        // every not-loaded response as a deleted or empty session.
        await this.discover(this.projects);
        if (!this.sessions.has(sessionId)) {
          throw new Error('CODEX_SESSION_UNAVAILABLE: This session is no longer available in Codex. Start a new session.', { cause: error });
        }
      }
      this.failed(error);
      throw error;
    }
  }
  async setArchived(sessionId: string, archived: boolean) {
    z.string().min(1).max(512).parse(sessionId);
    await this.read(sessionId);
    try {
      const client = await this.discoveryClient();
      const result = await client.call(archived ? 'thread/archive' : 'thread/unarchive', {
        threadId: sessionId,
      });
      if (archived) z.object({}).parse(result);
      else {
        const restored = z.object({ thread: threadSchema }).parse(result);
        if (restored.thread.id !== sessionId) throw new Error('CODEX_THREAD_ID_MISMATCH');
        this.sessions.set(sessionId, await this.session(restored.thread));
      }
    } catch (error) {
      // Never resend a mutation after a lost acknowledgement. Reconcile by
      // reading the authoritative archived/non-archived listings instead.
      if (!(error instanceof Error) || !/^CODEX_(RPC_|CONNECTION_|BACKEND_)/.test(error.message)) {
        this.failed(error);
        throw error;
      }
      let confirmed = false;
      try {
        await this.discover(this.projects);
        confirmed =
          this.listedIds.has(sessionId) && this.sessions.get(sessionId)?.archived === archived;
      } catch {
        /* A failed read cannot confirm a mutation. */
      }
      if (!confirmed) {
        this.failed(error);
        throw error;
      }
    }
    const session = this.sessions.get(sessionId);
    if (session) session.archived = archived;
    this.changed();
    return { sessionId, archived };
  }
  launchNew(projectId: string, cwd: string) {
    return this.launch(projectId, cwd);
  }
  async launchResume(projectId: string, cwd: string, sessionId: string) {
    if (this.sessions.get(sessionId)?.processState === 'running')
      throw new Error('CODEX_SESSION_ALREADY_RUNNING');
    const session = await this.read(sessionId);
    if (session.cwd !== (await canonical(cwd))) throw new Error('CODEX_SESSION_PROJECT_MISMATCH');
    return this.launch(projectId, cwd, sessionId);
  }
  private launch(projectId: string, cwd: string, expectedId?: string): Promise<CodexLaunch> {
    if (this.stopping) return Promise.reject(new Error('CODEX_MANAGER_STOPPED'));
    const operation = this.prepareLaunch(projectId, cwd, expectedId);
    this.startingLaunches.add(operation);
    void operation.finally(() => this.startingLaunches.delete(operation)).catch(() => {});
    return operation;
  }
  private async prepareLaunch(
    projectId: string,
    cwd: string,
    expectedId?: string,
  ): Promise<CodexLaunch> {
    if (this.stopping) throw new CodexShutdownError();
    await this.qualified();
    if (this.stopping) throw new CodexShutdownError();
    const executable = this.options.getExecutable();
    const environment = this.environment();
    const mcpArguments = this.mcpArguments();
    const directory = await canonical(cwd);
    const port = await freePort();
    if (this.stopping) throw new CodexShutdownError();
    const backendUrl = `ws://127.0.0.1:${port}`;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const id = randomUUID();
    const tokenVariable = 'PROJECTOR_CODEX_REMOTE_TOKEN';
    const child = spawn(
      executable,
      [
        ...this.profileArguments(),
        'app-server',
        '--listen',
        backendUrl,
        '--ws-auth',
        'capability-token',
        '--ws-token-sha256',
        tokenHash,
        ...mcpArguments,
      ],
      {
        cwd: directory,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    ownedGroups.add(child);
    child.stdin.end();
    child.stdout.resume();
    observeChild(child, 'codex');
    let startError: Error | undefined;
    child.once('error', (error) => {
      startError = error;
    });
    const sockets = new Set<WebSocket>();
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const gateway = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    let record: LaunchRecord | undefined;
    try {
      await this.waitForBackend(backendUrl, token, child, () => startError);
      if (this.stopping) throw new CodexShutdownError();
      server.on('upgrade', (request, socket, head) => {
        // Neither cookies nor an external browser Origin authorizes this control endpoint.
        if (
          request.headers.origin !== undefined ||
          !allowedToken(request.headers.authorization, token)
        ) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        if (record?.tuiConnected) {
          socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        gateway.handleUpgrade(request, socket, head, (websocket) =>
          gateway.emit('connection', websocket, request),
        );
      });
      await new Promise<void>((done, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', done);
      });
      if (this.stopping) throw new CodexShutdownError();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('CODEX_GATEWAY_ADDRESS_MISSING');
      const startupTimer = setTimeout(() => {
        if (record && !record.sessionId) {
          this.failed(new Error('CODEX_TUI_IDENTITY_TIMEOUT'));
          void this.stopLaunch(record);
        }
      }, 30_000);
      startupTimer.unref();
      record = {
        id,
        projectId,
        cwd: directory,
        mode: expectedId ? 'resume' : 'new',
        ...(expectedId ? { expectedId } : {}),
        child,
        server,
        gateway,
        sockets,
        startupTimer,
        stopped: false,
        mcpSequence: 0,
        mcpObservedSequence: 0,
        pendingMcp: new Map(),
      };
      this.launches.set(id, record);
      this.mcpStartup.set(id, { launchId: id, projectId, status: 'unknown' });
      this.changed();
      const owned = record;
      gateway.on('connection', (downstream) =>
        this.connectTui(owned, downstream, backendUrl, token),
      );
      child.on('exit', () => {
        if (!owned.stopped) {
          this.failed(new Error('CODEX_BACKEND_STOPPED'));
          void this.stopLaunch(owned);
        }
      });
      return {
        launchId: id,
        executable,
        cwd: directory,
        args: [
          ...this.profileArguments(),
          ...(expectedId ? ['resume', expectedId] : []),
          '--remote',
          `ws://127.0.0.1:${address.port}`,
          '--remote-auth-token-env',
          tokenVariable,
          '-C',
          directory,
          ...mcpArguments,
        ],
        env: { ...environment, [tokenVariable]: token },
      };
    } catch (error) {
      for (const socket of sockets) socket.terminate();
      gateway.close();
      if (server.listening) await new Promise<void>((done) => server.close(() => done()));
      await terminate(child);
      this.failed(error);
      throw error;
    }
  }
  private async waitForBackend(
    url: string,
    token: string,
    child: ChildProcessWithoutNullStreams,
    getError: () => Error | undefined,
  ) {
    const deadline = Date.now() + RPC_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (getError()) throw new Error('CODEX_START_FAILED: ' + getError()!.message);
      if (!isAlive(child)) throw new Error('CODEX_BACKEND_START_FAILED');
      const connected = await new Promise<boolean>((done) => {
        const socket = new WebSocket(url, {
          headers: { Authorization: `Bearer ${token}` },
          handshakeTimeout: 500,
        });
        socket.once('open', () => {
          socket.close();
          done(true);
        });
        socket.once('error', () => {
          socket.terminate();
          done(false);
        });
      });
      if (connected) return;
      await new Promise<void>((done) => setTimeout(done, 50));
    }
    throw new Error('CODEX_BACKEND_START_TIMEOUT');
  }
  private connectTui(
    record: LaunchRecord,
    downstream: WebSocket,
    backendUrl: string,
    token: string,
  ) {
    record.tuiConnected = true;
    const upstream = new WebSocket(backendUrl, {
      headers: { Authorization: `Bearer ${token}` },
      maxPayload: MAX_MESSAGE_BYTES,
    });
    record.sockets.add(downstream);
    record.sockets.add(upstream);
    const queue: string[] = [];
    let queuedBytes = 0;
    const identityRequests = new Set<string | number>();
    let claimed = false;
    const fail = (error: unknown) => {
      this.failed(error);
      void this.stopLaunch(record);
    };
    upstream.on('open', () => {
      for (const value of queue.splice(0)) upstream.send(value);
      queuedBytes = 0;
    });
    downstream.on('message', (raw) => {
      try {
        const text = raw.toString();
        const value = envelopeSchema.parse(JSON.parse(text));
        if (value.id !== undefined && !record.sessionId && this.isIdentityRequest(record, value))
          identityRequests.add(value.id);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
        else {
          queuedBytes += Buffer.byteLength(text);
          if (queuedBytes > MAX_MESSAGE_BYTES) throw new Error('CODEX_GATEWAY_BACKPRESSURE_LIMIT');
          queue.push(text);
        }
      } catch (error) {
        fail(error);
      }
    });
    upstream.on('message', (raw) => {
      try {
        const text = raw.toString();
        const value = envelopeSchema.parse(JSON.parse(text));
        if (!claimed && value.id !== undefined && identityRequests.has(value.id)) {
          claimed = true;
          identityRequests.delete(value.id);
          if (value.error !== undefined)
            throw new Error('CODEX_TUI_THREAD_FAILED: ' + JSON.stringify(value.error));
          const result = z.object({ thread: threadSchema }).parse(value.result);
          if (record.expectedId && result.thread.id !== record.expectedId)
            throw new Error('CODEX_THREAD_ID_MISMATCH');
          void this.identify(record, result.thread).catch(fail);
        }
        this.notification(record, value);
        if (downstream.readyState === WebSocket.OPEN) downstream.send(text);
      } catch (error) {
        fail(error);
      }
    });
    downstream.on('error', () => upstream.terminate());
    upstream.on('error', () => {
      downstream.terminate();
      if (!record.stopped) fail(new Error('CODEX_TUI_CONNECTION_FAILED'));
    });
    downstream.on('close', () => {
      record.tuiConnected = false;
      record.sockets.delete(downstream);
      upstream.close();
    });
    upstream.on('close', () => {
      record.sockets.delete(upstream);
      downstream.close();
    });
  }
  private isIdentityRequest(record: LaunchRecord, value: Envelope) {
    if (record.mode === 'resume') {
      if (value.method !== 'thread/resume') return false;
      const params = z.object({ threadId: z.string() }).safeParse(value.params);
      return params.success && params.data.threadId === record.expectedId;
    }
    if (value.method !== 'thread/start') return false;
    const params = z
      .object({
        ephemeral: z.boolean().nullable().optional(),
        threadSource: z.string().nullable().optional(),
      })
      .safeParse(value.params);
    return (
      params.success &&
      params.data.ephemeral !== true &&
      params.data.threadSource !== 'thread_title'
    );
  }
  private async identify(record: LaunchRecord, thread: Thread) {
    if (record.stopped) return;
    if (thread.ephemeral || (record.mode === 'new' && thread.parentThreadId))
      throw new Error('CODEX_TUI_NOT_ROOT_THREAD');
    if ((await canonical(thread.cwd)) !== record.cwd)
      throw new Error('CODEX_SESSION_PROJECT_MISMATCH');
    if (record.stopped) return;
    record.sessionId = thread.id;
    const pendingMcp = record.pendingMcp.get(thread.id);
    record.pendingMcp.clear();
    if (pendingMcp && pendingMcp.sequence > record.mcpObservedSequence)
      this.applyMcpStartup(record, pendingMcp);
    this.mcpMetadata(record);
    clearTimeout(record.startupTimer);
    const session = await this.session(thread, record);
    if (record.stopped) return;
    this.sessions.set(session.id, session);
    if (record.terminalId) this.options.onIdentity?.(record.terminalId, session.id);
    this.changed();
  }
  private notification(record: LaunchRecord, value: Envelope) {
    if (record.stopped) return;
    if (value.method === 'mcpServer/startupStatus/updated') {
      const params = mcpStartupSchema.safeParse(value.params);
      if (!params.success) return;
      const observation = {
        sequence: ++record.mcpSequence,
        params: params.data,
        observedAt: new Date().toISOString(),
      };
      if (params.data.threadId) {
        if (!record.sessionId) {
          record.pendingMcp.set(params.data.threadId, observation);
          if (record.pendingMcp.size > 32)
            record.pendingMcp.delete(record.pendingMcp.keys().next().value!);
          return;
        }
        if (params.data.threadId !== record.sessionId) return;
      }
      this.applyMcpStartup(record, observation);
      this.changed();
      return;
    }
    if (value.method !== 'thread/status/changed' || !record.sessionId) return;
    const params = z.object({ threadId: z.string(), status: statusSchema }).safeParse(value.params);
    if (!params.success || params.data.threadId !== record.sessionId) return;
    const session = this.sessions.get(record.sessionId);
    if (!session) return;
    session.status = state(params.data.status.type);
    this.changed();
  }
  private mcpMetadata(record: LaunchRecord) {
    const current = this.mcpStartup.get(record.id);
    if (!current) return;
    if (record.sessionId) current.sessionId = record.sessionId;
    if (record.terminalId) current.terminalId = record.terminalId;
  }
  private applyMcpStartup(record: LaunchRecord, observation: McpObservation) {
    const { params } = observation;
    record.mcpObservedSequence = observation.sequence;
    if (params.status === 'failed')
      diagnostic('codex-manager', 'mcp-startup-error', params.error ?? params.failureReason ?? 'MCP startup failed', 'error', { workerId: record.id });
    this.mcpStartup.set(record.id, {
      launchId: record.id,
      projectId: record.projectId,
      status: params.status,
      observedAt: observation.observedAt,
      ...(params.error ? { error: params.error } : {}),
      ...(params.failureReason ? { failureReason: params.failureReason } : {}),
    });
    this.mcpMetadata(record);
  }
  bindTerminal(launchId: string, terminalId: string) {
    const record = this.launches.get(launchId);
    if (!record || record.stopped) throw new Error('CODEX_LAUNCH_NOT_FOUND');
    if (record.terminalId && record.terminalId !== terminalId)
      throw new Error('CODEX_TERMINAL_ALREADY_BOUND');
    if (record.terminalId === terminalId) return;
    record.terminalId = terminalId;
    this.mcpMetadata(record);
    if (record.sessionId) {
      const session = this.sessions.get(record.sessionId);
      if (session) session.terminalId = terminalId;
      this.options.onIdentity?.(terminalId, record.sessionId);
    }
    this.changed();
  }
  async cancelLaunch(launchId: string) {
    const record = this.launches.get(launchId);
    if (record) await this.stopLaunch(record);
  }
  async resetDiscovery() {
    if (this.discoveryStarting) await this.discoveryStarting.catch(() => {});
    const client = this.discovery;
    this.discovery = null;
    this.discoveryKey = null;
    await client?.stop();
    this.compatibility = null;
    this.error = null;
    this.changed();
  }
  async terminalStopped(terminalId: string) {
    await Promise.all(
      [...this.launches.values()]
        .filter((record) => record.terminalId === terminalId)
        .map((record) => this.stopLaunch(record)),
    );
  }
  private stopLaunch(record: LaunchRecord): Promise<void> {
    if (record.cleanup) return record.cleanup;
    record.stopped = true;
    record.pendingMcp.clear();
    this.mcpStartup.set(record.id, {
      launchId: record.id,
      projectId: record.projectId,
      status: 'stopped',
      observedAt: new Date().toISOString(),
    });
    this.mcpMetadata(record);
    const stopped = [...this.mcpStartup.values()].filter((state) => state.status === 'stopped');
    for (const previous of stopped.slice(0, Math.max(0, stopped.length - 100)))
      this.mcpStartup.delete(previous.launchId);
    clearTimeout(record.startupTimer);
    const session = record.sessionId ? this.sessions.get(record.sessionId) : undefined;
    if (session) {
      session.processState = 'stopped';
      session.status = 'unknown';
    }
    for (const socket of record.sockets) socket.terminate();
    record.sockets.clear();
    record.gateway.close();
    const cleanup = Promise.all([
      new Promise<void>((done) => record.server.close(() => done())),
      terminate(record.child),
    ]).then(async () => {
      this.launches.delete(record.id);
      this.changed();
      // A new thread has no persisted rollout until its first turn. Once its
      // backend exits, refresh authoritative history instead of retaining a
      // stopped, unresumable entry in the UI. Keep workspaces independently.
      if (record.sessionId && !this.stopping) {
        await this.discover(this.projects).catch(() => {
          /* Discovery reports its own error; do not make cleanup fail. */
        });
      }
    });
    record.cleanup = cleanup;
    return cleanup;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    // Mark established launches as stopped synchronously, before concurrent
    // PTY shutdown can close their TUI/backend connections. Starting launches
    // retain their existing cancellation barrier.
    const established = [...this.launches.values()].map((record) => this.stopLaunch(record));
    this.stopPromise = (async () => {
      await Promise.allSettled([...this.startingLaunches]);
      await Promise.all(established);
      await Promise.all([...this.launches.values()].map((record) => this.stopLaunch(record)));
      if (this.discoveryStarting) await this.discoveryStarting.catch(() => {});
      await this.discovery?.stop();
      this.discovery = null;
    })();
    return this.stopPromise;
  }
}
