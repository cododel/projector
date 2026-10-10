import { createServer, type Server as SocketServer } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../src/guide';

let directory: string;
let child: ChildProcessWithoutNullStreams | undefined;
let runtime: SocketServer | undefined;

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, 'exit');
  }
  child = undefined;
  if (runtime) {
    runtime.close();
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

describe('MCP stdio bridge', () => {
  it('serves legacy MCP tools and instructions; stdin EOF disconnects only its runtime connection', async () => {
    const outfile = await bridgePath();
    const socketPath = join(directory, 'test.sock');
    let connectionCount = 0;
    let closedConnections = 0;
    runtime = createServer((socket) => {
      connectionCount++;
      socket.once('close', () => closedConnections++);
      const lines = createInterface({ input: socket });
      lines.on('line', (line) => {
        const request = JSON.parse(line) as {
          id: number;
          method: string;
          params: { name?: string };
        };
        const result =
          request.method === 'hello'
            ? {
                version: '0.1.0-alpha.1',
                instructions: SERVER_INSTRUCTIONS,
                tools: [
                  {
                    name: 'get_blueprint_guide',
                    description: 'Get bundled guide',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              }
            : {
                guideVersion: '0.1.0-alpha.1',
                topic: 'overview',
                content: 'Local bundled content',
              };
        socket.write(JSON.stringify({ id: request.id, result }) + '\n');
      });
    });
    runtime.listen(socketPath);
    await once(runtime, 'listening');
    child = spawn(process.execPath, [outfile], {
      env: { ...process.env, BLUEPRINT_SOCKET: socketPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = createInterface({ input: child.stdout });
    const pending = new Map<number, (value: Record<string, unknown>) => void>();
    const lines: string[] = [];
    output.on('line', (line) => {
      lines.push(line);
      const response = JSON.parse(line) as { id: number } & Record<string, unknown>;
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    });
    const call = (id: number, method: string, params: unknown): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        pending.set(id, resolve);
        child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    const initialized = await call(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'alpha-test', version: '1' },
    });
    expect(initialized.result).toMatchObject({
      instructions: SERVER_INSTRUCTIONS,
      serverInfo: { name: 'blueprint', version: '0.1.0-alpha.1' },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    const toolList = await call(2, 'tools/list', {});
    expect(toolList.result).toMatchObject({ tools: [{ name: 'get_blueprint_guide' }] });
    const guide = await call(3, 'tools/call', { name: 'get_blueprint_guide', arguments: {} });
    expect(guide.result).toMatchObject({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            guideVersion: '0.1.0-alpha.1',
            topic: 'overview',
            content: 'Local bundled content',
          }),
        },
      ],
    });
    const unknown = await call(4, 'tools/call', { name: 'approve', arguments: {} });
    expect(unknown.result).toMatchObject({ isError: true });
    expect(lines.every((line) => JSON.parse(line).jsonrpc === '2.0')).toBe(true);
    const exited = once(child, 'exit');
    child.stdin.end();
    expect((await exited)[0]).toBe(0);
    expect(runtime.listening).toBe(true);
    expect(connectionCount).toBe(1);
    expect(closedConnections).toBe(1);
  });

  it('fails visibly when the runtime is absent without printing protocol noise or starting an app', async () => {
    const outfile = await bridgePath();
    child = spawn(process.execPath, [outfile], {
      env: { ...process.env, BLUEPRINT_SOCKET: join(directory, 'missing.sock') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const [code] = await once(child, 'exit');
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Start the application manually');
  });
});
