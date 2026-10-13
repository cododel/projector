import { test, expect } from './test';
import { spawn } from '../support/process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { markChildStop } from '../../src/shared/test-diagnostics';

test('Vitest reused worker keeps explicit per-test expectations without stale suite wrappers', async () => {
  await mkdir(resolve('.tmp/unbound-meta'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/unbound-meta/reuse-'));
  const config = join(root, 'vitest.config.ts');
  const setup = resolve('tests/support/vitest-diagnostics.ts');
  await writeFile(
    config,
    `import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:[${JSON.stringify(join(root, '*.test.ts'))}],setupFiles:[${JSON.stringify(setup)}],maxWorkers:1,fileParallelism:false,isolate:false,reporters:['json'],outputFile:${JSON.stringify(join(root, 'report.json'))},silent:true}});`,
  );
  for (const id of ['first', 'second'])
    await writeFile(
      join(root, `${id}.test.ts`),
      `
import { it, expect } from 'vitest';
import { diagnostics } from ${JSON.stringify(setup)};
it(${JSON.stringify(id)}, () => {
  const collector = diagnostics();
  collector.expect({role:'test-runner',kind:'console-error',phase:'test',message:${JSON.stringify(`EXPECTED_${id}`)},count:1});
  console.error(${JSON.stringify(`EXPECTED_${id}`)});
  expect(2+2).toBe(4);
});`,
    );
  const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', config], {
    cwd: resolve('.'),
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: 'pipe',
  });
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('close', done);
    });
    const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) as {
      success: boolean;
      numPassedTests: number;
      numFailedTests: number;
    };
    expect(code).toBe(0);
    expect(report).toMatchObject({ success: true, numPassedTests: 2, numFailedTests: 0 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      markChildStop(child);
      child.kill('SIGTERM');
      await new Promise<void>((done) => child.once('close', () => done()));
    }
    await rm(root, { recursive: true, force: true });
  }
});

for (const runner of ['playwright', 'vitest'] as const)
  for (const hook of ['beforeAll', 'afterAll'] as const)
    test(`${runner} ${hook} console error fails the gate after functional success`, async ({
      diagnostics,
    }) => {
      test.setTimeout(60_000);
      await mkdir(resolve('.tmp/unbound-meta'), { recursive: true });
      const root = await mkdtemp(resolve('.tmp/unbound-meta/case-'));
      const marker = join(root, 'functional-success');
      const message = `UNBOUND_${runner.toUpperCase()}_${hook.toUpperCase()}`;
      const fixture =
        runner === 'playwright'
          ? resolve('tests/e2e/test.ts')
          : resolve('node_modules/vitest/dist/index.js');
      const testFile = join(root, runner === 'playwright' ? 'nested.spec.ts' : 'nested.test.ts');
      await writeFile(
        testFile,
        runner === 'playwright'
          ? `
import { test, expect } from ${JSON.stringify(fixture)};
import { writeFile } from 'node:fs/promises';
test.${hook}(() => console.error(${JSON.stringify(message)}));
test('functional assertions pass', async () => {expect(2+2).toBe(4);await writeFile(${JSON.stringify(marker)},'passed');});
`
          : `
import { it, expect, ${hook} } from 'vitest';
import { writeFile } from 'node:fs/promises';
${hook}(() => console.error(${JSON.stringify(message)}));
it('functional assertions pass', async () => {expect(2+2).toBe(4);await writeFile(${JSON.stringify(marker)},'passed');});
`,
      );
      const config = join(root, `${runner}.config.ts`);
      await writeFile(
        config,
        runner === 'playwright'
          ? `
import { defineConfig } from ${JSON.stringify(resolve('node_modules/@playwright/test/index.mjs'))};
export default defineConfig({testDir:${JSON.stringify(root)},testMatch:'nested.spec.ts',workers:1,retries:0,reporter:'json',outputDir:${JSON.stringify(join(root, 'results'))}});
`
          : `
import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:[${JSON.stringify(testFile)}],setupFiles:[${JSON.stringify(resolve('tests/support/vitest-diagnostics.ts'))}],reporters:['json'],outputFile:${JSON.stringify(join(root, 'report.json'))},silent:true}});
`,
      );
      diagnostics.expect({
        role: 'test-child',
        kind: 'process-exit',
        phase: 'test',
        message: 'code=1 signal=null',
        count: 1,
      });
      const args =
        runner === 'playwright'
          ? ['exec', 'playwright', 'test', '--config', config]
          : ['exec', 'vitest', 'run', '--config', config];
      const child = spawn('pnpm', args, {
        cwd: resolve('.'),
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: 'pipe',
      });
      let stdout = '';
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      try {
        const code = await new Promise<number | null>((done, reject) => {
          child.once('error', reject);
          child.once('close', done);
        });
        expect(code, stdout).toBe(1);
        expect(await readFile(marker, 'utf8'), stdout).toBe('passed');
        const report =
          runner === 'vitest' ? await readFile(join(root, 'report.json'), 'utf8') : stdout;
        expect(report).toContain('Unexpected error [test-runner/console-error/unbound]');
        expect(report).toContain(message);
        expect(report).not.toContain('No test files found');
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          markChildStop(child);
          child.kill('SIGTERM');
          await new Promise<void>((done) => child.once('close', () => done()));
        }
        await rm(root, { recursive: true, force: true });
      }
    });
