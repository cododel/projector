import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server, type Tool } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const responseSchema = z.object({
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});
const helloSchema = z.object({
  version: z.string(),
  instructions: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.object({ type: z.literal('object') }).passthrough(),
      annotations: z
        .object({
          readOnlyHint: z.boolean(),
          destructiveHint: z.boolean(),
          openWorldHint: z.boolean(),
          idempotentHint: z.boolean(),
        })
        .optional(),
    }),
  ),
});

export class RuntimeRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Private RPC client. It never launches a runtime and never retries a mutation. */
export class RuntimeConnection {
  private nextId = 0;
  private buffer = '';
  private pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', () =>
      this.fail(
        new RuntimeRpcError(
          'RUNTIME_UNAVAILABLE',
          'Blueprint runtime connection failed. Reconcile any uncertain operation before retrying.',
        ),
      ),
    );
    socket.on('close', () =>
      this.fail(
        new RuntimeRpcError(
          'UNKNOWN_RESULT',
          'Blueprint runtime disconnected. An in-flight operation may have completed; reconcile by operationId before retrying.',
        ),
      ),
    );
  }

  static async connect(socketPath: string): Promise<RuntimeConnection> {
    const socket = createConnection(socketPath);
    const connection = new RuntimeConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new RuntimeRpcError(
            'RUNTIME_UNAVAILABLE',
            'Blueprint runtime connection timed out. Start the application manually.',
          ),
        );
      }, 5000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', () => {
        clearTimeout(timer);
        reject(
          new RuntimeRpcError(
            'RUNTIME_UNAVAILABLE',
            'Blueprint is not running or its runtime is unavailable. Start the application manually.',
          ),
        );
      });
    });
    return connection;
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.socket.destroyed)
      return Promise.reject(
        new RuntimeRpcError('RUNTIME_UNAVAILABLE', 'Blueprint runtime is unavailable.'),
      );
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RuntimeRpcError(
            'UNKNOWN_RESULT',
            'Blueprint operation timed out. Reconcile by operationId before retrying; it may already have completed.',
          ),
        );
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id: String(id), method, params }) + '\n');
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
      this.fail(
        new RuntimeRpcError(
          'INVALID_RUNTIME_RESPONSE',
          'Blueprint runtime response exceeds the transport limit.',
        ),
      );
      this.close();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: z.infer<typeof responseSchema>;
      try {
        message = responseSchema.parse(JSON.parse(line));
      } catch {
        this.fail(
          new RuntimeRpcError(
            'INVALID_RUNTIME_RESPONSE',
            'Blueprint runtime sent an invalid response.',
          ),
        );
        this.close();
        return;
      }
      const id = typeof message.id === 'number' ? message.id : Number(message.id);
      const request = this.pending.get(id);
      if (!request) continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
      if (message.error)
        request.reject(
          new RuntimeRpcError(message.error.code, message.error.message, message.error.details),
        );
      else request.resolve(message.result);
    }
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

export function defaultSocketPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Blueprint', 'runtime', 'service.sock');
}

export async function runBridge(): Promise<void> {
  const runtime = await RuntimeConnection.connect(
    process.env.BLUEPRINT_SOCKET ?? defaultSocketPath(),
  );
  let hello: z.infer<typeof helloSchema>;
  try {
    hello = helloSchema.parse(await runtime.request('hello'));
  } catch (error) {
    runtime.close();
    throw error;
  }

  const tools: Tool[] = hello.tools;
  const names = new Set(tools.map((tool) => tool.name));
  const handle = serveStdio(
    () => {
      const server = new Server(
        { name: 'blueprint', version: hello.version },
        {
          instructions: hello.instructions,
          capabilities: { tools: {} },
        },
      );
      server.setRequestHandler('tools/list', async () => ({ tools }));
      server.setRequestHandler('tools/call', async (request) => {
        if (!names.has(request.params.name))
          return { isError: true, content: [{ type: 'text', text: 'Unknown Blueprint tool.' }] };
        try {
          // Runtime owns validation for both UI-independent tools and bridge calls.
          const result = await runtime.request('tool', {
            name: request.params.name,
            args: request.params.arguments ?? {},
          });
          return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
        } catch (error) {
          const code = error instanceof RuntimeRpcError ? error.code : 'RUNTIME_ERROR';
          const message = error instanceof Error ? error.message : 'Blueprint request failed.';
          const details = error instanceof RuntimeRpcError ? error.details : undefined;
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({ code, message, ...(details ? { details } : {}) }),
              },
            ],
          };
        }
      });
      server.onclose = () => runtime.close();
      return server;
    },
    { legacy: 'serve' },
  );

  const close = (): void => {
    runtime.close();
    void handle.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdin.once('end', close);
  if (process.stdin.readableEnded || process.stdin.destroyed) close();
}
