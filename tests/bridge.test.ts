import { markChildStop } from '../src/shared/test-diagnostics';
import { diagnostics } from './support/vitest-diagnostics';
import { createServer, type Server as HttpServer } from 'node:http';
import { spawn } from './support/process';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../src/guide';

let directory: string;
let child: ChildProcessWithoutNullStreams | undefined;
let runtime: HttpServer | undefined;
let closeHandler: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    markChildStop(child);
    child.kill();
    await exited;
  }
  child = undefined;
  await closeHandler?.();
  closeHandler = undefined;
  if (runtime) {
    runtime.closeAllConnections();
    await new Promise<void>((resolve) => runtime!.close(() => resolve()));
    runtime = undefined;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function bridgePath(): Promise<string> {
  await mkdir('.tmp', { recursive: true });
  directory = await mkdtemp(join(process.cwd(), '.tmp', 'bridge-test-'));
  const outfile = join(directory, 'bridge.cjs');
  await build({
    entryPoints: ['src/bridge-entry.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  return outfile;
}

async function endpoint(
  options: {
    stale?: boolean;
    disconnect?: boolean;
    incompleteStream?: boolean;
    legacy?: boolean;
  } = {},
) {
  const instanceId = randomUUID();
  const token = randomUUID();
  const toolCalls: string[] = [];
  let mcpRequests = 0;
  const handler = createMcpHandler(
    () => {
      const server = new Server(
        { name: 'projector', version: '0.1.0-alpha.1' },
        { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
      );
      server.setRequestHandler('tools/list', async () => ({
        tools: [
          {
            name: options.legacy ? 'get_blueprint_guide' : 'get_projector_guide',
            description: 'Get bundled guide',
            inputSchema: { type: 'object' },
          },
        ],
      }));
      server.setRequestHandler('tools/call', async (request) => {
        toolCalls.push(request.params.name);
        if (options.disconnect) {
          runtime!.closeAllConnections();
          return new Promise<never>(() => {});
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ topic: 'overview', content: 'Local bundled content' }),
            },
          ],
        };
      });
      return server;
    },
    { legacy: 'stateless' },
  );
  closeHandler = () => handler.close();
  const nodeHandler = toNodeHandler(handler);
  runtime = createServer((request, response) => {
    if (
      request.headers.authorization !== `Bearer ${token}` ||
      request.headers['x-projector-instance'] !== instanceId
    ) {
      response.writeHead(403).end();
      return;
    }
    if (options.legacy && request.headers['x-blueprint-instance'] !== instanceId) {
      response.writeHead(409).end();
      return;
    }
    if (request.url === '/runtime') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          protocolVersion: 1,
          instanceId: options.stale ? randomUUID() : instanceId,
          version: '0.1.0-alpha.1',
        }),
      );
      return;
    }
    mcpRequests++;
    if (options.incompleteStream && request.method === 'POST') {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          method: string;
          params?: { name: string };
        };
        if (body.method === 'tools/call') {
          toolCalls.push(body.params!.name);
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end(': work committed, but its response was lost\n\n');
        } else await nodeHandler(request, response, body);
      })();
    } else void nodeHandler(request, response);
  });
  runtime.listen(0, '127.0.0.1');
  await once(runtime, 'listening');
  const address = runtime.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  const descriptorPath = join(directory, 'endpoint.json');
  const descriptor = {
    protocolVersion: 1,
    instanceId,
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
  };
  await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  return { descriptorPath, descriptor, toolCalls, mcpRequests: () => mcpRequests };
}

function launch(outfile: string, descriptorPath: string, legacy = false) {
  child = spawn(process.execPath, [outfile], {
    env: {
      ...process.env,
      HOME: directory,
      PROJECTOR_SOCKET: undefined,
      PROJECTOR_RUNTIME_DESCRIPTOR: legacy ? undefined : descriptorPath,
      BLUEPRINT_RUNTIME_DESCRIPTOR: legacy ? descriptorPath : undefined,
      BLUEPRINT_SOCKET: undefined,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  const pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line) as { id: number } & Record<string, unknown>;
    pending.get(response.id)?.resolve(response);
    pending.delete(response.id);
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values())
      waiter.reject(new Error(`Bridge exited ${code}: ${stderr}`));
    pending.clear();
  });
  const call = (id: number, method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const initialize = async () => {
    const response = await call(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'alpha-test', version: '1' },
    });
    child!.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    return response;
  };
  return { call, initialize, stderr: () => stderr, stdout: () => stdout };
}

describe('MCP stdio bridge over HTTP', () => {
  it('keeps legacy-runtime advertised names callable through the renamed stdio bridge', async () => {
    const outfile = await bridgePath();
    const peer = await endpoint({ legacy: true });
    const io = launch(outfile, peer.descriptorPath, true);
    await io.initialize();
    expect((await io.call(2, 'tools/list', {})).result).toMatchObject({
      tools: [{ name: 'get_blueprint_guide' }],
    });
    const response = await io.call(3, 'tools/call', { name: 'get_blueprint_guide', arguments: {} });
    expect(response.result).toMatchObject({
      content: [{ text: JSON.stringify({ topic: 'overview', content: 'Local bundled content' }) }],
    });
    expect(peer.toolCalls).toEqual(['get_blueprint_guide']);
  });
  it('serves legacy tools and instructions from SSE responses; EOF leaves the runtime running', async () => {
    const outfile = await bridgePath();
    const peer = await endpoint();
    const io = launch(outfile, peer.descriptorPath);
    expect((await io.initialize()).result).toMatchObject({
      instructions: SERVER_INSTRUCTIONS,
      serverInfo: { name: 'projector', version: '0.1.0-alpha.1' },
    });
    expect((await io.call(2, 'tools/list', {})).result).toMatchObject({
      tools: [{ name: 'get_projector_guide' }],
    });
    expect(
      (await io.call(3, 'tools/call', { name: 'get_projector_guide', arguments: {} })).result,
    ).toMatchObject({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ topic: 'overview', content: 'Local bundled content' }),
        },
      ],
    });
    expect(
      (await io.call(4, 'tools/call', { name: 'approve', arguments: {} })).result,
    ).toMatchObject({ isError: true });
    expect(peer.toolCalls).toEqual(['get_projector_guide']);
    expect(
      io
        .stdout()
        .trim()
        .split('\n')
        .every((line) => JSON.parse(line).jsonrpc === '2.0'),
    ).toBe(true);
    const exited = once(child!, 'exit');
    child!.stdin.end();
    expect((await exited)[0]).toBe(0);
    expect(runtime!.listening).toBe(true);
  });

  it('fails visibly for an absent descriptor without starting an app or writing protocol noise', async () => {
    const outfile = await bridgePath();
    diagnostics().expect({role:'bridge',kind:'console-error',phase:'test',message:'Projector runtime descriptor is unavailable. Start the application manually and reconnect MCP.',count:1});
    diagnostics().expect({role:'test-child',kind:'process-exit',phase:'test',message:'code=1 signal=null',count:1});
    const io = launch(outfile, join(directory, 'missing.json'));
    expect((await once(child!, 'exit'))[0]).toBe(1);
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toContain('Start the application manually');
  });

  it('rejects a stale instance before forwarding any MCP request', async () => {
    const outfile = await bridgePath();
    const peer = await endpoint({ stale: true });
    diagnostics().expect({role:'bridge',kind:'console-error',phase:'test',message:'Projector runtime instance changed. Reconnect MCP before retrying any operation.',count:1});
    diagnostics().expect({role:'test-child',kind:'process-exit',phase:'test',message:'code=1 signal=null',count:1});
    const io = launch(outfile, peer.descriptorPath);
    expect((await once(child!, 'exit'))[0]).toBe(1);
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toContain('instance');
    expect(peer.mcpRequests()).toBe(0);
  });

  it('reports a disconnected response as unknown and never repeats the tool call', async () => {
    const outfile = await bridgePath();
    const peer = await endpoint({ disconnect: true });
    const io = launch(outfile, peer.descriptorPath);
    await io.initialize();
    const response = await io.call(2, 'tools/call', { name: 'get_projector_guide', arguments: {} });
    expect(response.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('UNKNOWN_RESULT') }],
    });
    expect(peer.toolCalls).toEqual(['get_projector_guide']);
  });

  it('reports clean SSE EOF without a result as unknown instead of waiting or replaying', async () => {
    const outfile = await bridgePath();
    const peer = await endpoint({ incompleteStream: true });
    const io = launch(outfile, peer.descriptorPath);
    await io.initialize();
    const response = await io.call(2, 'tools/call', {
      name: 'get_projector_guide',
      arguments: {},
    });
    expect(response.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('UNKNOWN_RESULT') }],
    });
    expect(peer.toolCalls).toEqual(['get_projector_guide']);
  });

  it('rejects legacy Unix configuration with migration instructions', async () => {
    const outfile = await bridgePath();
    diagnostics().expect({role:'bridge',kind:'console-error',phase:'test',message:'PROJECTOR_SOCKET is no longer supported (including legacy BLUEPRINT_SOCKET). Reconnect MCP using the Projector setup command and PROJECTOR_RUNTIME_DESCRIPTOR.',count:1});
    diagnostics().expect({role:'test-child',kind:'process-exit',phase:'test',message:'code=1 signal=null',count:1});
    child = spawn(process.execPath, [outfile], {
      env: { ...process.env, HOME: directory, PROJECTOR_SOCKET: join(directory, 'unused.sock') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    expect((await once(child, 'exit'))[0]).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('PROJECTOR_SOCKET is no longer supported');
    expect(stderr).toContain('PROJECTOR_RUNTIME_DESCRIPTOR');
  });
});
