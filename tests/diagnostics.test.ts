import { afterEach, expect, it } from 'vitest';
import { nativeDiagnosticOrigin } from '../src/shared/test-diagnostics';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticCollector, type DiagnosticEvent } from './support/diagnostics';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'projector-diagnostics-'));
  roots.push(directory);
  const collector = new DiagnosticCollector({ testId: 'functional-success', directory });
  const event = (overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({
    version: 1,
    id: randomUUID(),
    runId: collector.runId,
    testId: collector.testId,
    role: 'main',
    pid: process.pid,
    phase: 'action',
    kind: 'uncaughtException',
    message: 'DISK_FULL',
    level: 'error',
    ...overrides,
  });
  return { collector, event };
}
const expected = {
  role: 'main',
  kind: 'uncaughtException',
  phase: 'action',
  message: 'DISK_FULL',
  count: 1,
};

it('fails an otherwise successful scenario when the process emitted an error', () => {
  const { collector, event } = setup();
  expect(2 + 2).toBe(4);
  collector.append(event());
  expect(() => collector.assertClean()).toThrow(
    'Unexpected error [main/uncaughtException/action]: DISK_FULL',
  );
});
it('requires declarations before the fault and exactly the declared count', () => {
  const { collector, event } = setup();
  collector.expect(expected);
  expect(() => collector.assertClean()).toThrow('expected 1, received 0');
  collector.append(event());
  collector.assertClean();
  collector.append(event());
  expect(() => collector.assertClean()).toThrow('expected 1, received 2');
  const earlier = setup();
  earlier.collector.append(earlier.event());
  earlier.collector.expect(expected);
  expect(() => earlier.collector.assertClean()).toThrow('Unexpected error');
});
it.each([
  { role: 'bridge' },
  { kind: 'stderr' },
  { phase: 'cleanup' },
  { message: 'PERMISSION_DENIED' },
])('does not authorize a different diagnostic dimension: %j', (overrides) => {
  const { collector, event } = setup();
  collector.expect(expected);
  collector.append(event(overrides));
  expect(() => collector.assertClean()).toThrow('Unexpected error');
});
it('supports bounded message patterns without stateful regex matching or overlapping grants', () => {
  const { collector, event } = setup();
  collector.expect({ ...expected, message: /^DISK_FULL$/g, count: 2 });
  collector.append(event());
  collector.append(event());
  collector.assertClean();
  collector.expect({ ...expected, message: /^DISK_FULL$/ });
  collector.append(event());
  expect(() => collector.assertClean()).toThrow('Ambiguous expected diagnostic');
});
it('retains external failures while requiring explicit scenario expectations when specified', () => {
  const { collector, event } = setup();
  collector.append(event({ external: true, role: 'external-browser' }));
  collector.assertClean();
  expect(collector.events()).toHaveLength(1);
  collector.expect({ ...expected, role: 'pty-command', external: true });
  expect(() => collector.assertClean()).toThrow('expected 1, received 0');
  collector.append(event({ external: true, role: 'pty-command' }));
  collector.assertClean();
});
it('deduplicates forwarded identity but rejects conflicting payloads', () => {
  const { collector, event } = setup();
  collector.expect(expected);
  const diagnostic = event();
  collector.append(diagnostic);
  collector.append(diagnostic);
  collector.assertClean();
  expect(collector.events()).toHaveLength(1);
  collector.append({ ...diagnostic, message: 'different failure' });
  expect(() => collector.assertClean()).toThrow('Conflicting diagnostic event');
});
it.each(['missing', 'truncated', 'malformed', 'invalid', 'unbound'])(
  'fails closed for %s journals',
  (failure) => {
    const { collector, event } = setup();
    if (failure === 'missing') unlinkSync(collector.path);
    else if (failure === 'truncated') appendFileSync(collector.path, JSON.stringify(event()));
    else if (failure === 'malformed') appendFileSync(collector.path, '{broken}\n');
    else if (failure === 'invalid') appendFileSync(collector.path, '{}\n');
    else collector.append(event({ testId: 'another-test' }));
    expect(() => collector.assertClean()).toThrow();
  },
);
it('does not swallow unknown owned warnings or diagnostics on stderr', () => {
  const { collector, event } = setup();
  collector.append(event({ level: 'warning', kind: 'stderr', message: 'unknown warning' }));
  expect(() => collector.assertClean()).toThrow('Unexpected warning');
});
it('writes phase changes atomically and scopes environment restoration', () => {
  const { collector } = setup();
  const before = { ...process.env };
  const restore = collector.installEnvironment();
  try {
    expect(process.env.PROJECTOR_TEST_DIAGNOSTICS).toBe(collector.path);
    collector.phase('cleanup');
    expect(readFileSync(`${collector.path}.phase`, 'utf8')).toBe('cleanup');
  } finally {
    restore();
  }
  for (const key of Object.keys(collector.env)) expect(process.env[key]).toBe(before[key]);
});
it('catches errors emitted after assertions during cleanup drain', async () => {
  const { collector, event } = setup();
  const pending = setTimeout(() => collector.append(event({ phase: 'cleanup' })), 5);
  try {
    await expect(collector.drain({ quietMs: 20 })).rejects.toThrow('Unexpected error');
  } finally {
    clearTimeout(pending);
  }
});

it('rejects a journal erased after its observer was initialized', () => {
  const { collector } = setup();
  writeFileSync(collector.path, '');
  expect(() => collector.assertClean()).toThrow('Diagnostic journal lost its initialization record');
});

it('attributes Chromium GPU pipe diagnostics to their native source instead of the host PID', () => {
  const line = '[85219:1013/033836.090418:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:370] SharedImageManager::ProduceOverlay: Trying to Produce a Overlay representation from a non-existent mailbox.';
  expect(nativeDiagnosticOrigin('main', 85218, line)).toEqual({role:'electron-gpu',pid:85219});
  expect(nativeDiagnosticOrigin('codex', 85218, line)).toEqual({role:'codex',pid:85218});
  expect(nativeDiagnosticOrigin('main', 85218, 'Error is arbitrary text')).toEqual({role:'main',pid:85218});
});

it('links explicit cross-process forwarding to a primary error and rejects unbound references', () => {
  const {collector,event} = setup();
  collector.expect(expected);
  const primary = event({pid:100});
  collector.append(primary);
  collector.append(event({pid:200,role:'ipc-proxy',kind:'forwarded-error',level:'info',forwardedFrom:primary.id}));
  expect(() => collector.assertClean()).not.toThrow();
  collector.append(event({pid:200,role:'ipc-proxy',kind:'forwarded-error',level:'info',forwardedFrom:'missing-primary'}));
  expect(() => collector.assertClean()).toThrow('Unbound forwarded diagnostic');
});
