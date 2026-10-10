import { Worker } from 'node:worker_threads';
import type { ParsedDocument } from '../document';
import { BlueprintError } from '../shared/protocol';
export function compileDocument(source: string): Promise<ParsedDocument> {
  if (Buffer.byteLength(source) > 2_000_000)
    throw new BlueprintError('INVALID_DOCUMENT', 'Document exceeds 2 MB');
  return new Promise((resolve, reject) => {
    const worker = new Worker(process.env.BLUEPRINT_COMPILER!, {
      workerData: source,
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new BlueprintError('BUILD_TIMEOUT', 'Document compilation exceeded its time limit'));
    }, 10000);
    worker.once('message', (message: { result?: ParsedDocument; error?: string }) => {
      clearTimeout(timer);
      if (message.error)
        reject(
          new BlueprintError('INVALID_DOCUMENT', message.error, { guideReference: 'authoring' }),
        );
      else if (message.result) resolve(message.result);
      else reject(new BlueprintError('BUILD_FAILED', 'Compiler returned no document'));
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(new BlueprintError('BUILD_FAILED', error.message));
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new BlueprintError('BUILD_FAILED', 'Compiler exited unsuccessfully'));
    });
  });
}
