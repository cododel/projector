import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { compileDocument } from './compile';
import { openStore } from './store';
import { Operations } from './operations';
import { atomicJson } from './files';
import {
  createBlueprintMcpServer,
  operationError,
  parseBlueprintHello,
  type BlueprintHello,
} from './mcp-server';
import { BlueprintError, type RpcResponse } from '../shared/protocol';
import { runtimeLimits } from '../shared/runtime-limits';
import {
  RUNTIME_INSTANCE_HEADER,
  RUNTIME_PROTOCOL_VERSION,
  readRuntimeDescriptor,
  runtimeDescriptorPath,
  type RuntimeDescriptor,
} from '../shared/runtime-endpoint';

/** All accepted operations share one writer, independently of their transport. */
export class RuntimeOperationQueue {
  private chain: Promise<void> = Promise.resolve();
  private accepting = true;
  run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new BlueprintError('SHUTTING_DOWN', 'Blueprint is shutting down'));
    const result = this.chain.then(operation);
    this.chain = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async drain(): Promise<void> {
    this.accepting = false;
    await this.chain;
  }
}

function deny(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }));
}
function oneHeader(request: IncomingMessage, name: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() !== name) continue;
    if (value !== undefined) return undefined;
    value = request.rawHeaders[index + 1];
  }
  return value;
}

/** Loopback MCP is public-tool-only. The parent process has a separate private IPC path. */
export async function startRuntimeHttp(options: {
  descriptorPath: string;
  hello: BlueprintHello;
  call: (name: string, args: unknown) => Promise<unknown>;
  requestBytes?: number;
}) {
  const instanceId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const requestBytes = options.requestBytes ?? runtimeLimits().requestBytes;
  const handler = createMcpHandler(
    () =>
      createBlueprintMcpServer(options.hello, async (name, args) => {
        const result = await options.call(name, args);
        return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
      }),
    {
      legacy: 'stateless',
      maxRequestBodySize: requestBytes,
    },
  );
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: requestBytes });
  const server = createServer((request, response) => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      deny(response, 503);
      return;
    }
    // No browser origin is needed: trusted UI/operator traffic uses parent IPC.
    if (
      request.headers.origin !== undefined ||
      oneHeader(request, 'host') !== `127.0.0.1:${address.port}`
    ) {
      deny(response, 403);
      return;
    }
    const auth = oneHeader(request, 'authorization');
    const received = Buffer.from(auth ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (!auth || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      deny(response, 401);
      return;
    }
    if (oneHeader(request, RUNTIME_INSTANCE_HEADER) !== instanceId) {
      deny(response, 409);
      return;
    }
    if (request.url === '/runtime' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(
        JSON.stringify({
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          instanceId,
          version: options.hello.version,
        }),
      );
    } else if (request.url === '/mcp') {
      void nodeHandler(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        if (!response.destroyed) response.end();
      });
    } else {
      response.writeHead(404, { 'Cache-Control': 'no-store' }).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback endpoint unavailable');
  const descriptor: RuntimeDescriptor = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    instanceId,
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
  };
  try {
    await mkdir(dirname(options.descriptorPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(options.descriptorPath), 0o700);
    await atomicJson(options.descriptorPath, descriptor);
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handler.close();
    throw error;
  }
  let closed: Promise<void> | undefined;
  return {
    descriptor,
    server,
    close(): Promise<void> {
      return (closed ??= (async () => {
        await handler.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // A replacement instance owns its descriptor. Late cleanup must not erase it.
        const current = await readRuntimeDescriptor(options.descriptorPath).catch(() => null);
        if (current?.instanceId === instanceId)
          await unlink(options.descriptorPath).catch(() => {});
      })());
    },
  };
}

const operatorSchema = z
  .object({
    type: z.literal('operator'),
    id: z.string().min(1).max(150),
    name: z.string().min(1).max(150),
    args: z.unknown(),
  })
  .strict();
async function main() {
  const data = process.env.BLUEPRINT_DATA;
  if (!data || !process.parentPort) throw new Error('Runtime must be launched by Blueprint');
  const limits = runtimeLimits();
  const descriptorPath = runtimeDescriptorPath(data);
  const store = await openStore(data, compileDocument);
  const ops = new Operations(store, (event) => process.parentPort?.postMessage(event));
  const queue = new RuntimeOperationQueue();
  const endpoint = await startRuntimeHttp({
    descriptorPath,
    hello: parseBlueprintHello(ops.hello()),
    call: (name, args) => queue.run(() => ops.tool(name, args)),
    requestBytes: limits.requestBytes,
  });
  let quitting = false;
  const close = async () => {
    if (quitting) return;
    quitting = true;
    await queue.drain();
    await endpoint.close();
    store.close();
    process.exit(0);
  };
  process.parentPort.on('message', (event) => {
    if (event.data === 'quit') {
      void close();
      return;
    }
    const parsed = operatorSchema.safeParse(event.data);
    if (!parsed.success) return;
    const request = parsed.data;
    void queue
      .run(async () => {
        if (Buffer.byteLength(JSON.stringify(request)) > limits.requestBytes)
          throw new BlueprintError('INPUT_TOO_LARGE', 'Request too large');
        return ops.operator(request.name, request.args);
      })
      .then(
        (result) => {
          process.parentPort?.postMessage({ type: 'operator-response', id: request.id, result });
        },
        (error) => {
          const response: RpcResponse = { id: request.id, error: operationError(error) };
          process.parentPort?.postMessage({ type: 'operator-response', ...response });
        },
      );
  });
  process.on('SIGTERM', () => void close());
  process.parentPort.postMessage({ type: 'ready', sqlite: true, descriptorPath });
}
if (process.parentPort)
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Blueprint runtime failed.');
    process.exit(1);
  });
