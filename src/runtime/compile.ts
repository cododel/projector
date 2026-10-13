import { diagnostic, observeWorkerError, observeDiagnosticStream } from '../shared/test-diagnostics';
import { Worker } from 'node:worker_threads';
import type { ParsedDocument } from '../document';
import { ProjectorError } from '../shared/protocol';
import { runtimeLimits } from '../shared/runtime-limits';
export function compileDocument(source: string): Promise<ParsedDocument> {
  const limits = runtimeLimits();
  if (Buffer.byteLength(source) > limits.documentBytes)
    throw new ProjectorError('INVALID_DOCUMENT', 'Document exceeds 2 MB');
  return new Promise((resolve, reject) => {
    const worker = new Worker(process.env.PROJECTOR_COMPILER!, {
      workerData: source,
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const workerId = worker.threadId;
    observeDiagnosticStream(worker.stdout, 'compiler', () => process.pid, 'stdout', workerId);
    observeDiagnosticStream(worker.stderr, 'compiler', () => process.pid, 'stderr', workerId);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      void worker.terminate();
      reject(new ProjectorError('BUILD_TIMEOUT', 'Document compilation exceeded its time limit'));
    }, limits.compileTimeoutMs);
    worker.once('message', (message: { result?: ParsedDocument; error?: string }) => {
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (message.error)
        reject(
          new ProjectorError('INVALID_DOCUMENT', message.error, { guideReference: 'authoring' }),
        );
      else if (message.result) resolve(message.result);
      else reject(new ProjectorError('BUILD_FAILED', 'Compiler returned no document'));
    });
    worker.once('error', (error) => {
      observeWorkerError('compiler', workerId, error);
      settled = true;
      clearTimeout(timer);
      reject(new ProjectorError('BUILD_FAILED', error.message));
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (!settled) {
        diagnostic('compiler', 'worker-exit', `code=${code} without a document`, 'error', { workerId });
        reject(
          new ProjectorError(
            'BUILD_FAILED',
            code === 0
              ? 'Compiler exited without returning a document'
              : 'Compiler exited unsuccessfully',
          ),
        );
      }
      settled = true;
    });
  });
}
