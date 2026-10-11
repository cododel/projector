import { Server, type Tool, type CallToolResult } from '@modelcontextprotocol/server';
import { z, ZodError } from 'zod';
import { BlueprintError, type RpcResponse } from '../shared/protocol';
import { storageError } from './files';

export interface BlueprintHello {
  version: string;
  instructions: string;
  tools: Tool[];
}

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
export function parseBlueprintHello(value: unknown): BlueprintHello {
  return helloSchema.parse(value);
}

/** One error boundary for parent IPC, direct MCP and the stdio proxy. */
export function operationError(error: unknown): NonNullable<RpcResponse['error']> {
  const typed =
    error instanceof Error ? (error as Error & { code?: string; guideReference?: string }) : null;
  const value =
    storageError(error) ??
    (typed?.code === 'INVALID_INPUT'
      ? new BlueprintError(typed.code, typed.message, {
          guideReference: typed.guideReference ?? 'overview',
        })
      : new BlueprintError(
          error instanceof ZodError ? 'INVALID_INPUT' : 'OPERATION_FAILED',
          error instanceof ZodError
            ? 'Request does not match the operation schema'
            : 'Operation failed; check local storage and document diagnostics',
          error instanceof ZodError
            ? {
                issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
                guideReference: 'overview',
              }
            : {},
        ));
  return { code: value.code, message: value.message, details: value.details };
}

export function mcpError(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(operationError(error)) }],
  };
}

/** The public allowlist contains tools only; operator operations never enter this factory. */
export function createBlueprintMcpServer(
  hello: BlueprintHello,
  call: (name: string, args: unknown) => Promise<CallToolResult>,
): Server {
  const names = new Set(hello.tools.map((tool) => tool.name));
  const server = new Server(
    { name: 'blueprint', version: hello.version },
    {
      instructions: hello.instructions,
      capabilities: { tools: {} },
    },
  );
  server.setRequestHandler('tools/list', async () => ({ tools: hello.tools }));
  server.setRequestHandler('tools/call', async (request) => {
    if (!names.has(request.params.name))
      return mcpError(new BlueprintError('UNKNOWN_TOOL', 'Unsupported Blueprint tool.'));
    try {
      return await call(request.params.name, request.params.arguments ?? {});
    } catch (error) {
      return mcpError(error);
    }
  });
  return server;
}
