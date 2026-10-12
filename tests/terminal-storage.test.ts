import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TerminalService } from '../src/terminal/engine';
import { terminateOwnedProcessTree } from '../src/terminal/processes';

const fault = vi.hoisted(() => ({ write: false, directorySync: false, cleanup: false }));
const pids = vi.hoisted(() => new Set<number>());
vi.mock('node-pty', async (original) => {
  const actual = await original<typeof import('node-pty')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const pty = actual.spawn(...args);
      pids.add(pty.pid);
      return pty;
    },
  };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (fault.write && args[1] === 'wx')
        file.writeFile = async () => {
          throw Object.assign(new Error('Synthetic full disk'), { code: 'ENOSPC' });
        };
      if (fault.directorySync && args[1] === 'r')
        file.sync = async () => {
          throw Object.assign(new Error('Synthetic durability acknowledgement failure'), {
            code: 'EIO',
          });
        };
      return file;
    },
  };
});
vi.mock('../src/terminal/processes', async (original) => {
  const actual = await original<typeof import('../src/terminal/processes')>();
  return {
    ...actual,
    terminateOwnedProcessTree: async (pid: number) => {
      if (fault.cleanup) throw new Error('Synthetic unavailable process cleanup');
      return actual.terminateOwnedProcessTree(pid);
    },
  };
});
const services: TerminalService[] = [],
  roots: string[] = [];
afterEach(async () => {
  Object.assign(fault, { write: false, directorySync: false, cleanup: false });
  const result = await Promise.allSettled(services.splice(0).map((service) => service.shutdown()));
  await Promise.all([...pids].map((pid) => terminateOwnedProcessTree(pid)));
  pids.clear();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  const failure = result.find((entry) => entry.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
});
async function setup() {
  const path = await mkdtemp(join(tmpdir(), 'bp-terminal-storage-'));
  roots.push(path);
  const service = new TerminalService(path);
  services.push(service);
  await service.open();
  return { path, service };
}
it('retains the exact live process when creation fails and cleanup is not confirmed', async () => {
  const { path, service } = await setup();
  fault.write = fault.cleanup = true;
  await expect(
    service.create({
      projectId: 'p',
      cwd: path,
      kind: 'shell',
      executable: '/bin/sh',
      args: ['-c', 'read line'],
      operationId: 'failed-live-create',
    }),
  ).rejects.toMatchObject({ code: 'TERMINAL_CLEANUP_UNKNOWN' });
  const retained = service.snapshot();
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({ status: 'running', operationId: 'failed-live-create' });
  expect(retained[0].error).toContain('termination');
  expect(() => process.kill(retained[0].pid!, 0)).not.toThrow();
  fault.write = fault.cleanup = false;
  await service.stop(retained[0].id);
  expect(() => process.kill(retained[0].pid!, 0)).toThrow();
});
it('retains operation identity after a real rename with lost durability acknowledgement', async () => {
  const { path, service } = await setup();
  fault.directorySync = true;
  const input = {
    projectId: 'p',
    cwd: path,
    kind: 'shell' as const,
    executable: '/bin/sh',
    args: ['-c', 'read line'],
    operationId: 'lost-create-ack',
  };
  await expect(service.create(input)).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' });
  const retained = service.snapshot();
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({ status: 'inactive', operationId: 'lost-create-ack' });
  expect(retained[0].pid).toBeUndefined();
  expect(await readFile(join(path, 'terminals', 'catalog.json'), 'utf8')).toContain(
    'lost-create-ack',
  );
  fault.directorySync = false;
  expect((await service.create(input)).id).toBe(retained[0].id);
  expect(service.snapshot()).toHaveLength(1);
});
it('does not roll back an exact Codex binding after it was renamed into the catalog', async () => {
  const { path, service } = await setup();
  const terminal = await service.create({
    projectId: 'p',
    cwd: path,
    kind: 'codex',
    executable: '/bin/sh',
    args: ['-c', 'read line'],
  });
  fault.directorySync = true;
  await expect(service.bindSession(terminal.id, 'exact-bound-id')).rejects.toMatchObject({
    code: 'UNKNOWN_RESULT',
  });
  expect(service.snapshot()[0].harnessSessionId).toBe('exact-bound-id');
  const disk = JSON.parse(await readFile(join(path, 'terminals', 'catalog.json'), 'utf8'));
  expect(disk.terminals[0].harnessSessionId).toBe('exact-bound-id');
  fault.directorySync = false;
  expect((await service.bindSession(terminal.id, 'exact-bound-id')).harnessSessionId).toBe(
    'exact-bound-id',
  );
  await expect(service.bindSession(terminal.id, 'other-id')).rejects.toMatchObject({
    code: 'TERMINAL_SESSION_CONFLICT',
  });
});
it('rejects a failed cwd checkpoint and reconciles a renamed checkpoint without false launch-cwd fallback', async () => {
  const { path, service } = await setup();
  const nested = join(path, 'nested folder');
  await mkdir(nested);
  const terminal = await service.create({
    projectId: 'p',
    cwd: path,
    kind: 'shell',
    executable: '/bin/sh',
    args: ['-c', `cd '${nested.replaceAll("'", "'\\''")}'; printf 'CWD_READY\\n'; read line`],
  });
  const deadline = Date.now() + 3000;
  while (!(await service.screen(terminal.id)).content.includes('CWD_READY')) {
    if (Date.now() > deadline) throw new Error('The real PTY did not change cwd.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fault.write = true;
  await expect(service.currentCwd(terminal.id)).rejects.toMatchObject({
    code: 'TERMINAL_STORAGE_FAILED',
  });
  expect(service.snapshot()[0].cwd).toBe(await realpath(path));
  fault.write = false;
  fault.directorySync = true;
  await expect(service.currentCwd(terminal.id)).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' });
  const canonical = await realpath(nested);
  expect(service.snapshot()[0].cwd).toBe(canonical);
  const catalog = JSON.parse(await readFile(join(path, 'terminals', 'catalog.json'), 'utf8'));
  expect(catalog.terminals[0].cwd).toBe(canonical);
  fault.directorySync = false;
  expect(await service.currentCwd(terminal.id)).toBe(canonical);
  expect(service.snapshot()).toHaveLength(1);
});
it('keeps a failed removal actionable and removes the ended terminal after Retry without restarting it', async () => {
  const { path, service } = await setup();
  const terminal = await service.create({
    projectId: 'p',
    cwd: path,
    kind: 'shell',
    executable: '/bin/sh',
    args: ['-c', 'read line'],
  });
  fault.write = true;
  await expect(service.stop(terminal.id)).rejects.toBeDefined();
  expect(service.snapshot()).toEqual([
    expect.objectContaining({
      id: terminal.id,
      status: 'exited',
      error: expect.stringContaining('removed'),
    }),
  ]);
  expect(() => process.kill(terminal.pid!, 0)).toThrow();
  fault.write = false;
  await service.stop(terminal.id);
  expect(service.snapshot()).toEqual([]);
  expect(
    JSON.parse(await readFile(join(path, 'terminals', 'catalog.json'), 'utf8')).terminals,
  ).toEqual([]);
  await expect(readFile(join(path, 'terminals', `${terminal.id}.json`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
