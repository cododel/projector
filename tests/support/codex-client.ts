import { join } from 'node:path';

/** Launch-only state boundaries for the real authenticated MCP model client. */
export function authenticatedCodexStateArguments(root: string): string[] {
  return [
    '--ephemeral',
    '-c', 'features.plugins=false',
    '-c', 'features.remote_plugin=false',
    // Codex 0.162.1 ephemeral sessions have no state DB handle, but its shell
    // snapshot cleanup still walks/deletes files in the authentication home.
    // This MCP client must not consume or mutate that shared shell context.
    '-c', 'features.shell_snapshot=false',
    '-c', `sqlite_home=${JSON.stringify(join(root, 'codex-state'))}`,
    '-c', `log_dir=${JSON.stringify(join(root, 'codex-logs'))}`,
  ];
}
