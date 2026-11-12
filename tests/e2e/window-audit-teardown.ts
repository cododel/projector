import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const event = z.object({ event: z.string(), pid: z.number(), windowId: z.number().optional() });

export default async function teardown() {
  const path = process.env.PROJECTOR_E2E_WINDOW_AUDIT;
  if (!path) return;
  const contents = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''; // A selection consisting only of skipped tests.
    throw error;
  });
  const events = contents.trim()
    ? contents
        .trim()
        .split('\n')
        .map((line) => event.parse(JSON.parse(line)))
    : [];
  const violations = events.filter((value) => value.event !== 'window-created' && value.event !== 'window-show');
  const created = events.filter(value => value.event === 'window-created').length;
  const shown = events.filter(value => value.event === 'window-show').length;
  console.log(
    `Background Electron audit: ${created} windows, ${shown} show events, ${violations.length} activation/focus violations. Log: ${path}`,
  );
  if (violations.length)
    throw new Error(`Background E2E interrupted the desktop: ${JSON.stringify(violations)}`);
}
