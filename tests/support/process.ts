import {
  spawn as nativeSpawn,
  execFile as nativeExecFile,
  spawnSync as nativeSpawnSync,
} from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';
import { observeChild, diagnostic } from '../../src/shared/test-diagnostics';
/** Forward native overloads; observe without replacing protocol output. */
export const spawn = ((...args: Parameters<typeof nativeSpawn>) => {
  const [command, argv, original] = args;
  const options = {
    ...original,
    env: {
      ...(original?.env ?? process.env),
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) => key.startsWith('PROJECTOR_TEST_') && value !== undefined,
        ),
      ),
    },
  };
  if (options.env.FORCE_COLOR) delete options.env.NO_COLOR;
  if (options.stdio === 'ignore') options.stdio = 'pipe';
  const child = nativeSpawn(command, argv, options);
  observeChild(child, /(?:^|\/)codex$/.test(command) ? 'codex-cli' : 'test-child', options.env);
  return child;
}) as typeof nativeSpawn;
export const execFile = ((...args: Parameters<typeof nativeExecFile>) => {
  const parameters: unknown[] = [...args];
  const index = parameters.findIndex(
    (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
  );
  if (index >= 0) {
    const options = parameters[index] as import('node:child_process').ExecFileOptions;
    const env = {
      ...(options.env ?? process.env),
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) => key.startsWith('PROJECTOR_TEST_') && value !== undefined,
        ),
      ),
    };
    if (env.FORCE_COLOR) delete env.NO_COLOR;
    parameters[index] = { ...options, env };
  }
  const child = Reflect.apply(nativeExecFile, undefined, parameters);
  observeChild(child, 'test-child', index >= 0 ? (parameters[index] as import('node:child_process').ExecFileOptions).env : undefined);
  return child;
}) as typeof nativeExecFile;

Object.defineProperty(execFile, promisify.custom, {
  value: (...args: Parameters<typeof nativeExecFile>) => {
    const operation = Reflect.apply(promisify(nativeExecFile), undefined, args) as Promise<{
      stdout: string | Buffer;
      stderr: string | Buffer;
    }> & { child: ChildProcess };
    const options = args.find(value => value !== null && typeof value === 'object' && !Array.isArray(value)) as import('node:child_process').ExecFileOptions | undefined;
    observeChild(operation.child, 'test-child', options?.env);
    return operation;
  },
});

export const spawnSync = ((...args: Parameters<typeof nativeSpawnSync>) => {
  const result = Reflect.apply(nativeSpawnSync, undefined, args) as ReturnType<
    typeof nativeSpawnSync
  >;
  const options = args.find(value => value !== null && typeof value === 'object' && !Array.isArray(value)) as import('node:child_process').SpawnSyncOptions | undefined;
  const context = {...process.env, ...options?.env,
    PROJECTOR_TEST_DIAGNOSTICS:process.env.PROJECTOR_TEST_DIAGNOSTICS,
    PROJECTOR_TEST_ID:process.env.PROJECTOR_TEST_ID,PROJECTOR_TEST_RUN_ID:process.env.PROJECTOR_TEST_RUN_ID};
  if (result.stdout?.length)
    diagnostic('test-child', 'stdout', String(result.stdout), 'info', {
      pid: result.pid || undefined, context,
    });
  if (result.stderr?.length)
    diagnostic('test-child', 'stderr', String(result.stderr), 'error', {
      pid: result.pid || undefined, context,
    });
  if (result.error)
    diagnostic('test-child', 'launch-error', result.error.message, 'error', {
      pid: result.pid || undefined, context,
    });
  if (result.status !== 0)
    diagnostic(
      'test-child',
      'process-exit',
      `code=${result.status} signal=${result.signal}`,
      'error',
      { pid: result.pid || undefined, context },
    );
  return result;
}) as typeof nativeSpawnSync;
