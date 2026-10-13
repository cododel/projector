import { execFile as nativeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { currentDiagnosticRole, observeChild } from './test-diagnostics';

function commandEnvironment(args: readonly unknown[]): NodeJS.ProcessEnv | undefined {
  const options = args.find(value => value !== null && typeof value === 'object' && !Array.isArray(value)) as {env?:NodeJS.ProcessEnv} | undefined;
  return options?.env;
}

/** Preserve Node overloads and its native buffered callback/promise contract. */
export const execFile = ((...args: Parameters<typeof nativeExecFile>) => {
  const child = Reflect.apply(nativeExecFile, undefined, args) as ReturnType<typeof nativeExecFile>;
  if (process.env.PROJECTOR_TEST_DIAGNOSTICS)
    observeChild(child, `${currentDiagnosticRole()}:command`, commandEnvironment(args));
  return child;
}) as typeof nativeExecFile;

const nativePromise = promisify(nativeExecFile);
Object.defineProperty(execFile, promisify.custom, {
  value: (...args: Parameters<typeof nativePromise>) => {
    // Return the original promise: an async wrapper would drop its .child handle.
    const result = Reflect.apply(nativePromise, undefined, args) as ReturnType<
      typeof nativePromise
    >;
    if (process.env.PROJECTOR_TEST_DIAGNOSTICS)
      observeChild(result.child, `${currentDiagnosticRole()}:command`, commandEnvironment(args));
    return result;
  },
  configurable: true,
});
