import { test, expect } from './test';
import { spawn } from '../support/process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { markChildStop } from '../../src/shared/test-diagnostics';
import type { DiagnosticEvent } from '../support/diagnostics';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

// A nested runner is the real gate boundary: passing functional assertions must
// still yield a failing exit status when diagnostics contain an unexpected fault.
const cases = [
  {
    name: 'startup-before-ready main error',
    role: 'main',
    kind: 'console-error',
    startup: true,
    action: '',
    message: 'META_STARTUP_BEFORE_READY false',
  },
  {
    name: 'document-frame unhandled rejection',
    role: 'document',
    kind: 'console-error',
    action: `
      const artifact = await openPlan();
      const frame = page.frameLocator('iframe');
      await expect(frame.getByRole('heading', {name:'Actual document boundary',exact:true})).toBeVisible();
      await frame.locator('body').evaluate(() => { void Promise.reject(new Error('META_DOCUMENT_REJECTION')); });
      await expect.poll(() => diagnostics.events().some(event => event.role === 'document' && event.message.includes('META_DOCUMENT_REJECTION'))).toBe(true);
    `,
    message: 'META_DOCUMENT_REJECTION',
  },
  {
    name: 'owned browser overlay console error',
    role: 'overlay',
    kind: 'console-error',
    action: `
      const artifact = await openPlan();
      server = createServer((_request,response) => { response.setHeader('Content-Type','text/html'); response.end('<!doctype html><title>Actual overlay boundary</title><h1>Native fixture page</h1>'); });
      await new Promise<void>(done => server!.listen(0,'127.0.0.1',done));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing native fixture address');
      await mcp!.tool('show_content',{artifactId:artifact.artifactId,url:'http://127.0.0.1:'+address.port+'/'});
      await expect(page.getByRole('button',{name:'Annotate browser',exact:true})).toBeEnabled();
      await page.getByRole('button',{name:'Annotate browser',exact:true}).click();
      await expect.poll(() => app.context().pages().filter(candidate => candidate.url().startsWith('data:text/html;base64,')).length).toBe(1);
      const overlay = app.context().pages().find(candidate => candidate.url().startsWith('data:text/html;base64,'))!;
      await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
      await overlay.evaluate(() => console.error('META_OWNED_OVERLAY_ERROR'));
    `,
    message: 'META_OWNED_OVERLAY_ERROR',
  },
  {
    name: 'main console error',
    role: 'main',
    kind: 'console-error',
    action: "await app.evaluate(() => console.error('META_MAIN_ERROR'));",
    message: 'META_MAIN_ERROR',
  },
  {
    name: 'shell console error',
    role: 'shell',
    kind: 'console-error',
    action: "await page.evaluate(() => console.error('META_SHELL_ERROR'));",
    message: 'META_SHELL_ERROR',
  },
  {
    name: 'post-assertion cleanup error',
    role: 'main',
    kind: 'console-error',
    action: 'cleanupError = true;',
    message: 'META_CLEANUP_ERROR',
    phase: 'cleanup',
  },
  {
    name: 'early child unhandled rejection',
    role: 'diagnostic-child',
    kind: 'uncaught-exception',
    action: `
      const probe = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`import { installProcessDiagnostics } from ${JSON.stringify(resolve('src/shared/test-diagnostics.ts'))}; installProcessDiagnostics('diagnostic-child'); Promise.reject(new Error('META_UNHANDLED_REJECTION'));`)}], {stdio:'pipe'});
      await new Promise<void>(done => probe.once('close', () => done()));
    `,
    message: 'META_UNHANDLED_REJECTION',
  },
  {
    name: 'terminal service crash',
    role: 'terminal-service',
    kind: 'process-exit',
    action: `
      await expect.poll(() => diagnostics.events().some(event => event.role === 'terminal-service' && event.kind === 'process-start')).toBe(true);
      const service = diagnostics.events().find(event => event.role === 'terminal-service' && event.kind === 'process-start');
      process.kill(service!.pid, 'SIGKILL');
      await expect.poll(() => diagnostics.events().some(event => event.role === 'terminal-service' && event.kind === 'process-exit' && event.message === 'code=9')).toBe(true);
    `,
    message: 'code=9',
  },
  {
    name: 'terminal service crash during Quit',
    role: 'terminal-service',
    kind: 'process-exit',
    phase: 'cleanup',
    action: `
      await expect.poll(() => diagnostics.events().some(event => event.role === 'terminal-service' && event.kind === 'process-start')).toBe(true);
      const service = diagnostics.events().find(event => event.role === 'terminal-service' && event.kind === 'process-start');
      await app.evaluate(({app}, pid) => { app.once('before-quit', () => process.kill(pid, 'SIGKILL')); }, service!.pid);
    `,
    message: 'code=9',
  },
  {
    name: 'runtime service crash',
    role: 'runtime',
    kind: 'process-exit',
    action: `
    await expect.poll(() => diagnostics.events().some(event => event.role === 'runtime' && event.kind === 'process-start')).toBe(true);
    const runtime = diagnostics.events().find(event => event.role === 'runtime' && event.kind === 'process-start');
    process.kill(runtime!.pid, 'SIGKILL');
    await expect.poll(() => diagnostics.events().some(event => event.role === 'runtime' && event.kind === 'process-exit' && event.message === 'code=9')).toBe(true);
  `,
    message: 'code=9',
  },
] as const;

for (const scenario of cases)
  test(`unexpected ${scenario.name} fails the runner despite functional success`, async ({
    diagnostics,
  }) => {
    test.setTimeout(180_000);
    await mkdir(resolve('.tmp/diagnostic-meta'), { recursive: true });
    const root = await mkdtemp(resolve('.tmp/diagnostic-meta/case-'));
    const output = join(root, 'events.json');
    const fixture = resolve('tests/e2e/test.ts');
    const config = join(root, 'playwright.config.ts');
    let entry = resolve('.');
    if ('startup' in scenario) {
      const source = join(root, 'startup-main.ts');
      entry = join(root, 'startup-main.mjs');
      await writeFile(
        source,
        `
import { app } from 'electron';
import { installProcessDiagnostics } from ${JSON.stringify(resolve('src/shared/test-diagnostics.ts'))};
installProcessDiagnostics('main');
app.setAppPath(${JSON.stringify(resolve('.'))});
console.error('META_STARTUP_BEFORE_READY', app.isReady());
await import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});
`,
      );
      await build({
        entryPoints: [source],
        outfile: entry,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        external: ['electron', 'file://*'],
      });
    }
    await writeFile(
      config,
      `import { defineConfig } from ${JSON.stringify(resolve('node_modules/@playwright/test/index.mjs'))};
export default defineConfig({testDir: ${JSON.stringify(root)},testMatch:'nested.spec.ts',workers:1,retries:0,timeout:60000,reporter:'list',outputDir:${JSON.stringify(join(root, 'results'))}});
`,
    );
    await writeFile(
      join(root, 'nested.spec.ts'),
      `
import { test, expect, electron } from ${JSON.stringify(fixture)};
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from ${JSON.stringify(resolve('tests/support/process.ts'))};
import { Mcp } from ${JSON.stringify(resolve('tests/e2e/mcp.ts'))};
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
test('functional behavior passes while diagnostics fail', async ({diagnostics}) => {
  const data = ${JSON.stringify(join(root, 'data'))};
  const home = ${JSON.stringify(join(root, 'home'))};
  await mkdir(data); await mkdir(home);
  const descriptor = ${JSON.stringify(join(root, 'runtime.json'))};
  const app = await electron.launch({args:[${JSON.stringify(entry)}],env:{...process.env,PROJECTOR_DATA:data,CODEX_HOME:home,PROJECTOR_RUNTIME_DESCRIPTOR:descriptor,PROJECTOR_E2E_CODEX_EXECUTABLE:${JSON.stringify(resolve('tests/fixtures/codex-cli.mjs'))},CODEX_FIXTURE_EMPTY:'1'}});
  let cleanupError = false;
  let mcp: Mcp | undefined, server: Server | undefined;
  try {
    const page = await app.firstWindow();
    async function openPlan() {
      const project = ${JSON.stringify(join(root, 'project'))};
      await mkdir(project);
      await app.evaluate(({dialog},path) => { dialog.showOpenDialog = async () => ({canceled:false,filePaths:[path]}); },project);
      await page.getByRole('button',{name:'+ Open project folder',exact:true}).click();
      mcp = new Mcp(descriptor); await mcp.initialize();
      const context = await mcp.tool('get_projector_context',{});
      const artifact = await mcp.tool('create_artifact',{projectId:(context.project as {id:string}).id,kind:'projector',title:'Actual document boundary',originSession:{harness:'codex',sessionId:'meta-document-session'},operationId:randomUUID()});
      await writeFile(join(String(artifact.sourcePath),'plan.mdx'),'# Actual document boundary');
      const revision = await mcp.tool('publish_artifact',{artifactId:artifact.artifactId,expectedLatestRevision:null,operationId:randomUUID()});
      await mcp.tool('show_artifact',{artifactId:artifact.artifactId,revisionId:revision.revisionId});
      return artifact;
    }
    await expect(page.getByRole('button', {name:'Open project folder',exact:true})).toBeVisible();
    await writeFile(${JSON.stringify(join(root, 'functional-passed'))},'yes');
    ${scenario.action}
  } finally {
    diagnostics.phase('cleanup');
    mcp?.close();
    if (server) await new Promise<void>((done,reject) => server!.close(error => error ? reject(error) : done()));
    if (cleanupError) await app.evaluate(() => console.error('META_CLEANUP_ERROR'));
    try { await app.close(); }
    finally { await writeFile(${JSON.stringify(output)},JSON.stringify(diagnostics.events())); }
  }
});
`,
    );
    diagnostics.expect({
      role: 'test-child',
      kind: 'process-exit',
      phase: 'test',
      message: 'code=1 signal=null',
      count: 1,
    });
    const child = spawn('pnpm', ['exec', 'playwright', 'test', '--config', config], {
      cwd: resolve('.'),
      env: { ...process.env },
      stdio: 'pipe',
    });
    let text = '';
    child.stdout?.on('data', (chunk) => {
      text += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      text += String(chunk);
    });
    try {
      const exit = await new Promise<number | null>((done, reject) => {
        child.once('error', reject);
        child.once('close', done);
      });
      expect(exit, text).toBe(1);
      expect(await readFile(join(root, 'functional-passed'), 'utf8'), text).toBe('yes');
      const events = JSON.parse(await readFile(output, 'utf8')) as DiagnosticEvent[];
      expect(
        events.some(
          (event) =>
            event.role === scenario.role &&
            event.kind === scenario.kind &&
            event.message.includes(scenario.message) &&
            ('phase' in scenario ? event.phase === scenario.phase : true),
        ),
        text,
      ).toBe(true);
      expect(text).toContain('Unexpected error');
      expect(text).not.toContain('No tests found');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        markChildStop(child);
        child.kill('SIGTERM');
        await new Promise<void>((done) => child.once('close', () => done()));
      }
      await rm(root, { recursive: true, force: true });
    }
  });
