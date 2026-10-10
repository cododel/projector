import { parentPort, workerData } from 'node:worker_threads';
import { parseDocument } from '../document';
try {
  parentPort?.postMessage({ result: parseDocument(workerData as string) });
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : 'Document compilation failed',
  });
}
