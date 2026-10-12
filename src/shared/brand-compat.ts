import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Electron can initialize these before our main module chooses userData.
// They do not establish a Projector identity. Unknown entries and persistent
// browser Partitions remain meaningful so an ambiguous store is never hidden.
const electronShellFiles = new Set([
  'Cache',
  'Code Cache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUCache',
  'GPUPersistentCache',
  'GraphiteDawnCache',
  'DevToolsActivePort',
  'Local State',
  'Local Storage',
  'Network Persistent State',
  'Preferences',
  'Session Storage',
  'Shared Dictionary',
  'Trust Tokens',
  'Trust Tokens-journal',
  'blob_storage',
  'declarative_performance_observer.db',
  'declarative_performance_observer.db-journal',
]);

/** Keep legacy data in place: recovery receipts and browser profiles refer to this root. */
export function resolveApplicationData(
  appData: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.PROJECTOR_DATA !== undefined) return env.PROJECTOR_DATA;
  if (env.BLUEPRINT_DATA !== undefined) return env.BLUEPRINT_DATA;

  const preferred = join(appData, 'Projector');
  const populated = [
    preferred,
    join(appData, 'Blueprint'),
    join(appData, 'agentic-blueprint'),
  ].filter((path) => {
    try {
      return readdirSync(path).some((name) => !electronShellFiles.has(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error(
        `Projector cannot inspect application data at ${path}. Resolve the filesystem error or set PROJECTOR_DATA explicitly.`,
        { cause: error },
      );
    }
  });
  if (populated.length > 1)
    throw new Error(
      `Projector found multiple nonempty application data directories: ${populated.join(', ')}. Set PROJECTOR_DATA to the intended existing directory; directories will not be merged or moved.`,
    );
  return populated[0] ?? preferred;
}

/** New names win; aliases do not disclose values or modify the legacy configuration. */
export function normalizeLegacyEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('BLUEPRINT_') || value === undefined) continue;
    const current = 'PROJECTOR_' + key.slice('BLUEPRINT_'.length);
    if (env[current] === undefined) env[current] = value;
  }
}
