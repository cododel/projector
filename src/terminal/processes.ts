import { execFile } from '../shared/observed-exec';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  started: string;
}
async function processes(): Promise<ProcessIdentity[]> {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout
    .trim()
    .split('\n')
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return match
        ? [
            {
              pid: Number(match[1]),
              parent: Number(match[2]),
              group: Number(match[3]),
              started: match[4],
            },
          ]
        : [];
    });
}
/** PIDs are accepted only from task-owned PTY creation, never from renderer input. */
export async function terminateOwnedProcessTree(pid: number) {
  if (process.platform === 'win32') {
    await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 });
    return;
  }
  let discoveryError: unknown;
  let owned: ProcessIdentity[] = [];
  try {
    const rows = await processes();
    // The PTY owns a fresh process group. Its leader may already have exited after a
    // service crash, leaving group members reparented outside the original ancestry.
    const ids = new Set([pid, ...rows.filter((row) => row.group === pid).map((row) => row.pid)]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows)
        if (ids.has(row.parent) && !ids.has(row.pid)) {
          ids.add(row.pid);
          changed = true;
        }
    }
    owned = rows.filter((row) => ids.has(row.pid)).reverse();
  } catch (error) {
    discoveryError = error;
  }
  for (const row of owned) if (row.pid !== pid) signal(row.pid, 'SIGTERM');
  if (owned.some((row) => row.group === pid)) signal(-pid, 'SIGTERM');
  else if (discoveryError) signal(-pid, 'SIGTERM');
  await delay(100);
  // Recheck identity before escalation; a stopped shell's PID must not be applied
  // blindly to a different process that appeared during the grace period.
  if (!discoveryError) {
    const current = await processes();
    for (const row of owned) {
      const live = current.find((candidate) => candidate.pid === row.pid);
      if (live?.started === row.started && live.group === row.group) signal(row.pid, 'SIGKILL');
    }
    // Each revalidated member has already received SIGKILL. Repeating a group
    // signal from the same stale snapshot can hit a reaped/zombie macOS group
    // and return EPERM after successful cleanup.
  }
  if (discoveryError)
    throw new Error(
      'Terminal process group stopped, but descendant cleanup could not be verified.',
    );
}

/** Reads only a live PTY owned by the terminal service; no shell hooks or commands. */
export async function readOwnedProcessWorkingDirectory(pid: number): Promise<string> {
  if (process.platform !== 'darwin')
    throw new Error('Live terminal working-directory discovery is qualified only on macOS.');
  const before = (await processes()).find((row) => row.pid === pid);
  if (!before) throw new Error('The terminal process is no longer running.');
  const { stdout } = await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-F0pn'], {
    timeout: 2000,
    maxBuffer: 64 * 1024,
  });
  const fields = stdout.split('\0').map((field) => field.replace(/^\n/, ''));
  const names = fields.filter((field) => field.startsWith('n')).map((field) => field.slice(1));
  const after = (await processes()).find((row) => row.pid === pid);
  if (
    !after ||
    before.started !== after.started ||
    before.group !== after.group ||
    before.parent !== after.parent ||
    !fields.includes(`p${pid}`) ||
    names.length !== 1
  )
    throw new Error('The terminal process identity changed during working-directory discovery.');
  return names[0];
}
