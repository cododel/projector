import { Server, type Tool, type CallToolResult } from '@modelcontextprotocol/server';
import { z, ZodError } from 'zod';
import { ProjectorError, type RpcResponse } from '../shared/protocol';
import { storageError } from './files';

export interface ProjectorHello {
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
export function parseProjectorHello(value: unknown): ProjectorHello {
  return helloSchema.parse(value);
}

/** One error boundary for parent IPC, direct MCP and the stdio proxy. */
export function operationError(error: unknown): NonNullable<RpcResponse['error']> {
  const typed =
    error instanceof Error ? (error as Error & { code?: string; guideReference?: string }) : null;
  const value =
    storageError(error) ??
    (typed?.code === 'INVALID_INPUT'
      ? new ProjectorError(typed.code, typed.message, {
          guideReference: typed.guideReference ?? 'overview',
        })
      : new ProjectorError(
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
export function createProjectorMcpServer(
  hello: ProjectorHello,
  call: (name: string, args: unknown) => Promise<CallToolResult>,
): Server {
  const names = new Set(hello.tools.map((tool) => tool.name));
  const aliases: Record<string, string> = {
    get_blueprint_guide: 'get_projector_guide',
    get_blueprint_context: 'get_projector_context',
    get_projector_guide: 'get_blueprint_guide',
    get_projector_context: 'get_blueprint_context',
  };
  const server = new Server(
    { name: 'projector', version: hello.version },
    {
      instructions: hello.instructions,
      capabilities: { tools: {} },
    },
  );
  server.setRequestHandler('tools/list', async () => ({ tools: hello.tools }));
  server.setRequestHandler('tools/call', async (request) => {
    const requested = request.params.name;
    // Respect the actual runtime's advertised tools, including legacy runtimes.
    const name = names.has(requested) ? requested : (aliases[requested] ?? requested);
    if (!names.has(name))
      return mcpError(new ProjectorError('UNKNOWN_TOOL', 'Unsupported Projector tool.'));
    try {
      return await call(name, request.params.arguments ?? {});
    } catch (error) {
      return mcpError(error);
    }
  });
  return server;
}
