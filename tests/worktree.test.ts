import { diagnostics } from './support/vitest-diagnostics';
import { it, expect } from 'vitest';
import { execFile } from './support/process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkedWorktreePath } from '../src/main/worktree';
const execute = promisify(execFile);
it('recognizes linked worktrees and nested directories without labeling ordinary folders or the primary checkout', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bp-worktree-')));
  const primary = join(root, 'primary'),
    linked = join(root, 'linked'),
    plain = join(root, 'plain');
  try {
    await mkdir(primary);
    await mkdir(plain);
    const git = (...args: string[]) => execute('git', ['-C', primary, ...args]);
    await git('init', '--initial-branch=main');
    await git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    diagnostics().expect({role:'test-child',kind:'stderr',phase:'test',message:/^Preparing worktree \(detached HEAD [0-9a-f]+\)$/,count:1});
    await git('worktree', 'add', '--detach', linked);
    const nested = join(linked, 'nested');
    await mkdir(nested);
    expect(await linkedWorktreePath(primary)).toBeUndefined();
    expect(await linkedWorktreePath(linked)).toBe(linked);
    expect(await linkedWorktreePath(nested)).toBe(nested);
    expect(await linkedWorktreePath(plain)).toBeUndefined();
    expect(await linkedWorktreePath(join(root, 'missing'))).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
