import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export default async function setup() {
  delete process.env.BLUEPRINT_E2E_WINDOW_AUDIT;
  if (process.env.BLUEPRINT_E2E_BACKGROUND !== '1') return;
  await mkdir('.tmp', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/e2e-window-audit-'));
  process.env.BLUEPRINT_E2E_WINDOW_AUDIT = join(directory, 'windows.jsonl');
}
