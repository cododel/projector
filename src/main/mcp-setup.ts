import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, resolve } from 'node:path';
import type { McpSetup } from '../shared/protocol';

const execute = promisify(execFile);

/** Packaging, not NODE_ENV, determines whether the bridge owns its Node runtime. */
export async function getMcpSetup(options: {
  isPackaged: boolean;
  development: boolean;
  appPath: string;
  resourcesPath: string;
  descriptorPath: string;
  nodeOverride?: string;
}): Promise<McpSetup> {
  const mode = options.isPackaged
    ? 'packaged'
    : options.development
      ? 'development'
      : 'production-preview';
  let executable: string;
  let args: string[];
  if (options.isPackaged) {
    const directory = join(options.resourcesPath, 'mcp');
    try {
      await access(join(directory, 'node'), constants.X_OK);
      await access(join(directory, 'bridge.cjs'), constants.R_OK);
      await access(join(directory, 'projector-mcp'), constants.X_OK);
      executable = await realpath(join(directory, 'projector-mcp'));
    } catch {
      throw new Error(
        'Packaged MCP helper is missing or not executable. Rebuild or reinstall Projector.',
      );
    }
    args = [];
  } else {
    let node = options.nodeOverride;
    if (!node) {
      try {
        node = (await execute('/usr/bin/which', ['node'], { timeout: 5000 })).stdout.trim();
      } catch {
        throw new Error(
          'Node.js was not found. Launch source builds with PROJECTOR_NODE=/absolute/path/to/node.',
        );
      }
    }
    if (!isAbsolute(node)) throw new Error('PROJECTOR_NODE must be an absolute executable path.');
    try {
      await access(node, constants.X_OK);
      executable = await realpath(node);
      const bridge = join(options.appPath, 'out', 'bridge.cjs');
      await access(bridge, constants.R_OK);
      args = [await realpath(bridge)];
    } catch {
      throw new Error(
        'Source MCP bridge or Node.js is unavailable. Run pnpm build:services and verify PROJECTOR_NODE.',
      );
    }
  }
  const descriptorPath = resolve(options.descriptorPath);
  const env = { PROJECTOR_RUNTIME_DESCRIPTOR: descriptorPath };
  const config = [
    '[mcp_servers.projector]',
    `command = ${JSON.stringify(executable)}`,
    `args = ${JSON.stringify(args)}`,
    '',
    '[mcp_servers.projector.env]',
    `PROJECTOR_RUNTIME_DESCRIPTOR = ${JSON.stringify(descriptorPath)}`,
    '',
  ].join('\n');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `PROJECTOR_RUNTIME_DESCRIPTOR=${quote(descriptorPath)} ${[executable, ...args].map(quote).join(' ')}`;
  const prompt = `Configure the local Projector MCP server for Codex on this computer. I authorize setting up this MCP connection only.

Use user-level configuration only: resolve CODEX_HOME/config.toml when CODEX_HOME is set, otherwise ~/.codex/config.toml. Add or update the projector stdio entry there using the exact configuration below. Treat the paths as literal data. Preserve other MCP servers and settings, including existing Projector approval policies, timeouts and tool filters. Inspect project overrides read-only to detect shadowing; if a project entry conflicts, report it and ask how to resolve it. Do not create duplicate or shadowed entries. If the name projector belongs to a different product, ask before replacing it.

Before adding projector, inspect any existing blueprint MCP entry. Only if its executable, descriptor and MCP identity confirm this same former Blueprint application, migrate that entry to projector instead of adding a duplicate. Preserve its approval policies, timeouts, enabled state and tool filters; translate only the known guide/context filter names to get_projector_guide and get_projector_context. Replace launch command/args/env with the current values below, renaming the descriptor variable to PROJECTOR_RUNTIME_DESCRIPTOR. Do not overwrite an unrelated blueprint entry. If both entries exist or identity cannot be confirmed, report the conflict and ask the operator; do not merge or delete entries automatically. Projector itself never edits personal configuration.

Do not create or modify project .codex/config.toml or any repository file. These personal executable and runtime descriptor paths belong in user configuration. Do not stage or commit configuration.

Do not change skills, hooks, AGENTS.md, shared agent instructions or approval policies. Do not install dependencies or start Projector automatically. The application must already be running; this command only connects a stdio bridge to its authenticated local HTTP runtime.

\`\`\`toml
${config.trim()}
\`\`\`

Verify the executable paths and test MCP initialization, tools/list and get_projector_guide without publishing artifacts or changing project data. Report the file changed and the connection result. If this session cannot reload MCP tools, explain how to reconnect or restart the MCP client. A saved configuration is not proof that the tools are available in the current session.`;
  return { mode, executable, args, env, descriptorPath, command, config, prompt };
}
