import { execFile } from '../shared/observed-exec';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

const execute = promisify(execFile);
/** Read Git's actual metadata; a .git file alone can also describe a submodule. */
export async function linkedWorktreePath(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execute(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      {
        timeout: 2000,
        maxBuffer: 64 * 1024,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        ),
      },
    );
    const [directory, common] = stdout.trim().split('\n');
    if (!directory || !common) return undefined;
    const [gitDir, commonDir] = await Promise.all([realpath(directory), realpath(common)]);
    return gitDir === commonDir ? undefined : await realpath(cwd);
  } catch {
    return undefined;
  }
}
