import { installProcessDiagnostics } from './shared/test-diagnostics';
import { runBridge } from './bridge';

installProcessDiagnostics('bridge');
runBridge().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Projector bridge failed.');
  process.exitCode = 1;
});
