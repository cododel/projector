import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushedCommits, validatePush } from './pre-push.mjs';

test('push selection deduplicates refs and ignores deletion without running checks', () => {
  const sha = 'a'.repeat(40),
    zero = '0'.repeat(40);
  assert.deepEqual(
    pushedCommits(
      `refs/heads/a ${sha} refs/heads/a ${zero}\nrefs/heads/b ${sha} refs/heads/b ${zero}\n(delete) ${zero} refs/heads/c ${sha}`,
    ),
    [sha],
  );
  assert.throws(() => pushedCommits('malformed input'));
});

test('a defective pushed commit fails even when the dirty worktree fixes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-push-test-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { 'check:full': 'node -e "process.exit(process.env.GIT_DIR ? 8 : 7)"' } }),
    );
    execFileSync('pnpm', ['install', '--lockfile-only', '--offline'], { cwd: root, stdio: 'pipe' });
    git('add', 'package.json', 'pnpm-lock.yaml');
    git('commit', '-m', 'test fixture');
    const sha = git('rev-parse', 'HEAD');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { 'check:full': 'node -e "process.exit(0)"' } }),
    );
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, '.git');
    try {
      await assert.rejects(
        validatePush(root, `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}`, { captureOutput: true }),
        /check:full failed \(7\)/,
      );
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
