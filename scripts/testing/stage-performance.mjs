import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const task = resolve('.tmp/tasks/stage-completion-20261011');
await mkdir(task, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'bp-stage-performance-'));
const data = join(root, 'data'),
  project = join(root, 'project');
await Promise.all([data, project].map((path) => mkdir(path)));
try {
  await build({
    entryPoints: [resolve('src/runtime/store.ts')],
    outfile: join(root, 'store.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  const { Store } = await import(pathToFileURL(join(root, 'store.mjs')).href);
  const store = new Store(data);
  const registered = await store.register(project);
  const originSession = { harness: 'codex', sessionId: randomUUID() };
  const created = await store.create({
    projectId: registered.id,
    kind: 'projector',
    title: 'Performance plan 00',
    originSession,
    operationId: randomUUID(),
  });
  const source =
    '# Performance document\n\n' +
    Array.from(
      { length: 20 },
      (_, i) =>
        `Planning context ${i}: permissions, recovery, ownership and explicit acceptance must remain consistent across revisions.\n\n<TextAnswer id="answer${i}" meaning="Decision ${i}" semanticsVersion="1" defaultValue="" />`,
    ).join('\n\n');
  await writeFile(join(created.sourcePath, 'plan.mdx'), source);
  const published = await store.publish({
    artifactId: created.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  });
  const template = await store.revision(created.artifactId, published.revisionId);
  const write = async (path, value) => {
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  };
  const artifacts = [];
  // Setup expands production parser output into valid immutable manifests. All measured
  // operations run the normal Store/runtime/UI; fixture generation is not a timing oracle.
  for (let a = 0; a < 50; a++) {
    const id = a === 0 ? created.artifactId : randomUUID();
    const revisions = Array.from({ length: 10 }, (_, r) =>
      r === 0 && a === 0
        ? published.revisionId
        : `${String(r + 1).padStart(6, '0')}-${randomUUID()}`,
    );
    const base = join(project, '.projector', 'artifacts', id);
    const values = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`answer${i}`, `Plan ${a} decision ${i}`]),
    );
    const answers = Object.fromEntries(
      revisions.map((revisionId) => [
        id + ':' + revisionId,
        { artifactId: id, revisionId, values },
      ]),
    );
    const paragraphs = template.blocks.filter((block) => block.type === 'paragraph');
    const annotations = Array.from({ length: 20 }, (_, i) => ({
      id: randomUUID(),
      artifactId: id,
      revisionId: revisions[9],
      quote: `Planning context ${i}`,
      prefix: '',
      suffix: ': permissions',
      blockId: paragraphs[i].id,
      anchor: {
        start: { blockId: paragraphs[i].id, path: [0], offset: 0 },
        end: { blockId: paragraphs[i].id, path: [0], offset: `Planning context ${i}`.length },
      },
      comment: `Review decision ${i} for plan ${a}`,
      kind: 'text',
    }));
    await write(join(base, 'artifact.json'), {
      formatVersion: 1,
      id,
      projectId: registered.id,
      title: `Performance plan ${String(a).padStart(2, '0')}`,
      kind: 'projector',
      originSession,
    });
    await mkdir(join(base, 'source'), { recursive: true });
    await writeFile(join(base, 'source', 'plan.mdx'), source);
    for (const revisionId of revisions) {
      await write(join(base, 'revisions', revisionId, 'manifest.json'), {
        ...template,
        id: revisionId,
        artifactId: id,
      });
      await writeFile(join(base, 'revisions', revisionId, 'plan.mdx'), source);
      await write(join(data, 'states', id, revisionId + '.json'), { values });
      await write(join(data, 'baselines', id, revisionId + '.json'), { values });
    }
    await write(join(data, 'artifact-drafts', id + '.json'), { answers, annotations });
    let previousSavedStateId = null;
    for (let s = 0; s < 10; s++) {
      const savedId = `${String(s + 1).padStart(6, '0')}-${randomUUID()}`;
      const saved = {
        formatVersion: 1,
        id: savedId,
        artifactId: id,
        revisionId: revisions[9],
        originSession,
        createdAt: new Date().toISOString(),
        previousSavedStateId,
        answers,
        annotations: annotations.map((item, i) => ({
          ...item,
          number: i + 1,
          text: item.quote,
          annotation: item.comment,
          source: {
            artifactId: id,
            revisionId: item.revisionId,
            kind: 'text',
            blockId: item.blockId,
            anchor: item.anchor,
            prefix: item.prefix,
            suffix: item.suffix,
          },
        })),
        attachments: [],
        notification: `Performance fixture state ${savedId}`,
        implementationAuthorized: false,
      };
      await write(join(base, 'states', savedId, 'state.json'), saved);
      await writeFile(join(base, 'states', savedId, 'context.md'), store.states.context(saved));
      previousSavedStateId = savedId;
    }
    artifacts.push({
      id,
      revisionId: revisions[9],
      title: `Performance plan ${String(a).padStart(2, '0')}`,
    });
  }
  // Validate through production readers, including all saved states and revision identities.
  const read = await store.artifacts();
  if (read.length !== 50 || read.some((a) => a.revisions.length !== 10))
    throw Error('Invalid performance fixture revisions');
  for (const artifact of read)
    if ((await store.states.list(artifact.id)).length !== 10)
      throw Error('Invalid performance fixture states');
  store.close();
  await write(join(root, 'fixture.json'), { artifacts, projectId: registered.id });
  const config = join(task, `performance-${basename(root)}.config.ts`);
  await writeFile(
    config,
    `import { defineConfig } from '@playwright/test';\nexport default defineConfig({testDir:${JSON.stringify(resolve('tests/e2e'))},testMatch:'stage-performance.spec.ts',workers:1,timeout:600000,globalSetup:${JSON.stringify(resolve('tests/e2e/window-audit-setup.ts'))},globalTeardown:${JSON.stringify(resolve('tests/e2e/window-audit-teardown.ts'))},outputDir:${JSON.stringify(join(task, `performance-results-${basename(root)}`))},use:{trace:'retain-on-failure'}});\n`,
  );
  const child = spawn('pnpm', ['exec', 'playwright', 'test', '--config', config], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PROJECTOR_E2E_BACKGROUND: '1',
      PROJECTOR_PERFORMANCE_ROOT: root,
      PROJECTOR_PERFORMANCE_DIAGNOSE_TABS: process.argv.includes('--diagnose-tabs') ? '1' : '0',
      PROJECTOR_PERFORMANCE_REPORT: join(
        task,
        process.argv.includes('--diagnose-tabs')
          ? 'performance-tab-diagnostic.json'
          : 'performance-report.json',
      ),
    },
  });
  const cancel = () => child.kill('SIGINT');
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const code = await new Promise((done) => child.once('exit', (code) => done(code ?? 1)));
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  process.exitCode = code;
  if (code) console.error(`Performance qualification failed; evidence: ${task}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
