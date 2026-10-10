import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const root = git('rev-parse', '--show-toplevel');
let current = '';
try {
  current = git('config', '--get', 'core.hooksPath');
} catch {
  /* unset */
}
if (current && current !== '.githooks')
  throw new Error('Existing core.hooksPath; refusing to replace user hooks');
const directory = resolve(root, git('rev-parse', '--git-path', 'hooks'));
const hooks = (await readdir(directory)).filter((name) => !name.endsWith('.sample'));
if (hooks.length)
  throw new Error(`Existing hooks: ${hooks.join(', ')}; explicit reconciliation required`);
git('config', '--local', 'core.hooksPath', '.githooks');
console.log(
  'Installed Blueprint pre-push. Commits remain ungated; pushes run focused full checks.',
);
