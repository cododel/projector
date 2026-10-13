import { installProcessDiagnostics } from '../shared/test-diagnostics';
import { parentPort, workerData } from 'node:worker_threads';
import { parseDocument } from '../document';
installProcessDiagnostics('compiler');
try {
  parentPort?.postMessage({ result: parseDocument(workerData as string) });
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : 'Document compilation failed',
  });
}
