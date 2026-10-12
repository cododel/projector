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
      BLUEPRINT_E2E_VISIBLE: '0',
      BLUEPRINT_UNUSED: undefined,
      OTHER: 'unchanged',
    };
    normalizeLegacyEnvironment(env);
    expect(env.PROJECTOR_DATA).toBe('/preferred');
    expect(env.PROJECTOR_RUNTIME_DESCRIPTOR).toBe('/legacy/endpoint.json');
    expect(env.PROJECTOR_E2E_VISIBLE).toBe('0');
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
