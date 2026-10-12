import { runBridge } from './bridge';

runBridge().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Projector bridge failed.');
  process.exitCode = 1;
});
