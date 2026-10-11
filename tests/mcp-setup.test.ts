import { mkdtemp, mkdir, writeFile, chmod, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { getMcpSetup } from '../src/main/mcp-setup';

let directory: string;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function paths() {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'bp-paths-')));
  return {
    isPackaged: false,
    development: false,
    appPath: directory,
    resourcesPath: join(directory, 'moved app with spaces', 'Contents', 'Resources'),
    descriptorPath: join(directory, 'runtime descriptor.json'),
    nodeOverride: process.execPath,
  };
}
it('source production preview follows appPath, resolves symlinks and preserves the exact descriptor', async () => {
  const options = await paths();
  await mkdir(join(directory, 'out'));
  await writeFile(join(directory, 'out', 'bridge.cjs'), '');
  const alias = join(directory, 'node alias');
  await symlink(process.execPath, alias);
  const setup = await getMcpSetup({ ...options, nodeOverride: alias });
  expect(setup.mode).toBe('production-preview');
  expect(setup.executable).not.toBe(alias);
  expect(setup.args).toEqual([join(directory, 'out', 'bridge.cjs')]);
  expect(setup.env.BLUEPRINT_RUNTIME_DESCRIPTOR).toBe(options.descriptorPath);
  expect(setup.config).toContain(`BLUEPRINT_RUNTIME_DESCRIPTOR = ${JSON.stringify(options.descriptorPath)}`);
});
it('packaged builds use only their actual bundled resources, ignoring source Node overrides', async () => {
  const options = await paths();
  const helper = join(options.resourcesPath, 'mcp');
  await mkdir(helper, { recursive: true });
  for (const name of ['node', 'bridge.cjs', 'blueprint-mcp']) {
    await writeFile(join(helper, name), '');
    await chmod(join(helper, name), 0o755);
  }
  const setup = await getMcpSetup({
    ...options,
    isPackaged: true,
    development: true,
    nodeOverride: '/missing/node',
  });
  expect(setup.mode).toBe('packaged');
  expect(setup.executable).toBe(join(helper, 'blueprint-mcp'));
  expect(setup.args).toEqual([]);
  expect(setup.config).not.toContain('/missing/node');
  expect(setup.command).toContain(`'${setup.executable}'`);
});
it('missing packaged resources fail explicitly instead of falling back to system Node', async () => {
  const options = await paths();
  await expect(getMcpSetup({ ...options, isPackaged: true })).rejects.toThrow(
    'Packaged MCP helper is missing',
  );
});
it('development is explicit and missing source builds cannot produce an unusable configuration', async () => {
  const options = await paths();
  await expect(getMcpSetup({ ...options, development: true })).rejects.toThrow(
    'pnpm build:services',
  );
  await mkdir(join(directory, 'out'));
  await writeFile(join(directory, 'out', 'bridge.cjs'), '');
  expect((await getMcpSetup({ ...options, development: true })).mode).toBe('development');
  await expect(getMcpSetup({ ...options, nodeOverride: 'node' })).rejects.toThrow('absolute');
});
