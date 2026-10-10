import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdir, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compileDocument } from './compile';
import { openStore } from './store';
import { Operations } from './operations';
import { BlueprintError, type RpcRequest, type RpcResponse } from '../shared/protocol';
import { ZodError } from 'zod';
async function main() {
  const data = process.env.BLUEPRINT_DATA!;
  const socketPath = process.env.BLUEPRINT_SOCKET!;
  const token = process.env.BLUEPRINT_OPERATOR_TOKEN!;
  if (!data || !socketPath || !token) throw new Error('Runtime must be launched by Blueprint');
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const store = await openStore(data, compileDocument);
  const sockets = new Set<import('node:net').Socket>();
  const ops = new Operations(store, (event) => process.parentPort?.postMessage(event));
  let chain = Promise.resolve();
  let quitting = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    const respond = (response: RpcResponse) => {
      if (socket.destroyed || socket.writableEnded) return;
      socket.write(JSON.stringify(response) + '\n', (error) => {
        if (error) socket.destroy();
      });
    };
    const lines = createInterface({ input: socket });
    lines.on('error', () => socket.destroy());
    lines.on('line', (line) => {
      chain = chain
        .then(async () => {
          let request: RpcRequest | undefined;
          try {
            if (Buffer.byteLength(line) > 32_000_000)
              throw new BlueprintError('INPUT_TOO_LARGE', 'Request too large');
            request = JSON.parse(line) as RpcRequest;
            if (quitting) throw new BlueprintError('SHUTTING_DOWN', 'Blueprint is shutting down');
            let result: unknown;
            if (request.method === 'hello') result = ops.hello();
            else if (request.method === 'tool') {
              const p = request.params as { name: string; args: unknown };
              result = await ops.tool(p.name, p.args);
            } else if (request.method === 'operator' && request.token === token) {
              const p = request.params as { name: string; args: unknown };
              result = await ops.operator(p.name, p.args);
            } else throw new BlueprintError('FORBIDDEN', 'Operation is not allowed');
            respond({ id: request.id, result });
          } catch (error) {
            const typed =
              error instanceof Error
                ? (error as Error & { code?: string; guideReference?: string })
                : null;
            const err =
              error instanceof BlueprintError
                ? error
                : typed?.code === 'INVALID_INPUT'
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
                            issues: error.issues.map((issue) => ({
                              path: issue.path,
                              message: issue.message,
                            })),
                            guideReference: 'overview',
                          }
                        : {},
                    );
            if (request)
              respond({
                id: request.id,
                error: { code: err.code, message: err.message, details: err.details },
              });
          }
        })
        .catch(() => {});
    });
  });
  server.listen(socketPath, async () => {
    await chmod(socketPath, 0o600);
    process.parentPort?.postMessage({ type: 'ready', sqlite: true });
  });
  server.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  const close = async () => {
    quitting = true;
    await chain;
    for (const socket of sockets) socket.end();
    server.close();
    store.close();
    await unlink(socketPath).catch(() => {});
    process.exit(0);
  };
  process.parentPort?.on('message', (event) => {
    if (event.data === 'quit') void close();
  });
  process.on('SIGTERM', () => void close());
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
