import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeLimits } from '../src/shared/runtime-limits';
import { ProjectorError } from '../src/shared/protocol';
import { compileDocument } from '../src/runtime/compile';
import { atomicText, commitDirectory, storageError } from '../src/runtime/files';

const fault = vi.hoisted(() => ({ phase: '', code: 'ENOSPC' }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (fault.phase === 'write' && args[1] === 'wx')
        handle.writeFile = async () => {
          throw Object.assign(new Error('disk full'), { code: fault.code });
        };
      if (fault.phase === 'directory-sync' && args[1] === 'r')
        handle.sync = async () => {
          throw Object.assign(new Error('disk sync failed'), { code: fault.code });
        };
      return handle;
    },
  };
});
const roots: string[] = [];
const root = async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'bp-reliability-')));
  roots.push(path);
  return path;
};
afterEach(async () => {
  fault.phase = '';
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe('publication outcome knowledge', () => {
  it('preserves previous content and removes only its staging file when disk fills before rename', async () => {
    const dir = await root();
    const path = join(dir, 'state.json');
    await writeFile(path, 'previous');
    await writeFile(join(dir, 'operator.tmp'), 'keep');
    fault.phase = 'write';
    await expect(atomicText(path, 'new')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await readFile(path, 'utf8')).toBe('previous');
    expect(await readdir(dir)).toEqual(['operator.tmp', 'state.json']);
  });
  it('reports uncertain acknowledgement after rename instead of claiming the new content was not written', async () => {
    const path = join(await root(), 'state.json');
    fault.phase = 'directory-sync';
    await expect(atomicText(path, 'committed')).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
      details: { phase: 'after-rename', causeCode: 'ENOSPC' },
    });
    expect(await readFile(path, 'utf8')).toBe('committed');
  });
  it('reports directory publication uncertainty after rename', async () => {
    const dir = await root();
    const stage = join(dir, 'staged');
    const target = join(dir, 'published');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(stage);
    await writeFile(join(stage, 'manifest.json'), 'complete');
    fault.phase = 'directory-sync';
    await expect(commitDirectory(stage, target, dir)).rejects.toMatchObject({
      code: 'UNKNOWN_RESULT',
    });
    expect(await readFile(join(target, 'manifest.json'), 'utf8')).toBe('complete');
  });
});
describe('compiler lifecycle', () => {
  it('rejects a successful worker exit that produced no result', async () => {
    const script = join(await root(), 'empty.cjs');
    await writeFile(script, 'process.exit(0)');
    vi.stubEnv('PROJECTOR_COMPILER', script);
    await expect(compileDocument('hello')).rejects.toMatchObject({ code: 'BUILD_FAILED' });
  }, 500);
});

describe('effective runtime boundaries', () => {
  it('returns deployed defaults and enforces timeout configuration', () => {
    expect(runtimeLimits({})).toMatchObject({
      version: '1',
      compileTimeoutMs: 30000,
      captureTimeoutMs: 10000,
      documentBytes: 2000000,
      imageBase64Characters: 24000000,
      readChunkCharacters: 12000,
      listPageItems: 20,
    });
    expect(
      runtimeLimits({ PROJECTOR_COMPILE_TIMEOUT_MS: '150', PROJECTOR_CAPTURE_TIMEOUT_MS: '200' }),
    ).toMatchObject({ compileTimeoutMs: 150, captureTimeoutMs: 200 });
    for (const value of ['NaN', '-1', '0', '99', '300001', '100.5', ''])
      expect(() => runtimeLimits({ PROJECTOR_COMPILE_TIMEOUT_MS: value })).toThrow(
        /PROJECTOR_COMPILE_TIMEOUT_MS/,
      );
  });
  it.each(['ENOSPC', 'EROFS', 'EACCES', 'EPERM', 'ENOENT'])(
    'preserves actionable %s at the RPC error boundary',
    (code) => {
      expect(
        storageError(Object.assign(new Error('private internal path'), { code })),
      ).toMatchObject({ code, details: { storage: true } });
      expect(
        storageError(Object.assign(new Error('private internal path'), { code }))?.message,
      ).not.toContain('private internal path');
    },
  );
  it('preserves explicit publication uncertainty and does not invent storage diagnoses', () => {
    const error = new ProjectorError('UNKNOWN_RESULT', 'Reconcile first');
    expect(storageError(error)).toBe(error);
    expect(storageError(new Error('unclassified'))).toBeUndefined();
  });
  it('terminates a nonresponsive compiler at the configured deadline', async () => {
    const script = join(await root(), 'hung.cjs');
    await writeFile(script, 'setInterval(() => {}, 1000)');
    vi.stubEnv('PROJECTOR_COMPILER', script);
    vi.stubEnv('PROJECTOR_COMPILE_TIMEOUT_MS', '100');
    await expect(compileDocument('hello')).rejects.toMatchObject({ code: 'BUILD_TIMEOUT' });
  });
});
