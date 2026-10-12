import { resolveApplicationData } from './brand-compat';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ProjectorError } from './protocol';

export const RUNTIME_PROTOCOL_VERSION = 1;
export const RUNTIME_INSTANCE_HEADER = 'x-projector-instance';
const descriptorSchema = z
  .object({
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    instanceId: z.uuid(),
    url: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === 'http:' &&
            url.hostname === '127.0.0.1' &&
            Number(url.port) > 0 &&
            Number(url.port) <= 65535 &&
            url.pathname === '/mcp' &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }),
    token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  })
  .strict();
export type RuntimeDescriptor = z.infer<typeof descriptorSchema>;

export function rejectLegacySocket(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PROJECTOR_SOCKET !== undefined || env.BLUEPRINT_SOCKET !== undefined)
    throw new ProjectorError(
      'LEGACY_TRANSPORT',
      'PROJECTOR_SOCKET is no longer supported (including legacy BLUEPRINT_SOCKET). Reconnect MCP using the Projector setup command and PROJECTOR_RUNTIME_DESCRIPTOR.',
    );
}

export function defaultRuntimeDescriptorPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  const appData =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
        : (env.XDG_CONFIG_HOME ?? join(home, '.config'));
  const data = resolveApplicationData(appData, env);
  return join(data, 'runtime', 'endpoint.json');
}

export function runtimeDescriptorPath(data: string, env: NodeJS.ProcessEnv = process.env): string {
  rejectLegacySocket(env);
  return (
    env.PROJECTOR_RUNTIME_DESCRIPTOR ??
    env.BLUEPRINT_RUNTIME_DESCRIPTOR ??
    join(data, 'runtime', 'endpoint.json')
  );
}

export function parseRuntimeDescriptor(value: unknown): RuntimeDescriptor {
  const parsed = descriptorSchema.safeParse(value);
  if (!parsed.success)
    throw new ProjectorError(
      'INVALID_RUNTIME_DESCRIPTOR',
      'Projector runtime descriptor is invalid. Reconnect MCP using the application setup command.',
    );
  return parsed.data;
}

export async function readRuntimeDescriptor(path: string): Promise<RuntimeDescriptor> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    throw new ProjectorError(
      'RUNTIME_UNAVAILABLE',
      'Projector runtime descriptor is unavailable. Start the application manually and reconnect MCP.',
    );
  }
  try {
    if (Buffer.byteLength(contents) > 16384) throw new Error('Descriptor too large');
    return parseRuntimeDescriptor(JSON.parse(contents));
  } catch {
    throw new ProjectorError(
      'INVALID_RUNTIME_DESCRIPTOR',
      'Projector runtime descriptor is invalid. Reconnect MCP using the application setup command.',
    );
  }
}

export function runtimeHeaders(descriptor: RuntimeDescriptor): Record<string, string> {
  return {
    Authorization: `Bearer ${descriptor.token}`,
    [RUNTIME_INSTANCE_HEADER]: descriptor.instanceId,
    // An existing stdio bridge may still connect to a legacy running runtime.
    'x-blueprint-instance': descriptor.instanceId,
  };
}

/** No retry: an address from disk is not evidence that its runtime still owns it. */
export async function verifyRuntimeDescriptor(descriptor: RuntimeDescriptor): Promise<void> {
  let response: Response;
  try {
    response = await fetch(new URL('/runtime', descriptor.url), {
      headers: runtimeHeaders(descriptor),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new ProjectorError(
      'RUNTIME_UNAVAILABLE',
      'Projector runtime instance is unavailable. Start the application manually and reconnect MCP.',
    );
  }
  const schema = z
    .object({
      protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
      instanceId: z.uuid(),
      version: z.string(),
    })
    .strict();
  try {
    if (!response.body) throw new Error('Missing runtime response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        throw new Error('Runtime response too large');
      }
      chunks.push(chunk.value);
    }
    const value = schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!response.ok || value.instanceId !== descriptor.instanceId)
      throw new Error('Instance changed');
  } catch {
    throw new ProjectorError(
      'STALE_RUNTIME',
      'Projector runtime instance changed. Reconnect MCP before retrying any operation.',
    );
  }
}
