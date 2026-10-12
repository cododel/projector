import { z } from 'zod';
import { TerminalService, TerminalError } from './engine';
import type {
  CreateTerminal,
  TerminalMessage,
  TerminalOptions,
  TerminalOutput,
  TerminalRequest,
} from '../shared/terminal';
const data = process.env.PROJECTOR_DATA;
if (!data || !process.parentPort) throw new Error('Terminal service must be launched by Projector');
let pendingBytes = 0;
const sent = new Map<string, number>();
const gaps = new Map<string, TerminalOutput>();
const send = (message: TerminalMessage) => process.parentPort?.postMessage(message);
const initialOptions: TerminalOptions = process.env.PROJECTOR_TERMINAL_OPTIONS
  ? JSON.parse(process.env.PROJECTOR_TERMINAL_OPTIONS)
  : {};
const engine = new TerminalService(
  data,
  {
    change: (terminals) => send({ type: 'change', terminals }),
    output: (output) => {
      const bytes = Buffer.byteLength(output.data);
      if (pendingBytes + bytes > 1024 * 1024) {
        gaps.set(output.id, { ...output, data: '', gap: true });
        return;
      }
      pendingBytes += bytes;
      sent.set(`${output.id}:${output.seq}`, bytes);
      send({ type: 'output', output });
    },
  },
  initialOptions,
);
const opening = engine.open();
let chain = opening;
let quitting = false;
async function operation(request: TerminalRequest): Promise<unknown> {
  if (quitting && request.method !== 'shutdown')
    throw new TerminalError('TERMINAL_CLOSED', 'Terminal service is shutting down.');
  const args = request.args as Record<string, unknown> | undefined;
  if (request.method === 'snapshot') return engine.snapshot();
  if (request.method === 'create') return engine.create(request.args as CreateTerminal);
  if (request.method === 'configure') return engine.configure(request.args as TerminalOptions);
  if (request.method === 'shutdown') {
    quitting = true;
    await engine.shutdown();
    return null;
  }
  const id = z.string().uuid().parse(args?.id);
  if (request.method === 'cwd') return engine.currentCwd(id);
  if (request.method === 'screen') return engine.screen(id);
  if (request.method === 'bindSession')
    return engine.bindSession(id, z.string().parse(args?.sessionId));
  if (request.method === 'replay')
    return engine.replay(id, z.number().int().min(0).parse(args?.afterSeq));
  if (request.method === 'stop') return engine.stop(id);
  if (request.method === 'restart')
    return engine.restart(
      id,
      args?.options as Pick<CreateTerminal, 'executable' | 'args' | 'env'> | undefined,
    );
  if (request.method === 'input')
    return engine.input(id, z.string().parse(args?.data), z.string().parse(args?.viewId));
  if (request.method === 'resize')
    return engine.resize(id, {
      cols: z.number().parse(args?.cols),
      rows: z.number().parse(args?.rows),
      viewId: z.string().parse(args?.viewId),
      active: z.boolean().parse(args?.active),
    });
  throw new TerminalError('TERMINAL_METHOD_INVALID', 'Unknown terminal operation.');
}
process.parentPort.on('message', (event) => {
  const input = event.data;
  if (
    input?.type === 'output-ack' &&
    typeof input.id === 'string' &&
    Number.isSafeInteger(input.seq)
  ) {
    const key = `${input.id}:${input.seq}`;
    pendingBytes -= sent.get(key) ?? 0;
    sent.delete(key);
    if (pendingBytes < 512 * 1024)
      for (const [id, output] of gaps) {
        send({ type: 'output', output });
        gaps.delete(id);
      }
    return;
  }
  const request = z
    .object({ id: z.string(), method: z.string(), args: z.unknown().optional() })
    .safeParse(input);
  if (!request.success) return;
  chain = chain
    .then(async () => {
      try {
        const result = await operation(request.data);
        send({ type: 'response', id: request.data.id, result: result ?? null });
        if (request.data.method === 'shutdown') setImmediate(() => process.exit(0));
      } catch (error) {
        send({
          type: 'response',
          id: request.data.id,
          error: {
            code: error instanceof TerminalError ? error.code : 'TERMINAL_OPERATION_FAILED',
            message:
              error instanceof TerminalError
                ? error.message
                : 'Terminal operation failed. Check input and local storage.',
          },
        });
        if (request.data.method === 'shutdown') setImmediate(() => process.exit(1));
      }
    })
    .catch(() => {});
});
const close = () => {
  if (quitting) return;
  quitting = true;
  void chain
    .then(() => engine.shutdown())
    .then(
      () => process.exit(0),
      () => process.exit(1),
    );
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
void opening.then(
  () => send({ type: 'ready' }),
  () => process.exit(1),
);
