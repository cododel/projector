import { it, expect } from 'vitest';
import { build } from 'esbuild';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { execFile } from '../src/shared/observed-exec';
import { currentDiagnosticRole, drainDiagnosticChildren } from '../src/shared/test-diagnostics';
import { compileDocument } from '../src/runtime/compile';
import { DiagnosticCollector } from './support/diagnostics';
import { diagnostics } from './support/vitest-diagnostics';

it('retains native callback overloads, stdout encoding and stdin input', async () => {
  const stdout = await new Promise<string>((done, reject) => {
    const child = execFile(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      { encoding: 'utf8' },
      (error, stdout, stderr) => (error ? reject(error) : (expect(stderr).toBe(''), done(stdout))),
    );
    expect(child.stdin?.writable).toBe(true);
    child.stdin!.end('native stdin 🙂 Error stays data');
  });
  expect(stdout).toBe('native stdin 🙂 Error stays data');
  const buffer = await new Promise<Buffer>((done, reject) => {
    execFile(
      process.execPath,
      ['-e', 'process.stdout.write("buffer")'],
      { encoding: 'buffer' },
      (error, stdout) => (error ? reject(error) : done(stdout)),
    );
  });
  expect(Buffer.isBuffer(buffer)).toBe(true);
  expect(buffer.toString()).toBe('buffer');
});

it('preserves the native promisified child handle, buffered result and rejection', async () => {
  const execute = promisify(execFile);
  const pending = execute(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)']);
  expect(pending.child.pid).toBeGreaterThan(0);
  pending.child.stdin!.end('promise input');
  await expect(pending).resolves.toEqual({ stdout: 'promise input', stderr: '' });
  const buffered = await execute(
    process.execPath,
    ['-e', 'process.stdout.write("promise buffer")'],
    { encoding: 'buffer' },
  );
  expect(Buffer.isBuffer(buffered.stdout)).toBe(true);
  expect(buffered.stdout.toString()).toBe('promise buffer');
  diagnostics().expect({
    role: `${currentDiagnosticRole()}:command`,
    kind: 'process-exit',
    phase: 'test',
    message: 'code=7 signal=null',
    count: 1,
  });
  await expect(
    execute(process.execPath, ['-e', 'process.stdout.write("before failure"); process.exit(7)']),
  ).rejects.toMatchObject({ code: 7, stdout: 'before failure', stderr: '' });
});

it('records a real compiler worker fault even when the caller catches its rejected result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'projector-worker-diagnostics-'));
  const worker = join(root, 'broken-compiler.cjs');
  const previous = process.env.PROJECTOR_COMPILER;
  const audit = diagnostics();
  try {
    await writeFile(worker, 'throw new Error("CONTROLLED_COMPILER_WORKER_FAILURE");');
    process.env.PROJECTOR_COMPILER = worker;
    audit.expect({
      role: 'compiler',
      kind: 'worker-error',
      phase: 'test',
      message: 'CONTROLLED_COMPILER_WORKER_FAILURE',
      count: 1,
    });
    await expect(compileDocument('# Valid document')).rejects.toMatchObject({
      code: 'BUILD_FAILED',
    });
    const actual = audit
      .events()
      .filter((event) => event.role === 'compiler' && event.kind === 'worker-error');
    expect(actual).toHaveLength(1);
    expect(actual[0].message).toBe('CONTROLLED_COMPILER_WORKER_FAILURE');
    expect(actual[0].workerId).toBeGreaterThan(0);
    // Replay actual boundary evidence, not a synthesized diagnostic or injected oracle.
    const independent = new DiagnosticCollector({
      testId: audit.testId,
      runId: audit.runId,
      directory: root,
    });
    for (const event of actual) independent.append(event);
    expect(() => independent.assertClean()).toThrow(
      'Unexpected error [compiler/worker-error/test]',
    );
  } finally {
    if (previous === undefined) delete process.env.PROJECTOR_COMPILER;
    else process.env.PROJECTOR_COMPILER = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it('links a monitored worker exception to its parent event without counting it twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'projector-monitored-worker-'));
  const previous = process.env.PROJECTOR_COMPILER;
  const worker = join(root, 'worker.cjs');
  const audit = diagnostics();
  try {
    await build({ stdin: { contents: `import { installProcessDiagnostics } from './src/shared/test-diagnostics';
      installProcessDiagnostics('compiler'); throw new Error('MONITORED_WORKER_FAILURE');`,
      resolveDir: resolve('.') }, outfile: worker, bundle: true, platform: 'node', format: 'cjs' });
    process.env.PROJECTOR_COMPILER = worker;
    audit.expect({ role:'compiler',kind:'uncaught-exception',phase:'test',message:'MONITORED_WORKER_FAILURE',count:1 });
    await expect(compileDocument('# Valid')).rejects.toMatchObject({ code: 'BUILD_FAILED' });
    const events = audit.events().filter(event => event.role === 'compiler');
    const primary = events.find(event => event.kind === 'uncaught-exception')!;
    expect(primary.workerId).toBeGreaterThan(0);
    expect(events.filter(event => event.level === 'error')).toHaveLength(1);
    expect(events.find(event => event.kind === 'worker-error')).toMatchObject({
      workerId: primary.workerId, forwardedFrom: primary.id, level: 'info',
    });
  } finally {
    if (previous === undefined) delete process.env.PROJECTOR_COMPILER;
    else process.env.PROJECTOR_COMPILER = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it('attributes unknown raw compiler stdout and stderr to their worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'projector-worker-streams-'));
  const previous = process.env.PROJECTOR_COMPILER;
  const worker = join(root, 'worker.cjs');
  const audit = diagnostics();
  try {
    await writeFile(worker, `const {parentPort} = require('node:worker_threads');
      process.stdout.write('COMPILER_UNKNOWN_STDOUT\\n');
      process.stderr.write('CONTROLLED_WORKER_DIAGNOSTIC\\n', () => parentPort.postMessage({error:'Controlled invalid document'}));`);
    process.env.PROJECTOR_COMPILER = worker;
    audit.expect({role:'compiler',kind:'stderr',phase:'test',message:'CONTROLLED_WORKER_DIAGNOSTIC',count:1});
    audit.expect({role:'compiler',kind:'stdout',phase:'test',message:'COMPILER_UNKNOWN_STDOUT',count:1});
    await expect(compileDocument('# Invalid fixture')).rejects.toMatchObject({code:'INVALID_DOCUMENT'});
    await expect.poll(() => audit.events().find(event => event.role === 'compiler' && event.kind === 'stderr')?.workerId).toBeGreaterThan(0);
    expect(audit.events().find(event => event.role === 'compiler' && event.kind === 'stdout')).toMatchObject({level:'error'});
  } finally {
    if (previous === undefined) delete process.env.PROJECTOR_COMPILER;
    else process.env.PROJECTOR_COMPILER = previous;
    await rm(root, {recursive:true,force:true});
  }
});

it('requires audited Electron fixtures and process launch helpers in every E2E scenario', async () => {
  const directory = resolve('tests/e2e');
  const violations: string[] = [];
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.spec.ts'))) {
    const ast = ts.createSourceFile(
      file,
      await readFile(join(directory, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let auditedTest = false;
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const module = node.moduleSpecifier.text;
        const clause = node.importClause;
        const names =
          clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings.elements
            : [];
        if (module === './test' && names.some((name) => name.name.text === 'test'))
          auditedTest = true;
        if (
          module === '@playwright/test' &&
          !clause?.isTypeOnly &&
          (clause?.name ||
            (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) ||
            names.some(
              (name) =>
                !name.isTypeOnly &&
                ['test', '_electron'].includes(name.propertyName?.text ?? name.name.text),
            ))
        )
          violations.push(`${file}: unaudited Playwright fixture`);
        if (
          ['node:child_process', 'child_process', 'electron'].includes(module) &&
          !clause?.isTypeOnly &&
          (clause?.name ||
            (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) ||
            names.some(
              (name) =>
                !name.isTypeOnly &&
                (module === 'electron' ||
                  [
                    'spawn',
                    'exec',
                    'execFile',
                    'fork',
                    'spawnSync',
                    'execSync',
                    'execFileSync',
                  ].includes(name.propertyName?.text ?? name.name.text)),
            ))
        )
          violations.push(`${file}: native process launcher bypasses diagnostics`);
      }
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
          node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        ['node:child_process', 'child_process', 'electron'].includes(node.arguments[0].text)
      )
        violations.push(`${file}: dynamic native launcher bypasses diagnostics`);
      if (ts.isPropertyAccessExpression(node) && node.name.text === '_electron')
        violations.push(`${file}: direct Electron launcher bypasses diagnostics`);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!auditedTest) violations.push(`${file}: missing audited test fixture`);
  }
  expect(violations).toEqual([]);
});

it('links forwarded stderr once without hiding a later identical error and redacts child-only secrets', async () => {
  const root = await mkdtemp(resolve('.tmp/diagnostic-correlation-'));
  const collector = new DiagnosticCollector({ testId: 'forwarding-boundary', directory: root });
  const restore = collector.installEnvironment();
  const token = 'synthetic-child-only-secret-12345';
  try {
    const { spawn } = await import('./support/process');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { installProcessDiagnostics } from ${JSON.stringify(resolve('src/shared/test-diagnostics.ts'))};
      installProcessDiagnostics('correlation-child');
      console.error('CONTROLLED_DUPLICATE', process.env.CONTROLLED_TOKEN);
      process.stderr.write('CONTROLLED_DUPLICATE '+process.env.CONTROLLED_TOKEN+'\\n');
    `], { env: { ...process.env, CONTROLLED_TOKEN: token }, stdio: 'pipe' });
    await new Promise<void>((done, reject) => { child.once('error', reject); child.once('close', () => done()); });
    const events = collector.events();
    const primary = events.find(event => event.kind === 'console-error')!;
    expect(primary.message).toBe('CONTROLLED_DUPLICATE [REDACTED]');
    expect(events.filter(event => event.kind === 'forwarded-stderr')).toHaveLength(1);
    expect(events.find(event => event.kind === 'forwarded-stderr')!.forwardedFrom).toBe(primary.id);
    expect(events.filter(event => event.kind === 'stderr')).toHaveLength(1);
    expect(await readFile(collector.path, 'utf8')).not.toContain(token);
    expect(() => collector.assertClean()).toThrow('Unexpected error [test-child/stderr/startup]');
  } finally { restore(); await rm(root, { recursive: true, force: true }); }
});

it('preserves native buffered stderr bytes while separately decoding their diagnostics', async () => {
  diagnostics().expect({role:`${currentDiagnosticRole()}:command`,kind:'stderr',phase:'test',message:'\ufffd\ufffd',count:1});
  const result = await promisify(execFile)(process.execPath,['-e','process.stderr.write(Buffer.from([255,128]))'],{encoding:'buffer'});
  expect(Buffer.isBuffer(result.stderr)).toBe(true);
  expect(result.stderr.toString('hex')).toBe('ff80');
});

it('does not let cleanup reclassify a child that already exited unsuccessfully', async () => {
  const root = await mkdtemp(resolve('.tmp/diagnostic-exit-'));
  const collector = new DiagnosticCollector({testId:'already-exited',directory:root});
  const restore = collector.installEnvironment();
  try {
    const {spawn} = await import('./support/process');
    const {markChildStop} = await import('../src/shared/test-diagnostics');
    const child = spawn(process.execPath,['-e','process.exit(7)'],{stdio:'pipe'});
    child.once('exit',() => markChildStop(child));
    await new Promise<void>(done => child.once('close',() => done()));
    expect(() => collector.assertClean()).toThrow('code=7 signal=null');
  } finally {restore();await rm(root,{recursive:true,force:true});}
});

it('redacts child-only secrets in callback, promise, application-command and synchronous helpers', async () => {
  const root = await mkdtemp(resolve('.tmp/diagnostic-env-overloads-'));
  const collector = new DiagnosticCollector({testId:'child-environment-overloads',directory:root});
  const restore = collector.installEnvironment();
  const token = 'synthetic-overload-only-secret-12345';
  const options = {env:{...process.env,CONTROLLED_TOKEN:token}};
  const script = 'process.stderr.write(process.env.CONTROLLED_TOKEN+"\\n");';
  try {
    const audited = await import('./support/process');
    await new Promise<void>((done,reject) => audited.execFile(process.execPath,['-e',script],options,error => error ? reject(error) : done()));
    await promisify(audited.execFile)(process.execPath,['-e',script],options);
    await promisify(execFile)(process.execPath,['-e',script],options);
    audited.spawnSync(process.execPath,['-e',script],options);
    await drainDiagnosticChildren();
    const events = collector.events().filter(event => event.kind==='stderr');
    expect(events).toHaveLength(4);
    expect(events.every(event => event.message.trim()==='[REDACTED]')).toBe(true);
    expect(await readFile(collector.path,'utf8')).not.toContain(token);
  } finally {restore();await rm(root,{recursive:true,force:true});}
});

it('does not authorize a nonzero exit merely because Stop was requested while the child was live', async () => {
  const root = await mkdtemp(resolve('.tmp/diagnostic-requested-stop-'));
  const collector = new DiagnosticCollector({testId:'failed-requested-stop',directory:root});
  const restore = collector.installEnvironment();
  try {
    const {spawn} = await import('./support/process');
    const {markChildStop} = await import('../src/shared/test-diagnostics');
    const child = spawn(process.execPath,['-e','process.on("SIGTERM",()=>process.exit(7));process.stdout.write("READY\\n");setInterval(()=>{},1000);'],{stdio:'pipe'});
    await new Promise<void>((done,reject) => {child.stdout!.once('data',()=>done());child.once('error',reject);});
    markChildStop(child);
    child.kill('SIGTERM');
    await new Promise<void>(done => child.once('close',()=>done()));
    expect(() => collector.assertClean()).toThrow('code=7 signal=null');
  } finally {restore();await rm(root,{recursive:true,force:true});}
});
