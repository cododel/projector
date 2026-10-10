import { runBridge } from './bridge';

runBridge().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Blueprint bridge failed.');
  process.exitCode = 1;
});
