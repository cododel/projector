import { spawnSync } from 'node:child_process';

// Every command fails closed. The background-only guarantee is not skipped in
// the full gate: it runs in its own mode before the ordinary-window suite.
for (const args of [
  ['typecheck'],
  ['lint'],
  ['test'],
  ['build'],
  [
    'exec',
    'playwright',
    'test',
    'tests/e2e/background.spec.ts',
    '--reporter=list,./tests/e2e/no-skips-reporter.ts',
  ],
  ['exec', 'playwright', 'test', '--config', 'playwright.full.config.ts'],
]) {
  const result = spawnSync('pnpm', args, {
    stdio: 'inherit',
    env: { ...process.env, PROJECTOR_E2E_VISIBLE: '0', PROJECTOR_E2E_BACKGROUND: '1' },
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
