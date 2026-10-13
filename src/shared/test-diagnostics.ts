import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { format, stripVTControlCharacters } from 'node:util';
import type { ChildProcess } from 'node:child_process';
import { threadId } from 'node:worker_threads';
import { StringDecoder } from 'node:string_decoder';

const errorSources = new WeakMap<object, string>();
export function bindDiagnosticError(error: unknown, id?: string): void {
  if (id && error !== null && typeof error === 'object') errorSources.set(error, id);
}
export function errorDiagnosticId(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' ? errorSources.get(error) : undefined;
}

let installed = false;
let processRole = 'process';
const stoppingChildren = new WeakSet<ChildProcess>();
const observedChildren = new WeakSet<ChildProcess>();
const liveChildren = new Map<ChildProcess, string>();
export async function drainDiagnosticChildren(timeoutMs = 5000): Promise<void> {
  const path = process.env.PROJECTOR_TEST_DIAGNOSTICS;
  const deadline = Date.now() + timeoutMs;
  while ([...liveChildren.values()].includes(path ?? '')) {
    if (Date.now() >= deadline) throw new Error('Diagnostic children remain alive after cleanup');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export function markChildStop(child: ChildProcess): void {
  if (child.pid && child.exitCode === null && child.signalCode === null) stoppingChildren.add(child);
}
export function redactDiagnostic(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let text = value
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
  for (const [key, secret] of Object.entries(environment))
    if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i.test(key) && secret && secret.length >= 8)
      text = text.split(secret).join('[REDACTED]');
  return text;
}
export function diagnostic(
  role: string,
  kind: string,
  message: string,
  level: 'error' | 'warning' | 'info' = 'error',
  extra: {
    pid?: number;
    workerId?: number | string;
    external?: boolean;
    stack?: string;
    context?: NodeJS.ProcessEnv;
    forwardedFrom?: string;
  } = {},
): string | undefined {
  const context = extra.context ?? process.env;
  const path = context.PROJECTOR_TEST_DIAGNOSTICS;
  if (!path) return;
  const testId = context.PROJECTOR_TEST_ID,
    runId = context.PROJECTOR_TEST_RUN_ID;
  if (!testId || !runId) throw new Error('Diagnostic context is incomplete');
  const phase = readFileSync(path + '.phase', 'utf8');
  const event = {
    version: 1,
    id: randomUUID(),
    runId,
    testId,
    role,
    pid: extra.pid ?? process.pid,
    workerId: extra.workerId ?? threadId,
    phase,
    kind,
    message: redactDiagnostic(message, context),
    level,
    ...(extra.external ? { external: true } : {}),
    ...(extra.stack ? { stack: redactDiagnostic(extra.stack, context) } : {}),
    ...(extra.forwardedFrom ? { forwardedFrom: extra.forwardedFrom } : {}),
  };
  appendFileSync(path, JSON.stringify(event) + '\n');
  return event.id;
}
export function installProcessDiagnostics(role: string): void {
  if (!process.env.PROJECTOR_TEST_DIAGNOSTICS || installed) return;
  installed = true;
  processRole = role;
  diagnostic(role, 'process-start', 'Diagnostic observer ready', 'info');
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const forwardedFrom = args.map(errorDiagnosticId).find(Boolean);
    diagnostic(role, 'console-error', format(...args), forwardedFrom ? 'info' : 'error', { forwardedFrom });
    original(redactDiagnostic(format(...args)));
  };
  process.on('uncaughtExceptionMonitor', (error, origin) =>
    diagnostic(role, 'uncaught-exception', error.message, 'error', {
      stack: error.stack ? origin + '\n' + error.stack : origin,
    }),
  );
  // No unhandledRejection listener: Node's native termination policy remains intact.
}
/** Link the parent worker notification to an already recorded worker exception. */
export function observeWorkerError(role: string, workerId: number, error: Error): void {
  const path = process.env.PROJECTOR_TEST_DIAGNOSTICS;
  const primary = path
    ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
        id: string; pid: number; workerId?: number | string; role: string; kind: string; message: string;
      }).find(event => event.pid === process.pid && event.workerId === workerId &&
        event.role === role && event.kind === 'uncaught-exception' &&
        event.message === redactDiagnostic(error.message))
    : undefined;
  diagnostic(role, 'worker-error', error.message, primary ? 'info' : 'error', {
    workerId, stack: error.stack, forwardedFrom: primary?.id,
  });
}

function forwardedPrimary(
  message: string,
  pid: number | undefined,
  context: NodeJS.ProcessEnv,
  consumed: Set<string>,
  workerId?: number | string,
) {
  const events = readFileSync(context.PROJECTOR_TEST_DIAGNOSTICS!, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(
      (value) =>
        JSON.parse(value) as {
          id: string;
          pid: number;
          workerId?: number | string;
          message: string;
          kind: string;
          stack?: string;
          forwardedFrom?: string;
        },
    );
  const scrubbed = redactDiagnostic(stripVTControlCharacters(message).trim(), context);
  let fragment: string | undefined;
  const primary = events.find((value) => {
    if (value.pid !== pid || (workerId !== undefined && value.workerId !== workerId) ||
      !['console-error', 'uncaught-exception'].includes(value.kind))
      return false;
    const index = (value.message + '\n' + (value.stack ?? ''))
      .split('\n')
      .findIndex(
        (line, index) =>
          stripVTControlCharacters(line).trim() === scrubbed &&
          !consumed.has(value.id + ':' + index),
      );
    if (index < 0) return false;
    fragment = value.id + ':' + index;
    return true;
  });
  if (fragment) consumed.add(fragment);
  return primary?.forwardedFrom ? { ...primary, id: primary.forwardedFrom } : primary;
}
/** Electron utility streams are registered immediately after fork, before readiness. */
export function observeDiagnosticStream(
  stream: NodeJS.ReadableStream | null,
  role: string,
  pid: () => number | undefined,
  kind: 'stdout' | 'stderr',
  workerId?: number | string,
): void {
  if (!stream) return;
  if (!process.env.PROJECTOR_TEST_DIAGNOSTICS) {
    stream.on('data', (chunk) =>
      (kind === 'stderr' ? process.stderr : process.stdout).write(chunk),
    );
    return;
  }
  const context = { ...process.env };
  const consumed = new Set<string>();
  let pending = '';
  const emit = (message: string) => {
    if (!message.trim()) return;
    const primary =
      kind === 'stderr' ? forwardedPrimary(message, pid(), context, consumed, workerId) : undefined;
    diagnostic(
      role,
      primary ? 'forwarded-stderr' : kind,
      message,
      primary ? 'info' : 'error',
      { context, pid: pid(), workerId, forwardedFrom: primary?.id },
    );
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      emit(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  });
  stream.once('end', () => {
    if (pending) emit(pending);
    pending = '';
  });
}
export function nativeDiagnosticOrigin(role: string, pid: number | undefined, message: string) {
  if (role !== 'main') return { role, pid };
  const prefix = /^\[(\d+):[0-9/:.]+:(?:INFO|WARNING|ERROR|FATAL):([^\]]+)\]/.exec(message);
  if (!prefix) return { role, pid };
  const sourcePid = Number(prefix[1]);
  if (!Number.isSafeInteger(sourcePid) || sourcePid <= 0) return { role, pid };
  const sourceRole = /^(?:gpu\/|components\/viz\/)/.test(prefix[2])
    ? 'electron-gpu' : sourcePid === pid ? role : 'chromium-child';
  return { role: sourceRole, pid: sourcePid };
}

export function observeChild(
  child: ChildProcess,
  role: string,
  environment: NodeJS.ProcessEnv = process.env,
): ChildProcess {
  if (observedChildren.has(child)) return child;
  observedChildren.add(child);
  if (!process.env.PROJECTOR_TEST_DIAGNOSTICS) {
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    return child;
  }
  const context = {
    ...environment,
    PROJECTOR_TEST_DIAGNOSTICS: process.env.PROJECTOR_TEST_DIAGNOSTICS,
    PROJECTOR_TEST_ID: process.env.PROJECTOR_TEST_ID,
    PROJECTOR_TEST_RUN_ID: process.env.PROJECTOR_TEST_RUN_ID,
  };
  const record = (
    kind: string,
    message: string,
    level: 'info' | 'error' | 'warning' = 'error',
    extra: { pid?: number; stack?: string; forwardedFrom?: string } = {},
  ) => {
    const origin = extra.forwardedFrom ? { role, pid: extra.pid } : nativeDiagnosticOrigin(role, extra.pid, message);
    diagnostic(origin.role, kind, message, level, { ...extra, pid: origin.pid, context });
  };
  liveChildren.set(child, context.PROJECTOR_TEST_DIAGNOSTICS);
  record('child-start', 'Child process registered', 'info', { pid: child.pid });
  let negativeGitProbe = false;
  const argv = child.spawnargs;
  const worktreeProbe =
    /(?:^|\/)git$/.test(child.spawnfile) &&
    argv.length === 7 &&
    argv[1] === '-C' &&
    argv.slice(3).join(' ') === 'rev-parse --path-format=absolute --git-dir --git-common-dir';
  child.once('error', (error) =>
    record('launch-error', error.message, 'error', { pid: child.pid, stack: error.stack }),
  );
  let pending = '';
  const forwardedLines = new Set<string>();
  const line = (message: string) => {
    if (!message.trim()) return;
    const plain = stripVTControlCharacters(message).trim();
    const primary = forwardedPrimary(message, child.pid, context, forwardedLines);
    const forwarded = Boolean(primary);
    const gitProbeNotice = worktreeProbe &&
      (plain === 'fatal: not a git repository (or any of the parent directories): .git' ||
        plain === `fatal: cannot change to '${argv[2]}': No such file or directory`);
    if (gitProbeNotice) negativeGitProbe = true;
    const inspector =
      role === 'main' &&
      (/^Debugger (listening|ending) on ws:\/\/127\.0\.0\.1:\d+\/[\w-]+$/.test(plain) ||
        plain === 'Debugger attached.' ||
        plain === 'Waiting for the debugger to disconnect...' ||
        plain === 'For help, see: https://nodejs.org/learn/getting-started/debugging');
    const codexNotice =
      ['codex', 'codex-cli'].includes(role) &&
      (plain === 'Reading additional input from stdin...' ||
        plain === 'codex app-server (WebSockets)' ||
        /^listening on: ws:\/\/127\.0\.0\.1:\d+$/.test(plain) ||
        /^(readyz|healthz): http:\/\/127\.0\.0\.1:\d+\/(readyz|healthz)$/.test(plain) ||
        plain === 'note: binds localhost only (use SSH port-forwarding for remote access)' ||
        /^mcp: [a-zA-Z0-9_-]+ (starting|ready)$/.test(plain));
    const resourceNotice =
      /^sandbox_extension_issue_file failed for (\/.*\/node_modules\/\.pnpm\/electron@44\.7\.0\/node_modules\/electron\/dist\/Electron\.app\/Contents\/Frameworks\/Electron Helper\.app\/Contents\/Resources): 1 \(Operation not permitted\)$/.exec(
        plain,
      );
    const platformNotice = role === 'main' && resourceNotice && !existsSync(resourceNotice[1]);
    record(
      forwarded
        ? 'forwarded-stderr'
        : inspector
          ? 'inspector'
          : codexNotice
            ? 'protocol-notice'
            : platformNotice
              ? 'platform-notice'
              : gitProbeNotice
                ? 'git-probe-result'
                : 'stderr',
      message,
      forwarded || inspector || codexNotice || platformNotice || gitProbeNotice
        ? 'info'
        : 'error',
      { pid: child.pid, forwardedFrom: primary?.id },
    );
  };
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  child.stdout?.on('data', (chunk: Buffer | string) =>
    record('stdout', typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk), 'info', { pid: child.pid }),
  );
  // Decode a separate diagnostic copy. Changing the stream encoding would
  // corrupt native execFile({encoding:'buffer'}) results and binary consumers.
  child.stderr?.on('data', (chunk: Buffer | string) => {
    pending += typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk);
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      line(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  });
  child.once('close', (code, signal) => {
    liveChildren.delete(child);
    const stdoutTail = stdoutDecoder.end();
    if (stdoutTail) record('stdout', stdoutTail, 'info', {pid:child.pid});
    pending += stderrDecoder.end();
    if (pending) line(pending);
    record(
      'process-exit',
      `code=${code} signal=${signal}`,
      (stoppingChildren.has(child) && code === null && (signal === 'SIGTERM' || signal === 'SIGKILL')) ||
      code === 0 || (negativeGitProbe && code === 128)
        ? 'info'
        : 'error',
      { pid: child.pid },
    );
  });
  return child;
}
export function currentDiagnosticRole(): string {
  return processRole;
}
