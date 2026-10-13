import { diagnostics } from './support/vitest-diagnostics';
import { markChildStop } from '../src/shared/test-diagnostics';
import { afterEach, expect, it } from 'vitest';
import { spawn } from './support/process';
import { type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { CodexManager } from '../src/main/codex';
import type { CodexLaunch } from '../src/shared/harness';
const managers: CodexManager[] = [];
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { markChildStop(child); child.kill('SIGTERM'); }
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(extra: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bp-codex-manager-')));
  roots.push(root);
  const project = join(root, 'project'),
    other = join(root, 'worktree');
  await Promise.all([project, other].map((path) => mkdir(path)));
  const audit = join(root, 'audit.jsonl');
  const identities: { terminalId: string; sessionId: string }[] = [];
  const errors: string[] = [];
  const manager = new CodexManager({
    getExecutable: () => resolve('tests/fixtures/codex-cli.mjs'),
    getEnvironment: () => ({
      CODEX_HOME: root,
      CODEX_FIXTURE_PROJECT: project,
      CODEX_FIXTURE_OTHER_PROJECT: other,
      CODEX_FIXTURE_AUDIT: audit,
      ...extra,
    }),
    getMcpOverrides: () => ({
      'mcp_servers.projector.command': 'bridge',
      'mcp_servers.projector.env.PROJECTOR_DESCRIPTOR': join(root, 'descriptor.json'),
    }),
    onIdentity: (terminalId, sessionId) => identities.push({ terminalId, sessionId }),
    onError: (error) => errors.push(error),
  });
  managers.push(manager);
  return { manager, root, project, other, audit, identities, errors };
}
async function auditRequests(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as { kind: string; method?: string; params?: unknown; args?: string[] },
    );
}
it.each(['0', '1'])(
  'discovers and reads Unicode JSONL previews with fragmented stdout=%s',
  async (fragmented) => {
    const preview = 'Before\u2028after line separator\u2029after paragraph separator 日本語';
    const { manager, project, audit } = await setup({
      CODEX_FIXTURE_NAME: '',
      CODEX_FIXTURE_PREVIEW: preview,
      CODEX_FIXTURE_FRAGMENT_STDIO: fragmented,
    });
    const sessions = await manager.discover([{ id: 'project', path: project }]);
    expect(sessions.find((session) => session.id === 'thread-exact-fixture')?.title).toBe(preview);
    expect((await manager.read('thread-exact-fixture')).title).toBe(preview);
    expect(manager.snapshot().error).toBeNull();
    expect(
      (await auditRequests(audit)).some(
        (request) => request.method === 'thread/start' || request.method === 'thread/resume',
      ),
    ).toBe(false);
  },
);
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 30));
  }
  throw new Error('Expected protocol observation not received');
}
async function controlGateway(launch: CodexLaunch) {
  const socket = new WebSocket(launch.args[launch.args.indexOf('--remote') + 1], {
    headers: { Authorization: `Bearer ${launch.env.PROJECTOR_CODEX_REMOTE_TOKEN}` },
  });
  await new Promise<void>((done, reject) => {
    socket.once('open', done);
    socket.once('error', reject);
  });
  let sequence = 0;
  const call = (method: string, params: unknown = {}) => {
    const id = 'mcp-test-' + ++sequence;
    return new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => {
        socket.off('message', receive);
        reject(new Error('Fixture gateway response timed out'));
      }, 3000);
      const receive = (raw: Buffer) => {
        const response = JSON.parse(raw.toString());
        if (response.id !== id) return;
        clearTimeout(timeout);
        socket.off('message', receive);
        if (response.error) reject(new Error('Fixture protocol request failed'));
        else done();
      };
      socket.on('message', receive);
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  return { socket, call, status: (params: unknown) => call('fixture/mcp-status', params) };
}
it('observes validated Projector MCP startup only from its owned upstream and exact thread', async () => {
  const { manager, project } = await setup();
  expect(manager.snapshot().mcpStartup).toEqual([]);
  const launch = await manager.launchNew('project', project);
  manager.bindTerminal(launch.launchId, 'mcp-terminal');
  const gateway = await controlGateway(launch);
  const current = () => manager.snapshot().mcpStartup[0];
  expect(current()).toMatchObject({
    launchId: launch.launchId,
    projectId: 'project',
    status: 'unknown',
  });
  expect(current().observedAt).toBeUndefined();
  await gateway.status({ name: 'other', status: 'ready', threadId: null });
  await gateway.status({ name: 'projector', status: 'connected', threadId: null });
  await gateway.status({ name: 'projector', status: 'failed', error: { message: 'invalid' } });
  gateway.socket.send(
    JSON.stringify({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'projector', status: 'ready', threadId: null },
    }),
  );
  await gateway.call('initialize');
  expect(current().status).toBe('unknown');
  await gateway.status({ name: 'projector', status: 'ready', threadId: 'unrelated-thread' });
  await gateway.status({ name: 'projector', status: 'starting', threadId: 'thread-exact-fixture' });
  expect(current().status).toBe('unknown');
  await gateway.call('thread/start', { ephemeral: false, threadSource: 'user', cwd: project });
  await until(() => current().sessionId === 'thread-exact-fixture');
  expect(current()).toMatchObject({
    status: 'starting',
    sessionId: 'thread-exact-fixture',
    terminalId: 'mcp-terminal',
  });
  expect(Number.isNaN(Date.parse(current().observedAt!))).toBe(false);
  await gateway.status({ name: 'projector', status: 'ready', threadId: null });
  expect(current().status).toBe('ready');
  await gateway.status({
    name: 'projector',
    status: 'failed',
    threadId: 'unrelated-thread',
    error: 'wrong session',
  });
  await gateway.status({ name: 'projector', status: 'failed', failureReason: 'unsupported' });
  expect(current().status).toBe('ready');
  diagnostics().expect({role:'codex-manager',kind:'mcp-startup-error',phase:'test',message:'Synthetic MCP connection failure',count:1});
  await gateway.status({
    name: 'projector',
    status: 'failed',
    threadId: 'thread-exact-fixture',
    error: 'Synthetic MCP connection failure',
    failureReason: 'reauthenticationRequired',
  });
  expect(current()).toMatchObject({
    status: 'failed',
    error: 'Synthetic MCP connection failure',
    failureReason: 'reauthenticationRequired',
  });
  await gateway.status({
    name: 'projector',
    status: 'cancelled',
    threadId: 'thread-exact-fixture',
    error: null,
    failureReason: null,
  });
  expect(current()).toMatchObject({ status: 'cancelled' });
  expect(current().error).toBeUndefined();
  expect(current().failureReason).toBeUndefined();
  await manager.terminalStopped('mcp-terminal');
  expect(current()).toMatchObject({ status: 'stopped', sessionId: 'thread-exact-fixture' });
});
it('keeps MCP startup observations separate per launch and ignores older pre-identity states', async () => {
  const { manager, project } = await setup();
  const first = await manager.launchNew('project', project);
  const second = await manager.launchNew('project', project);
  const one = await controlGateway(first),
    two = await controlGateway(second);
  const state = (id: string) =>
    manager.snapshot().mcpStartup.find((entry) => entry.launchId === id)!;
  await one.status({ name: 'projector', status: 'starting', threadId: 'thread-exact-fixture' });
  await one.status({ name: 'projector', status: 'ready', threadId: null });
  await one.call('thread/start', { ephemeral: false, threadSource: 'user', cwd: project });
  await until(() => state(first.launchId).sessionId === 'thread-exact-fixture');
  expect(state(first.launchId).status).toBe('ready');
  expect(state(second.launchId).status).toBe('unknown');
  diagnostics().expect({role:'codex-manager',kind:'mcp-startup-error',phase:'test',message:'Other owned launch failed',count:1});
  await two.status({ name: 'projector', status: 'failed', error: 'Other owned launch failed' });
  expect(state(first.launchId).status).toBe('ready');
  expect(state(second.launchId).status).toBe('failed');
  await manager.cancelLaunch(first.launchId);
  expect(state(first.launchId).status).toBe('stopped');
  expect(state(second.launchId).status).toBe('failed');
  await manager.stop();
  expect(state(second.launchId).status).toBe('stopped');
});
it('discovers all pages and providers by protocol without starting sessions; canonical checkout identity remains separate', async () => {
  const { manager, root, project, other, audit } = await setup();
  const alias = join(root, 'project-alias');
  await symlink(project, alias);
  const sessions = await manager.discover([
    { id: 'one', path: alias },
    { id: 'two', path: other },
  ]);
  expect(sessions).toEqual([
    expect.objectContaining({
      id: 'thread-exact-fixture',
      projectId: 'one',
      cwd: project,
      processState: 'unknown',
      status: 'unknown',
      rootSessionId: 'root-exact-fixture',
    }),
    expect.objectContaining({
      id: 'other-worktree',
      projectId: 'two',
      cwd: other,
      processState: 'unknown',
    }),
  ]);
  const requests = (await auditRequests(audit)).filter((value) => value.kind === 'request');
  expect(requests.map((value) => value.method)).toEqual([
    'initialize',
    'initialized',
    'thread/list',
    'thread/list',
    'thread/list',
  ]);
  expect(
    requests.filter((value) => value.method === 'thread/list').map((value) => value.params),
  ).toEqual([
    expect.objectContaining({ modelProviders: [], useStateDbOnly: true, archived: false }),
    expect.objectContaining({
      modelProviders: [],
      useStateDbOnly: true,
      archived: false,
      cursor: 'page-two',
    }),
    expect.objectContaining({ modelProviders: [], useStateDbOnly: true, archived: true }),
  ]);
  expect(
    requests.some((value) => value.method?.includes('resume') || value.method?.includes('turn')),
  ).toBe(false);
});
it('hides subagents by protocol metadata while keeping named roots, unknown sources and manual forks', async () => {
  const catalog = {
    'thread-exact-fixture': { name: 'Guardian review', source: 'cli' },
    'other-worktree': { source: 'cli', forkedFromId: 'manual-parent' },
    'archived-exact-fixture': { source: 'unknown' },
    'unknown-root': { source: 'unknown' },
    'review-child': { source: { subAgent: 'review' } },
    'compact-child': { source: { subAgent: 'compact' }, archived: true },
    'spawn-child': {
      source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } },
    },
    'other-child': { source: { subAgent: { other: 'guardian' } } },
    'memory-child': { source: { subAgent: 'memory_consolidation' } },
    'parent-child': { source: 'cli', parentThreadId: 'root' },
  };
  const { manager, project, other, audit } = await setup({
    CODEX_FIXTURE_SESSION_METADATA: JSON.stringify(catalog),
  });
  const projects = [
    { id: 'one', path: project },
    { id: 'two', path: other },
  ];
  const sessions = await manager.discover(projects);
  expect(sessions.map((session) => session.id)).toEqual([
    'thread-exact-fixture',
    'unknown-root',
    'other-worktree',
  ]);
  expect(sessions[0].title).toBe('Guardian review');
  expect(sessions.find((session) => session.id === 'other-worktree')?.projectId).toBe('two');
  for (const request of (await auditRequests(audit)).filter(
    (request) => request.method === 'thread/list',
  ))
    expect(request.params).toMatchObject({
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      useStateDbOnly: true,
      modelProviders: [],
    });
  expect(await manager.read('archived-exact-fixture')).toMatchObject({ archived: true });
  for (const id of Object.keys(catalog).filter((id) => id.endsWith('-child')))
    expect(await manager.read(id)).toMatchObject({ id, isSubAgent: true });
  expect(manager.snapshot().sessions.map((session) => session.id)).toEqual(
    sessions.map((session) => session.id),
  );
  expect(
    (await auditRequests(audit)).some(
      (request) => request.method === 'thread/start' || request.method === 'thread/resume',
    ),
  ).toBe(false);
});
it('keeps an explicitly resumed subagent process owned but hidden after discovery and direct reads', async () => {
  const { manager, project, identities } = await setup({
    CODEX_FIXTURE_SESSION_METADATA: JSON.stringify({
      'owned-child': { parentThreadId: 'root', source: { subAgent: 'review' } },
    }),
  });
  const launch = await manager.launchResume('project', project, 'owned-child');
  manager.bindTerminal(launch.launchId, 'child-terminal');
  const gateway = await controlGateway(launch);
  await gateway.call('thread/resume', { threadId: 'owned-child', cwd: project });
  await until(() => identities.length === 1);
  expect(identities).toEqual([{ terminalId: 'child-terminal', sessionId: 'owned-child' }]);
  await manager.discover([{ id: 'project', path: project }]);
  expect(await manager.read('owned-child')).toMatchObject({
    isSubAgent: true,
    processState: 'running',
    terminalId: 'child-terminal',
  });
  expect(manager.snapshot().sessions.some((session) => session.id === 'owned-child')).toBe(false);
});
it('binds new TUI by the matching root-thread response, rejecting title and unrelated broadcast identities', async () => {
  const { manager, project, audit, identities } = await setup();
  const launch = await manager.launchNew('project', project);
  expect(launch.args).not.toContain('--no-daemon');
  expect(launch.args).toContain('--remote-auth-token-env');
  expect(launch.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  manager.bindTerminal(launch.launchId, 'terminal-one');
  const tui = spawn(launch.executable, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: 'ignore',
  });
  children.push(tui);
  await until(() => identities.length === 1);
  expect(identities).toEqual([{ terminalId: 'terminal-one', sessionId: 'thread-exact-fixture' }]);
  expect(manager.snapshot().sessions).toEqual([
    expect.objectContaining({
      id: 'thread-exact-fixture',
      rootSessionId: 'root-exact-fixture',
      projectId: 'project',
      terminalId: 'terminal-one',
      processState: 'running',
      status: 'idle',
    }),
  ]);
  manager.bindTerminal(launch.launchId, 'terminal-one');
  expect(identities).toHaveLength(1);
  const calls = await auditRequests(audit);
  const backend = calls.find((value) => value.args?.includes('app-server'));
  expect(backend?.args).toContain('--ws-token-sha256');
  expect(backend?.args?.join(' ')).not.toContain(launch.env.PROJECTOR_CODEX_REMOTE_TOKEN);
  expect(backend?.args?.join(' ')).toContain('mcp_servers.projector.env.PROJECTOR_DESCRIPTOR');
  expect(backend?.args?.join(' ')).not.toMatch(/approval_policy|sandbox_mode|trust_level/);
  await manager.terminalStopped('terminal-one');
  expect(manager.snapshot().sessions[0].processState).toBe('stopped');
});
it('allows deferred terminal binding and resumes only the explicit session ID', async () => {
  const { manager, project, identities, audit } = await setup();
  await manager.discover([{ id: 'project', path: project }]);
  const launch = await manager.launchResume('project', project, 'thread-exact-fixture');
  const tui = spawn(launch.executable, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: 'ignore',
  });
  children.push(tui);
  await until(() => manager.snapshot().sessions[0]?.processState === 'running');
  expect(identities).toEqual([]);
  manager.bindTerminal(launch.launchId, 'terminal-late');
  expect(identities).toEqual([{ terminalId: 'terminal-late', sessionId: 'thread-exact-fixture' }]);
  const request = (await auditRequests(audit)).find((value) => value.method === 'thread/resume');
  expect(request?.params).toMatchObject({ threadId: 'thread-exact-fixture' });
  await expect(manager.launchResume('project', project, 'thread-exact-fixture')).rejects.toThrow(
    'CODEX_SESSION_ALREADY_RUNNING',
  );
});
it('blocks an incorrect resume response and an incorrect read response instead of binding a different session', async () => {
  const wrongResume = await setup({ CODEX_FIXTURE_WRONG_RESUME: '1' });
  await wrongResume.manager.discover([{ id: 'project', path: wrongResume.project }]);
  diagnostics().phase('wrong-resume');
  diagnostics().expect({role:'codex-manager',kind:'adapter-error',phase:'wrong-resume',message:'CODEX_THREAD_ID_MISMATCH',count:1});
  const launch = await wrongResume.manager.launchResume(
    'project',
    wrongResume.project,
    'thread-exact-fixture',
  );
  wrongResume.manager.bindTerminal(launch.launchId, 'never-bound');
  children.push(
    spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'ignore' }),
  );
  await until(() => wrongResume.errors.some((value) => value.includes('CODEX_THREAD_ID_MISMATCH')));
  expect(wrongResume.identities).toEqual([]);
  expect(
    wrongResume.manager.snapshot().sessions.some((value) => value.id === 'wrong-resume-id'),
  ).toBe(false);
  const wrongRead = await setup({ CODEX_FIXTURE_WRONG_READ: '1' });
  diagnostics().phase('wrong-read');
  diagnostics().expect({role:'codex-manager',kind:'adapter-error',phase:'wrong-read',message:'CODEX_THREAD_ID_MISMATCH',count:1});
  await expect(wrongRead.manager.read('thread-exact-fixture')).rejects.toThrow(
    'CODEX_THREAD_ID_MISMATCH',
  );
});
it('rejects unauthenticated or browser-origin access to the TUI control gateway', async () => {
  const { manager, project, identities } = await setup();
  const launch = await manager.launchNew('project', project);
  const url = launch.args[launch.args.indexOf('--remote') + 1];
  for (const headers of [
    {},
    {
      Authorization: `Bearer ${launch.env.PROJECTOR_CODEX_REMOTE_TOKEN}`,
      Origin: 'https://external.test',
    },
  ]) {
    const socket = new WebSocket(url, { headers });
    const error = await new Promise<Error>((done) => socket.once('error', done));
    expect(error.message).toContain('403');
    socket.terminate();
  }
  expect(identities).toEqual([]);
});
it('does not launch an unsupported version or accept an override of user policy', async () => {
  const { manager, project, audit } = await setup({ CODEX_FIXTURE_VERSION: '0.999.0' });
  diagnostics().expect({role:'codex-manager',kind:'adapter-error',phase:'test',message:'CODEX_VERSION_UNQUALIFIED: 0.999.0; qualified 0.162.1',count:1});
  await expect(manager.launchNew('project', project)).rejects.toThrow('CODEX_VERSION_UNQUALIFIED');
  expect((await auditRequests(audit)).every((value) => !value.args?.includes('app-server'))).toBe(
    true,
  );
  expect(manager.snapshot().compatibility).toMatchObject({ version: '0.999.0', qualified: false });
  const restricted = new CodexManager({
    getExecutable: () => resolve('tests/fixtures/codex-cli.mjs'),
    getMcpOverrides: () => ({ approval_policy: 'never' }),
  });
  managers.push(restricted);
  await expect(restricted.launchNew('project', project)).rejects.toThrow(
    'CODEX_OVERRIDE_NOT_PROJECTOR_MCP',
  );
});

it('stops only owned POSIX backend groups and shares an idempotent shutdown drain', async () => {
  const { manager, root, project } = await setup();
  const descendantAudit = join(root, 'descendants');
  // Supply one immutable launch environment before the manager is used.
  const grouped = new CodexManager({
    getExecutable: () => resolve('tests/fixtures/codex-cli.mjs'),
    getEnvironment: () => ({
      CODEX_HOME: root,
      CODEX_FIXTURE_PROJECT: project,
      CODEX_FIXTURE_DESCENDANT_AUDIT: descendantAudit,
    }),
    getMcpOverrides: () => ({}),
  });
  managers.push(grouped);
  await manager.stop();
  await grouped.launchNew('project', project);
  const workerPid = Number((await readFile(descendantAudit, 'utf8')).trim());
  expect(Number.isInteger(workerPid)).toBe(true);
  process.kill(workerPid, 0);
  const first = grouped.stop();
  expect(grouped.stop()).toBe(first);
  await first;
  if (process.platform !== 'win32')
    await until(() => {
      try {
        process.kill(workerPid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    });
  await expect(grouped.launchNew('project', project)).rejects.toThrow('CODEX_MANAGER_STOPPED');
});

it('cancels only a failed launch and resets discovery without stopping another bound session', async () => {
  const { manager, project, identities, audit } = await setup();
  await manager.discover([{ id: 'project', path: project }]);
  const active = await manager.launchNew('project', project);
  manager.bindTerminal(active.launchId, 'terminal-active');
  children.push(
    spawn(active.executable, active.args, { cwd: active.cwd, env: active.env, stdio: 'ignore' }),
  );
  await until(() => identities.length === 1);
  const failedLaunch = await manager.launchNew('project', project);
  await manager.cancelLaunch(failedLaunch.launchId);
  await manager.cancelLaunch(failedLaunch.launchId);
  await manager.resetDiscovery();
  expect(manager.snapshot().sessions[0]).toMatchObject({
    processState: 'running',
    terminalId: 'terminal-active',
  });
  await manager.discover([{ id: 'project', path: project }]);
  expect(manager.snapshot().sessions[0]).toMatchObject({ processState: 'running', status: 'idle' });
  const discoveryStarts = (await auditRequests(audit)).filter(
    (value) => value.kind === 'spawn' && value.args?.includes('stdio://'),
  );
  expect(discoveryStarts).toHaveLength(2);
});

it('resumes a known fork by its exact thread ID rather than its session-tree root', async () => {
  const { manager, project, identities } = await setup({
    CODEX_FIXTURE_SESSION_METADATA: JSON.stringify({
      'fork-exact-id': { forkedFromId: 'parent-thread', source: 'cli' },
    }),
  });
  const launch = await manager.launchResume('project', project, 'fork-exact-id');
  manager.bindTerminal(launch.launchId, 'fork-terminal');
  children.push(
    spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'ignore' }),
  );
  await until(() => identities.length === 1);
  expect(identities).toEqual([{ terminalId: 'fork-terminal', sessionId: 'fork-exact-id' }]);
  expect(manager.snapshot().sessions).toEqual([
    expect.objectContaining({
      id: 'fork-exact-id',
      rootSessionId: 'root-exact-fixture',
      processState: 'running',
    }),
  ]);
});

it('drains a backend still starting when Quit begins and never hands out a live launch afterward', async () => {
  const { manager, project, audit } = await setup({ CODEX_FIXTURE_BACKEND_DELAY: '250' });
  diagnostics().expect({role:'codex-manager',kind:'adapter-error',phase:'test',message:'CODEX_MANAGER_STOPPED',count:1});
  const outcome = manager.launchNew('project', project).then(
    () => 'unexpected-live-launch',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  let starting = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const requests = await auditRequests(audit).catch(() => []);
    if (requests.some((value) => value.kind === 'spawn' && value.args?.includes('app-server'))) {
      starting = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  expect(starting).toBe(true);
  await manager.stop();
  expect(await outcome).toBe('CODEX_MANAGER_STOPPED');
  expect(manager.snapshot().sessions).toEqual([]);
});
it('finishes read-only discovery crossing Quit without starting a client or reporting a failure', async () => {
  const { manager, project, audit, errors } = await setup();
  const discovery = manager.discover([{ id: 'project', path: project }]);
  await manager.stop();
  await expect(discovery).resolves.toEqual([]);
  expect(errors).toEqual([]);
  expect((await auditRequests(audit).catch(() => [])).some(request => request.kind === 'spawn')).toBe(false);
});
it('cancels an admitted history read with the explicit shutdown cause while retaining its catalog', async () => {
  const environment: Record<string, string> = {};
  const { manager, root, project, errors } = await setup(environment);
  const gate = join(root, 'quit-list-gate');
  environment.CODEX_FIXTURE_LIST_GATE = gate;
  const discovery = manager.discover([{ id:'project', path:project }]);
  await expect.poll(() => readFile(gate + '.waiting', 'utf8').catch(() => '')).toBe('waiting');
  await manager.stop();
  await expect(discovery).resolves.toEqual([]);
  expect(errors).toEqual([]);
});
it('archives and undoes the exact thread without resuming it or losing its workspace identity', async () => {
  const { manager, project, audit } = await setup();
  await manager.discover([{ id: 'project', path: project }]);
  await manager.setArchived('thread-exact-fixture', true);
  expect(manager.snapshot().sessions.some((session) => session.id === 'thread-exact-fixture')).toBe(
    false,
  );
  await manager.discover([{ id: 'project', path: project }]);
  expect(manager.snapshot().sessions.some((session) => session.id === 'thread-exact-fixture')).toBe(
    false,
  );
  await manager.setArchived('thread-exact-fixture', false);
  expect(manager.snapshot().sessions).toContainEqual(
    expect.objectContaining({ id: 'thread-exact-fixture', projectId: 'project' }),
  );
  const calls = await auditRequests(audit);
  expect(
    calls
      .filter((call) => call.method === 'thread/archive' || call.method === 'thread/unarchive')
      .map((call) => call.params),
  ).toEqual([{ threadId: 'thread-exact-fixture' }, { threadId: 'thread-exact-fixture' }]);
  expect(
    calls.some((call) => call.method === 'thread/start' || call.method === 'thread/resume'),
  ).toBe(false);
});
it.each(['before', 'after'])(
  'reconciles archive failure %s without repeating the mutation',
  async (failure) => {
    const { manager, project, audit } = await setup({ CODEX_FIXTURE_ARCHIVE_FAILURE: failure });
    await manager.discover([{ id: 'project', path: project }]);
    if (failure === 'before') diagnostics().expect({role:'codex-manager',kind:'adapter-error',phase:'test',message:'CODEX_RPC_FAILED: {"code":-32603,"message":"Archive refused"}',count:1});
    const operation = manager.setArchived('thread-exact-fixture', true);
    if (failure === 'before') {
      await expect(operation).rejects.toThrow('CODEX_RPC_FAILED');
      expect(
        manager.snapshot().sessions.some((session) => session.id === 'thread-exact-fixture'),
      ).toBe(true);
    } else {
      await expect(operation).resolves.toEqual({
        status: 'completed',
        sessionId: 'thread-exact-fixture',
        archived: true,
      });
      expect(
        manager.snapshot().sessions.some((session) => session.id === 'thread-exact-fixture'),
      ).toBe(false);
    }
    expect(
      (await auditRequests(audit)).filter((call) => call.method === 'thread/archive'),
    ).toHaveLength(1);
  },
);
it('rejects an undo response for another thread', async () => {
  const { manager, project } = await setup({ CODEX_FIXTURE_WRONG_UNARCHIVE: '1' });
  await manager.discover([{ id: 'project', path: project }]);
  await manager.setArchived('thread-exact-fixture', true);
  diagnostics().expect({role:'codex-manager',kind:'adapter-error',phase:'test',message:'CODEX_THREAD_ID_MISMATCH',count:1});
  await expect(manager.setArchived('thread-exact-fixture', false)).rejects.toThrow(
    'CODEX_THREAD_ID_MISMATCH',
  );
});

it('reports an active writer as a session conflict without starting or resuming a process', async () => {
  const { manager, project, audit } = await setup({ CODEX_FIXTURE_ACTIVE_WRITER: 'thread-exact-fixture' });
  await manager.discover([{ id: 'project', path: project }]);
  diagnostics().expect({role:'codex-manager',kind:'adapter-error',phase:'test',message:'CODEX_SESSION_IN_USE: This session is already in use by another Codex process. Return to the existing launch, or retry after it releases the session. Projector will not take it over.',count:1});
  await expect(manager.launchResume('project', project, 'thread-exact-fixture')).rejects.toThrow('CODEX_SESSION_IN_USE: This session is already in use by another Codex process.');
  expect(manager.snapshot().sessions.find(session => session.id === 'thread-exact-fixture')?.processState).toBe('unknown');
  expect(manager.snapshot().mcpStartup).toHaveLength(0);
  expect((await auditRequests(audit)).some(request => request.method === 'thread/start' || request.method === 'thread/resume')).toBe(false);
  // The refused read must not poison the connection or block unrelated sessions.
  await expect(manager.read('other-thread')).resolves.toMatchObject({ id: 'other-thread' });
});

it('retains exact live ownership when discovery finishes after Resume identification', async () => {
  const environment: Record<string, string> = {};
  const { manager, root, project } = await setup(environment);
  const gate = join(root, 'list-gate');
  environment.CODEX_FIXTURE_LIST_GATE = gate;
  const discovery = manager.discover([{ id: 'project', path: project }]);
  await expect.poll(() => readFile(gate + '.waiting', 'utf8').catch(() => '')).toBe('waiting');
  const launch = await manager.launchResume('project', project, 'thread-exact-fixture');
  manager.bindTerminal(launch.launchId, 'race-terminal');
  children.push(
    spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'ignore' }),
  );
  const current = () =>
    manager.snapshot().sessions.find((session) => session.id === 'thread-exact-fixture');
  await until(() => current()?.processState === 'running');
  await writeFile(gate, 'release');
  await discovery;
  expect(current()).toMatchObject({
    processState: 'running',
    status: 'idle',
    launchId: launch.launchId,
    terminalId: 'race-terminal',
  });
  await manager.discover([{ id: 'project', path: project }]);
  expect(current()).toMatchObject({
    processState: 'running',
    launchId: launch.launchId,
    terminalId: 'race-terminal',
  });
  await expect(manager.launchResume('project', project, 'thread-exact-fixture')).rejects.toThrow(
    'CODEX_SESSION_ALREADY_RUNNING',
  );
});

it('removes an unstarted session after its backend closes', async () => {
  const { manager, project, identities } = await setup({ CODEX_FIXTURE_EMPTY: '1' });
  await manager.discover([{ id: 'project', path: project }]);
  const launch = await manager.launchNew('project', project);
  manager.bindTerminal(launch.launchId, 'unstarted-terminal');
  children.push(spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'ignore' }));
  await until(() => identities.length === 1);
  expect(manager.snapshot().sessions).toHaveLength(1);
  await manager.terminalStopped('unstarted-terminal');
  expect(manager.snapshot().sessions).toEqual([]);
});

it('reconciles an unavailable empty session without hiding failures for persisted threads', async () => {
  const empty = await setup({ CODEX_FIXTURE_EMPTY: '1', CODEX_FIXTURE_UNLOADED: 'thread-exact-fixture' });
  await expect(empty.manager.read('thread-exact-fixture')).rejects.toThrow('CODEX_SESSION_UNAVAILABLE');
  expect(empty.manager.snapshot().error).toBeNull();
  const persisted = await setup({ CODEX_FIXTURE_UNLOADED: 'thread-exact-fixture' });
  diagnostics().expect({role:'codex-manager',kind:'adapter-error',phase:'test',message:'CODEX_RPC_FAILED: {"code":-32600,"message":"thread not loaded: thread-exact-fixture"}',count:1});
  await expect(persisted.manager.read('thread-exact-fixture')).rejects.toThrow('thread not loaded');
  expect(persisted.manager.snapshot().sessions.some(session => session.id === 'thread-exact-fixture')).toBe(true);
});

it('returns an ordinary blocked Archive result for an active writer without poisoning metadata or mutating the thread', async () => {
  const { manager, project, audit } = await setup({ CODEX_FIXTURE_ACTIVE_WRITER: 'thread-exact-fixture' });
  await manager.discover([{ id: 'project', path: project }]);
  await expect(manager.setArchived('thread-exact-fixture', true)).resolves.toEqual({
    status: 'blocked', reason: 'session-in-use', sessionId: 'thread-exact-fixture',
  });
  expect(manager.snapshot().error).toBeNull();
  expect(manager.snapshot().sessions.some(session => session.id === 'thread-exact-fixture')).toBe(true);
  expect((await auditRequests(audit)).some(request => ['thread/archive', 'thread/start', 'thread/resume'].includes(request.method ?? ''))).toBe(false);
});

it('returns a normal warning if a writer appears between Archive validation and mutation', async () => {
  const { manager, project, audit } = await setup({ CODEX_FIXTURE_ARCHIVE_FAILURE: 'busy' });
  await manager.discover([{ id: 'project', path: project }]);
  await expect(manager.setArchived('thread-exact-fixture', true)).resolves.toEqual({
    status: 'blocked', reason: 'session-in-use', sessionId: 'thread-exact-fixture',
  });
  expect(manager.snapshot().error).toBeNull();
  expect(manager.snapshot().sessions.some(session => session.id === 'thread-exact-fixture')).toBe(true);
  expect((await auditRequests(audit)).filter(request => request.method === 'thread/archive')).toHaveLength(1);
});
