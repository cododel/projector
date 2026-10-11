import {
  Client,
  StreamableHTTPClientTransport,
  type JSONRPCMessage,
} from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { BlueprintError } from './shared/protocol';
import {
  defaultRuntimeDescriptorPath,
  readRuntimeDescriptor,
  rejectLegacySocket,
  runtimeHeaders,
  verifyRuntimeDescriptor,
} from './shared/runtime-endpoint';
import { createBlueprintMcpServer } from './runtime/mcp-server';

/** Never launches a runtime or repeats a tool invocation after an uncertain response. */
export async function runBridge(): Promise<void> {
  rejectLegacySocket();
  const descriptor = await readRuntimeDescriptor(
    process.env.BLUEPRINT_RUNTIME_DESCRIPTOR ?? defaultRuntimeDescriptorPath(),
  );
  await verifyRuntimeDescriptor(descriptor);
  const client = new Client({ name: 'blueprint-stdio-bridge', version: '1' });
  const receivedResults = new Set<string | number>();
  let detectIncomplete = false;
  let available = true;
  const disconnected = () => {
    available = false;
    void client.close().catch(() => {});
  };
  client.onerror = disconnected;
  client.onclose = () => {
    available = false;
  };
  const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), {
    requestInit: { headers: runtimeHeaders(descriptor), redirect: 'error' },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
    // Legacy SDK requests do not reject when a clean SSE EOF precedes their result.
    // Track messages decoded by the SDK; a missing terminal response closes the
    // connection as unknown, without parsing SSE ourselves or replaying the POST.
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      let id: string | number | undefined;
      if (detectIncomplete && typeof init?.body === 'string') {
        const message: JSONRPCMessage = JSON.parse(init.body);
        if ('id' in message && typeof message.id !== 'undefined') id = message.id;
      }
      if (id === undefined || !response.ok || response.status === 202 || !response.body)
        return response;
      const reader = response.body.getReader();
      const requestId = id;
      let bytes = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (!result.done) {
              bytes += result.value.byteLength;
              if (bytes > 8 * 1024 * 1024) {
                await reader.cancel('Runtime response exceeds the bridge limit');
                disconnected();
                throw new Error('Runtime response exceeds the bridge limit');
              }
              controller.enqueue(result.value);
              return;
            }
            controller.close();
            setImmediate(() => {
              if (!receivedResults.delete(requestId)) disconnected();
            });
          } catch (error) {
            controller.error(error);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  try {
    await client.connect(transport, { timeout: 5000 });
  } catch {
    await client.close().catch(() => {});
    throw new BlueprintError(
      'RUNTIME_UNAVAILABLE',
      'Blueprint runtime instance is unavailable. Start the application manually and reconnect MCP.',
    );
  }
  const receive = transport.onmessage;
  transport.onmessage = (message, ...extra) => {
    if ('id' in message && !('method' in message) && message.id !== undefined)
      receivedResults.add(message.id);
    receive?.(message, ...extra);
  };
  detectIncomplete = true;
  let tools;
  try {
    tools = (await client.listTools()).tools;
  } catch {
    await client.close().catch(() => {});
    throw new BlueprintError(
      'RUNTIME_UNAVAILABLE',
      'Blueprint runtime tool list is unavailable. Start the application manually and reconnect MCP.',
    );
  }
  const hello = {
    version: client.getServerVersion()?.version ?? 'unknown',
    instructions: client.getInstructions() ?? '',
    tools,
  };
  const handle = serveStdio(
    () =>
      createBlueprintMcpServer(hello, async (name, args) => {
        if (!available)
          throw new BlueprintError(
            'RUNTIME_UNAVAILABLE',
            'Blueprint runtime is unavailable. Reconnect MCP before retrying.',
          );
        try {
          return await client.callTool(
            { name, arguments: z.record(z.string(), z.unknown()).parse(args) },
            { timeout: 30_000 },
          );
        } catch {
          throw new BlueprintError(
            'UNKNOWN_RESULT',
            'Blueprint runtime disconnected or timed out. The operation may have completed; reconcile by operationId before retrying.',
          );
        }
      }),
    { legacy: 'serve' },
  );
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      available = false;
      await client.close();
      await handle.close();
    })();
    void closing.catch(() => {});
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdin.once('end', close);
  if (process.stdin.readableEnded || process.stdin.destroyed) close();
}
