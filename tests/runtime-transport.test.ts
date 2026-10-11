import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RuntimeOperationQueue, startRuntimeHttp } from '../src/runtime/service';
import { BlueprintError } from '../src/shared/protocol';
import {
  defaultRuntimeDescriptorPath,
  parseRuntimeDescriptor,
  readRuntimeDescriptor,
  runtimeHeaders,
  verifyRuntimeDescriptor,
} from '../src/shared/runtime-endpoint';

const resources: { close: () => Promise<void> }[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) await resource.close();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function endpoint(
  options: { requestBytes?: number; call?: (name: string, args: unknown) => Promise<unknown> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'bp-http-'));
  roots.push(root);
  const descriptorPath = join(root, 'runtime', 'endpoint.json');
  const calls: string[] = [];
  const runtime = await startRuntimeHttp({
    descriptorPath,
    hello: {
      version: '1',
      instructions: 'Only public tools.',
      tools: [
        { name: 'read_plan', description: 'Read a saved plan', inputSchema: { type: 'object' } },
      ],
    },
    requestBytes: options.requestBytes,
    call: async (name, args) => {
      calls.push(name);
      return options.call ? options.call(name, args) : { saved: true };
    },
  });
  resources.push(runtime);
  const client = new Client({ name: 'transport-test', version: '1' });
  resources.push(client);
  const connect = async () => {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(runtime.descriptor.url), {
        requestInit: { headers: runtimeHeaders(runtime.descriptor) },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 0,
          maxReconnectionDelay: 0,
          reconnectionDelayGrowFactor: 1,
        },
      }),
    );
    return client;
  };
  return { runtime, descriptorPath, calls, connect };
}

function post(url: string, headers: Record<string, string>, message: unknown): Promise<Response> {
  // Native HTTP deliberately permits a forged Host, unlike fetch's protected headers.
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })),
        );
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(message));
  });
}

async function legacyResult(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const data = body.split('\n').find((line) => line.startsWith('data: '));
  if (!data) throw new Error('Expected legacy MCP SSE result');
  return JSON.parse(data.slice(6)) as Record<string, unknown>;
}

describe('runtime HTTP boundary', () => {
  it('publishes a private dynamic endpoint and serves legacy MCP instructions and tools', async () => {
    const { runtime, descriptorPath, connect } = await endpoint();
    expect(await readRuntimeDescriptor(descriptorPath)).toEqual(runtime.descriptor);
    expect((await stat(descriptorPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(descriptorPath, '..'))).mode & 0o777).toBe(0o700);
    await verifyRuntimeDescriptor(runtime.descriptor);
    const client = await connect();
    expect(client.getInstructions()).toBe('Only public tools.');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['read_plan']);
    expect(await client.callTool({ name: 'read_plan', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: '{"saved":true}' }],
    });
  });

  it('rejects unauthorized, foreign origin, rebinding and stale instance requests before tool dispatch', async () => {
    const { runtime, calls } = await endpoint();
    const headers = runtimeHeaders(runtime.descriptor);
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_plan', arguments: {} },
    };
    for (const [extra, status] of [
      [{ Authorization: '' }, 401],
      [{ Authorization: 'Bearer wrong-token' }, 401],
      [{ Authorization: headers.Authorization.slice(0, -1) + 'é' }, 401],
      [{ Origin: 'https://example.com' }, 403],
      [{ Origin: 'http://127.0.0.1:1234' }, 403],
      [{ Origin: 'null' }, 403],
      [{ Host: 'example.com' }, 403],
      [{ Host: '127.0.0.1:1' }, 403],
      [{ 'x-blueprint-instance': randomUUID() }, 409],
    ] as const) {
      expect(
        (await post(runtime.descriptor.url, { ...headers, ...extra }, payload)).status,
        JSON.stringify(Object.keys(extra)),
      ).toBe(status);
    }
    expect(calls).toEqual([]);
  });

  it('exposes neither operator methods nor operator names even with a valid public token', async () => {
    const { runtime, calls } = await endpoint();
    const headers = runtimeHeaders(runtime.descriptor);
    const forbidden = await post(runtime.descriptor.url, headers, {
      jsonrpc: '2.0',
      id: 1,
      method: 'operator',
      params: { name: 'approve', args: {} },
    });
    expect((await legacyResult(forbidden)).error).toMatchObject({ code: -32601 });
    const unknown = await post(runtime.descriptor.url, headers, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'approve', arguments: {} },
    });
    expect((await legacyResult(unknown)).result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('UNKNOWN_TOOL') }],
    });
    expect(calls).toEqual([]);
  });

  it('bounds request bytes before parsing or dispatch and preserves actionable storage errors', async () => {
    const { runtime, calls, connect } = await endpoint({
      requestBytes: 1024,
      call: async () => {
        throw new BlueprintError('UNKNOWN_RESULT', 'Reconcile before retrying.', {
          phase: 'after-rename',
        });
      },
    });
    const response = await post(runtime.descriptor.url, runtimeHeaders(runtime.descriptor), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_plan', arguments: { value: 'x'.repeat(2000) } },
    });
    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
    const client = await connect();
    const result = await client.callTool({ name: 'read_plan', arguments: {} });
    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            code: 'UNKNOWN_RESULT',
            message: 'Reconcile before retrying.',
            details: { phase: 'after-rename' },
          }),
        },
      ],
    });
  });

  it('late cleanup cannot remove a replacement descriptor and cleanup can repeat', async () => {
    const { runtime, descriptorPath } = await endpoint();
    const replacement = { ...runtime.descriptor, instanceId: randomUUID() };
    await writeFile(descriptorPath, JSON.stringify(replacement));
    await runtime.close();
    await runtime.close();
    expect(JSON.parse(await readFile(descriptorPath, 'utf8'))).toEqual(replacement);
  });
});

describe('descriptor validation and common writer queue', () => {
  it('accepts only the strict local MCP endpoint and never echoes its bearer token in diagnostics', () => {
    const base = {
      protocolVersion: 1,
      instanceId: randomUUID(),
      token: 'x'.repeat(32),
      url: 'http://127.0.0.1:1234/mcp',
    };
    expect(parseRuntimeDescriptor(base)).toEqual(base);
    for (const url of [
      'https://127.0.0.1:1234/mcp',
      'http://localhost:1234/mcp',
      'http://example.com:1234/mcp',
      'http://127.0.0.1/mcp',
      'http://127.0.0.1:1234/operator',
      'http://127.0.0.1:1234/mcp?token=x',
      'http://user:pass@127.0.0.1:1234/mcp',
    ])
      expect(() => parseRuntimeDescriptor({ ...base, url })).toThrow(/descriptor is invalid/);
    try {
      parseRuntimeDescriptor({ ...base, protocolVersion: 2 });
    } catch (error) {
      expect(String(error)).not.toContain(base.token);
    }
    expect(defaultRuntimeDescriptorPath({}, 'darwin', '/test')).toBe(
      '/test/Library/Application Support/Blueprint/runtime/endpoint.json',
    );
    expect(defaultRuntimeDescriptorPath({ XDG_CONFIG_HOME: '/config' }, 'linux', '/test')).toBe(
      '/config/Blueprint/runtime/endpoint.json',
    );
    expect(defaultRuntimeDescriptorPath({ APPDATA: '/roaming' }, 'win32', '/test')).toBe(
      '/roaming/Blueprint/runtime/endpoint.json',
    );
  });

  it('serializes accepted public and operator writes, drains them, and refuses new work', async () => {
    const queue = new RuntimeOperationQueue();
    const events: string[] = [];
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publicWrite = queue.run(async () => {
      events.push('public-start');
      await deferred;
      events.push('public-committed');
    });
    const operatorWrite = queue.run(() => {
      events.push('operator-committed');
    });
    await Promise.resolve();
    const stopped = queue.drain();
    await expect(
      queue.run(() => {
        events.push('unexpected');
      }),
    ).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
    expect(events).toEqual(['public-start']);
    release();
    await Promise.all([publicWrite, operatorWrite, stopped]);
    expect(events).toEqual(['public-start', 'public-committed', 'operator-committed']);
  });
});
