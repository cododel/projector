import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLegacyEnvironment, resolveApplicationData } from '../src/shared/brand-compat';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function appData() {
  const root = await mkdtemp(join(tmpdir(), 'projector-brand-'));
  roots.push(root);
  return root;
}
async function stored(root: string, name: string) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'registry.sqlite'), 'existing registry');
  return path;
}

describe('application data identity across the rename', () => {
  it('uses Projector for fresh data without creating or mutating directories', async () => {
    const root = await appData();
    expect(resolveApplicationData(root, {})).toBe(join(root, 'Projector'));
    expect(await readdir(root)).toEqual([]);
  });
  it.each(['Blueprint', 'agentic-blueprint'])(
    'reuses %s in place, preserving recovery paths',
    async (name) => {
      const root = await appData();
      const legacy = await stored(root, name);
      const receipt = JSON.stringify({ writes: [{ path: join(legacy, 'drafts', 'old.json') }] });
      await writeFile(join(legacy, 'pending.json'), receipt);
      expect(resolveApplicationData(root, {})).toBe(legacy);
      expect(await readFile(join(legacy, 'pending.json'), 'utf8')).toBe(receipt);
      expect(await readdir(root)).toEqual([name]);
    },
  );
  it('does not let an empty preferred directory hide legacy data', async () => {
    const root = await appData();
    await mkdir(join(root, 'Projector'));
    const legacy = await stored(root, 'Blueprint');
    expect(resolveApplicationData(root, {})).toBe(legacy);
    expect(await readdir(join(root, 'Projector'))).toEqual([]);
  });
  it('ignores Electron-only directories without discarding or moving their files', async () => {
    const root = await appData();
    const legacy = await stored(root, 'Blueprint');
    for (const name of ['Projector', 'agentic-blueprint']) {
      const path = join(root, name);
      await mkdir(join(path, 'Local Storage'), { recursive: true });
      await mkdir(join(path, 'GPUCache'));
      await writeFile(join(path, 'Preferences'), '{"fixture":true}');
      await writeFile(join(path, 'Local State'), '{}');
    }
    expect(resolveApplicationData(root, {})).toBe(legacy);
    for (const name of ['Projector', 'agentic-blueprint'])
      expect(await readFile(join(root, name, 'Preferences'), 'utf8')).toBe('{"fixture":true}');
  });
  it('treats unknown files and browser partitions as meaningful data', async () => {
    const root = await appData();
    await stored(root, 'Blueprint');
    const other = join(root, 'agentic-blueprint');
    await mkdir(other);
    await writeFile(join(other, 'unrecognized-data.json'), '{}');
    expect(() => resolveApplicationData(root, {})).toThrow(/multiple.*application data/i);
    await rm(join(other, 'unrecognized-data.json'));
    await mkdir(join(other, 'Partitions'));
    expect(() => resolveApplicationData(root, {})).toThrow(/multiple.*application data/i);
  });
  it('keeps the existing new-brand root when it is the only nonempty root', async () => {
    const root = await appData();
    const preferred = await stored(root, 'Projector');
    await mkdir(join(root, 'Blueprint'));
    expect(resolveApplicationData(root, {})).toBe(preferred);
  });
  it.each([
    ['Projector', 'Blueprint'],
    ['Blueprint', 'agentic-blueprint'],
  ])('rejects conflicting nonempty roots %s and %s instead of merging', async (first, second) => {
    const root = await appData();
    await stored(root, first);
    await stored(root, second);
    expect(() => resolveApplicationData(root, {})).toThrow(/multiple.*application data/i);
    expect(await readFile(join(root, first, 'registry.sqlite'), 'utf8')).toBe('existing registry');
    expect(await readFile(join(root, second, 'registry.sqlite'), 'utf8')).toBe('existing registry');
  });
  it('explicit new environment wins, and legacy environment remains accepted', async () => {
    const root = await appData();
    await stored(root, 'Projector');
    await stored(root, 'Blueprint');
    const legacy = join(root, 'isolated-legacy');
    const preferred = join(root, 'isolated-new');
    expect(
      resolveApplicationData(root, { PROJECTOR_DATA: preferred, BLUEPRINT_DATA: legacy }),
    ).toBe(preferred);
    expect(resolveApplicationData(root, { BLUEPRINT_DATA: legacy })).toBe(legacy);
  });
  it('propagates invalid existing root failures rather than choosing a fresh root', async () => {
    const root = await appData();
    await writeFile(join(root, 'Blueprint'), 'not a directory');
    expect(() => resolveApplicationData(root, {})).toThrow();
  });
});

describe('legacy environment compatibility', () => {
  it('copies legacy values without replacing explicit new values or removing old keys', () => {
    const env: NodeJS.ProcessEnv = {
      BLUEPRINT_DATA: '/legacy',
      PROJECTOR_DATA: '/preferred',
      BLUEPRINT_RUNTIME_DESCRIPTOR: '/legacy/endpoint.json',
      BLUEPRINT_E2E_HARNESS_INTERVAL_MS: '1000',
      BLUEPRINT_UNUSED: undefined,
      OTHER: 'unchanged',
    };
    normalizeLegacyEnvironment(env);
    expect(env.PROJECTOR_DATA).toBe('/preferred');
    expect(env.PROJECTOR_RUNTIME_DESCRIPTOR).toBe('/legacy/endpoint.json');
    expect(env.PROJECTOR_E2E_HARNESS_INTERVAL_MS).toBe('1000');
    expect(env.BLUEPRINT_DATA).toBe('/legacy');
    expect(env.BLUEPRINT_RUNTIME_DESCRIPTOR).toBe('/legacy/endpoint.json');
    expect(env.OTHER).toBe('unchanged');
    expect(Object.hasOwn(env, 'PROJECTOR_UNUSED')).toBe(false);
  });
  it('keeps an explicitly empty new value and is idempotent', () => {
    const env = { PROJECTOR_DATA: '', BLUEPRINT_DATA: '/legacy' };
    normalizeLegacyEnvironment(env);
    normalizeLegacyEnvironment(env);
    expect(env).toEqual({ PROJECTOR_DATA: '', BLUEPRINT_DATA: '/legacy' });
  });
});
