import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function pushedCommits(input) {
  const commits = new Set();
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(fields[1]))
      throw new Error('Invalid Git pre-push input');
    if (!/^0+$/.test(fields[1])) commits.add(fields[1]);
  }
  return [...commits];
}

export async function validatePush(root, input) {
  for (const commit of pushedCommits(input)) {
    const directory = await mkdtemp(join(tmpdir(), 'blueprint-pre-push-'));
    try {
      // Export the immutable pushed object, without .git or personal worktree data.
      const archive = execFileSync('git', ['-C', root, 'archive', commit], {
        maxBuffer: 128 * 1024 * 1024,
      });
      const path = join(directory, 'source.tar');
      await writeFile(path, archive);
      execFileSync('tar', ['-xf', path, '-C', directory]);
      await rm(path);
      for (const args of [['install', '--frozen-lockfile'], ['check:full']]) {
        const result = spawnSync('pnpm', args, {
          cwd: directory,
          stdio: 'inherit',
        });
        if (result.error || result.status !== 0)
          throw new Error(
            `Pre-push ${commit}: pnpm ${args.join(' ')} failed (${result.status ?? result.error?.message})`,
          );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (process.argv[1]?.endsWith('/pre-push.mjs')) {
  try {
    await validatePush(process.cwd(), readFileSync(0, 'utf8'));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
