import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// The local provider supplies a final response, but never constructs the request.
// This observes the real client's model boundary, independently of MCP initialize
// and independently of whether a model follows the delivered instructions.
test('Codex delivers Blueprint server instructions to its model request without credentials', async () => {
  const testInfo = test.info();
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'bp-instructions-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const socket = join(root, 's.sock');
  await mkdir(project);
  await mkdir(home);
  const environment = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: home,
    TMPDIR: root,
    LANG: 'en_US.UTF-8',
  };
  const version = spawnSync('codex', ['--version'], { env: environment, encoding: 'utf8' });
  expect(version.status, version.stderr).toBe(0);
  await testInfo.attach('codex-version', {
    body: Buffer.from(version.stdout),
    contentType: 'text/plain',
  });
  const requests: unknown[] = [];
  let authorizationPresent = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404).end();
      return;
    }
    authorizationPresent ||= request.headers.authorization !== undefined;
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const message = {
      type: 'message',
      id: 'msg_local',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Local delivery probe complete.', annotations: [] }],
    };
    const result = {
      id: 'resp_local',
      object: 'response',
      status: 'completed',
      output: [message],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...message, status: 'in_progress', content: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: message.content[0].text,
      },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response: result },
    ])
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local provider address');
  let app: ElectronApplication | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    app = await electron.launch({
      args: [resolve('.')],
      env: { ...process.env, BLUEPRINT_DATA: join(root, 'data'), BLUEPRINT_RUNTIME_DESCRIPTOR: socket },
    });
    await app.firstWindow();
    const overrides = {
      model_provider: 'blueprint_delivery_probe',
      model: 'gpt-5.4',
      'model_providers.blueprint_delivery_probe.name': 'Local delivery probe',
      'model_providers.blueprint_delivery_probe.base_url': `http://127.0.0.1:${address.port}/v1`,
      'model_providers.blueprint_delivery_probe.wire_api': 'responses',
      'model_providers.blueprint_delivery_probe.requires_openai_auth': false,
      'model_providers.blueprint_delivery_probe.request_max_retries': 0,
      'model_providers.blueprint_delivery_probe.stream_max_retries': 0,
      'model_providers.blueprint_delivery_probe.stream_idle_timeout_ms': 10000,
      'mcp_servers.blueprint.command': process.execPath,
      'mcp_servers.blueprint.args': [resolve('out/bridge.cjs')],
      'mcp_servers.blueprint.env.BLUEPRINT_RUNTIME_DESCRIPTOR': socket,
    };
    child = spawn(
      'codex',
      [
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--json',
        '-C',
        project,
        ...Object.entries(overrides).flatMap(([key, value]) => [
          '-c',
          `${key}=${JSON.stringify(value)}`,
        ]),
        'Return a short acknowledgement. Do not call tools or change any files.',
      ],
      {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '',
      errors = '';
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
      errors += String(chunk);
    });
    const exit = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => {
        child?.kill('SIGTERM');
        reject(new Error('Local Codex request timed out: ' + errors));
      }, 30000);
      child!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child!.once('exit', (code) => {
        clearTimeout(timer);
        done(code);
      });
    });
    await testInfo.attach('codex-delivery-diagnostics', {
      body: Buffer.from(errors),
      contentType: 'text/plain',
    });
    expect(exit, errors).toBe(0);
    expect(output).toContain('Local delivery probe complete.');
    expect(requests).toHaveLength(1);
    expect(authorizationPresent).toBe(false);
    const delivered = JSON.stringify(requests[0]);
    expect(delivered, 'MCP server instructions must reach the actual model request').toContain(
      'Blueprint supports visual planning and agreement through MDX plans, widgets and annotations.',
    );
    expect(delivered).toContain(
      'Draft feedback is private until Save; approval does not authorize implementation.',
    );
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
