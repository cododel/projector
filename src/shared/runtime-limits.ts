import { BlueprintError } from './protocol';

export const LIMITS_VERSION = '1';
/** Wire limits match the validated operation schemas; sizes are bytes unless named otherwise. */
export function runtimeLimits(env: NodeJS.ProcessEnv = process.env) {
  const timeout = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < 100 ||
      Number(raw) > 300000
    )
      throw new BlueprintError(
        'INVALID_CONFIGURATION',
        `${name} must be an integer from 100 to 300000 milliseconds`,
      );
    return Number(raw);
  };
  return {
    version: LIMITS_VERSION,
    documentBytes: 2_000_000,
    imageBase64Characters: 24_000_000,
    requestBytes: 32_000_000,
    readChunkCharacters: 12_000,
    listPageItems: 20,
    compileTimeoutMs: timeout('BLUEPRINT_COMPILE_TIMEOUT_MS', 30_000),
    captureTimeoutMs: timeout('BLUEPRINT_CAPTURE_TIMEOUT_MS', 10_000),
  };
}
