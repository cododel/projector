import { spawnSync } from 'node:child_process';

for (const args of [
  ['typecheck'],
  ['lint'],
  ['test'],
  ['build'],
  ['exec', 'playwright', 'test', '--config', 'playwright.full.config.ts'],
]) {
  const result = spawnSync('pnpm', args, {
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
