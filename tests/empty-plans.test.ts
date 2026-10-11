import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, type Store } from '../src/runtime/store';
import { Operations } from '../src/runtime/operations';

let store: Store;
let root: string;
afterEach(async () => {
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
const originSession = { harness: 'codex' as const, sessionId: 'explicit-agent-session' };
const source =
  '# First document\n\n<Choice id="role" meaning="Selected role" semanticsVersion="1" options={["Owner","Member"]} defaultValue="Owner" />';
interface EmptyPlan {
  artifactId: string;
  sourcePath: string;
  sourceFile: string;
}
async function setup() {
  root = await mkdtemp(join(tmpdir(), 'bp-empty-'));
  await mkdir(join(root, 'project'));
  store = await openStore(join(root, 'data'));
  const project = await store.register(join(root, 'project'));
  const ops = new Operations(store, () => {});
  const input = { projectId: project.id, operationId: randomUUID() };
  const plan = (await ops.operator('createEmptyPlan', input)) as EmptyPlan;
  return { project, ops, input, plan };
}
it('creates a durable unbound workspace once, without a fabricated revision or publication', async () => {
  const { ops, input, plan } = await setup();
  expect(await ops.operator('createEmptyPlan', input)).toEqual(plan);
  expect(await store.artifacts()).toHaveLength(1);
  expect(await store.artifact(plan.artifactId)).toMatchObject({
    title: 'Untitled plan',
    originSession: null,
    latestRevision: null,
    revisions: [],
  });
  expect(plan.sourceFile).toBe('plan.mdx');
  expect(await readdir(plan.sourcePath)).toEqual([]);
  expect(await ops.tool('read_artifact', { artifactId: plan.artifactId })).toMatchObject({
    artifactId: plan.artifactId,
    revisionId: null,
    originSession: null,
    sourcePath: plan.sourcePath,
    sourceFile: 'plan.mdx',
    privateStateIncluded: false,
  });
  await expect(
    ops.tool('create_artifact', {
      projectId: input.projectId,
      title: 'Agent draft',
      kind: 'blueprint',
      operationId: randomUUID(),
    }),
  ).rejects.toThrow();
  await expect(
    ops.tool('publish_artifact', {
      artifactId: plan.artifactId,
      expectedLatestRevision: null,
      operationId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'ORIGIN_SESSION_REQUIRED' });
  await expect(
    ops.operator('saveState', {
      artifactId: plan.artifactId,
      revisionId: null,
      expectedLatestSavedStateId: null,
      operationId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'NO_PUBLISHED_REVISION' });
  store.close();
  store = await openStore(join(root, 'data'));
  expect(await store.artifact(plan.artifactId)).toMatchObject({
    originSession: null,
    latestRevision: null,
    revisions: [],
  });
});
it('renames metadata and explicitly attaches the agent session with replay and conflict protection', async () => {
  const { ops, plan } = await setup();
  const rename = {
    artifactId: plan.artifactId,
    title: 'Research workspace',
    operationId: randomUUID(),
  };
  const renamed = await ops.operator('renamePlan', rename);
  expect(await ops.operator('renamePlan', rename)).toEqual(renamed);
  await expect(
    ops.operator('renamePlan', { ...rename, title: 'Different replay' }),
  ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  await expect(
    ops.operator('renamePlan', { ...rename, title: ' ', operationId: randomUUID() }),
  ).rejects.toThrow();
  expect(await store.artifact(plan.artifactId)).toMatchObject({
    title: rename.title,
    latestRevision: null,
    revisions: [],
  });
  const attach = { artifactId: plan.artifactId, originSession, operationId: randomUUID() };
  const attached = await ops.tool('attach_artifact_session', attach);
  expect(await ops.tool('attach_artifact_session', attach)).toEqual(attached);
  await expect(
    ops.tool('attach_artifact_session', {
      ...attach,
      operationId: randomUUID(),
      originSession: { ...originSession, sessionId: 'other-agent' },
    }),
  ).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
  expect(await store.artifact(plan.artifactId)).toMatchObject({
    title: rename.title,
    originSession,
    latestRevision: null,
  });
  store.close();
  store = await openStore(join(root, 'data'));
  expect(await new Operations(store, () => {}).tool('attach_artifact_session', attach)).toEqual(
    attached,
  );
});
it('preserves pre-document browser annotations privately through restart, first publication and Save v2', async () => {
  const { ops, project, plan } = await setup();
  const sibling = (await ops.operator('createEmptyPlan', {
    projectId: project.id,
    operationId: randomUUID(),
  })) as EmptyPlan;
  await mkdir(join(root, 'other-project'));
  const otherProject = await store.register(join(root, 'other-project'));
  const separate = (await ops.operator('createEmptyPlan', {
    projectId: otherProject.id,
    operationId: randomUUID(),
  })) as EmptyPlan;
  await expect(
    ops.tool('show_content', {
      artifactId: plan.artifactId,
      url: 'http://localhost:1234/research',
    }),
  ).resolves.toMatchObject({ status: 'requested' });
  const capture = {
    id: randomUUID(),
    png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    source: {
      kind: 'browser-area' as const,
      url: 'http://localhost:1234/research',
      title: 'Research page',
      capturedAt: new Date().toISOString(),
      viewport: { width: 100, height: 80, deviceScaleFactor: 1 },
      rect: { x: 10, y: 10, width: 20, height: 20 },
      pointer: { x: 29, y: 27 },
      zoomFactor: 1,
      scroll: { x: 0, y: 40 },
      pageId: 'research-navigation',
    },
  };
  const annotationInput = {
    artifactId: plan.artifactId,
    revisionId: null,
    kind: 'browser-area',
    comment: 'Private before the document',
    capture,
  };
  const annotation = await ops.operator('addAreaAnnotation', annotationInput);
  expect(await ops.operator('addAreaAnnotation', annotationInput)).toEqual(annotation);
  expect(
    JSON.stringify(await ops.tool('read_artifact', { artifactId: plan.artifactId })),
  ).not.toContain(annotationInput.comment);
  expect(
    await ops.tool('read_artifact', { artifactId: plan.artifactId, part: 'state' }),
  ).toMatchObject({ savedState: null });
  await expect(
    ops.tool('read_attachment', {
      artifactId: plan.artifactId,
      savedStateId: 'private',
      attachmentId: capture.id,
    }),
  ).rejects.toMatchObject({ code: 'UNKNOWN_SAVED_STATE' });
  store.close();
  store = await openStore(join(root, 'data'));
  const resumed = new Operations(store, () => {});
  expect((await store.states.draft(sibling.artifactId)).annotations).toEqual([]);
  expect((await store.states.draft(separate.artifactId)).annotations).toEqual([]);
  expect((await store.states.draft(plan.artifactId)).annotations).toMatchObject([
    { revisionId: null, comment: annotationInput.comment },
  ]);
  await resumed.tool('attach_artifact_session', {
    artifactId: plan.artifactId,
    originSession,
    operationId: randomUUID(),
  });
  await writeFile(join(plan.sourcePath, plan.sourceFile), source);
  const published = (await resumed.tool('publish_artifact', {
    artifactId: plan.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  })) as { revisionId: string };
  await store.setValue(plan.artifactId, published.revisionId, 'role', 'Member');
  expect(
    await resumed.tool('read_artifact', { artifactId: plan.artifactId, part: 'state' }),
  ).toMatchObject({ savedState: null });
  const saved = (await resumed.operator('saveState', {
    artifactId: plan.artifactId,
    revisionId: published.revisionId,
    expectedLatestSavedStateId: null,
    operationId: randomUUID(),
  })) as { id: string };
  const read = (await resumed.tool('read_artifact', {
    artifactId: plan.artifactId,
    part: 'state',
  })) as { content: string };
  const snapshot = JSON.parse(read.content);
  expect(snapshot).toMatchObject({
    formatVersion: 2,
    originSession,
    annotations: [
      {
        number: 1,
        annotation: annotationInput.comment,
        source: { revisionId: null, attachmentId: capture.id },
      },
    ],
  });
  expect(snapshot.answers[`${plan.artifactId}:${published.revisionId}`].values.role).toBe('Member');
  const image = await store.states.attachment(plan.artifactId, saved.id, capture.id);
  expect(Buffer.from(image.base64, 'base64').toString()).toContain('>1</text>');
  expect(
    await readFile(
      join(
        project.path,
        '.blueprint',
        'artifacts',
        plan.artifactId,
        'states',
        saved.id,
        'state.json',
      ),
      'utf8',
    ),
  ).toContain('"formatVersion": 2');
  expect(await resumed.tool('get_blueprint_context', { projectPath: project.path })).toMatchObject({
    capabilities: { supportedSavedStateVersions: [1, 2] },
  });
  store.close();
  store = await openStore(join(root, 'data'));
  expect(await store.states.read(plan.artifactId, saved.id)).toMatchObject({
    formatVersion: 2,
    annotations: [{ source: { revisionId: null } }],
  });
});
it('keeps document-only saved checkpoints in readable version 1', async () => {
  const { ops, plan } = await setup();
  await ops.tool('attach_artifact_session', {
    artifactId: plan.artifactId,
    originSession,
    operationId: randomUUID(),
  });
  await writeFile(join(plan.sourcePath, plan.sourceFile), source);
  const revision = (await ops.tool('publish_artifact', {
    artifactId: plan.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  })) as { revisionId: string };
  const saved = (await ops.operator('saveState', {
    artifactId: plan.artifactId,
    revisionId: revision.revisionId,
    expectedLatestSavedStateId: null,
    operationId: randomUUID(),
  })) as { id: string };
  store.close();
  store = await openStore(join(root, 'data'));
  expect(await store.states.read(plan.artifactId, saved.id)).toMatchObject({
    formatVersion: 1,
    revisionId: revision.revisionId,
    annotations: [],
  });
});
it('recovers committed metadata receipts after acknowledgement loss without reverting later edits', async () => {
  const { ops, plan } = await setup();
  const attach = { artifactId: plan.artifactId, originSession, operationId: randomUUID() };
  const originalRecord = store.record.bind(store);
  store.record = () => {
    throw new Error('metadata acknowledgement lost');
  };
  try {
    await expect(ops.tool('attach_artifact_session', attach)).rejects.toThrow(
      'metadata acknowledgement lost',
    );
  } finally {
    store.record = originalRecord;
  }
  expect(await store.artifact(plan.artifactId)).toMatchObject({ originSession });
  expect(await ops.tool('attach_artifact_session', attach)).toMatchObject({
    artifactId: plan.artifactId,
  });
  const rename = { artifactId: plan.artifactId, title: 'First edit', operationId: randomUUID() };
  store.record = () => {
    throw new Error('metadata acknowledgement lost');
  };
  try {
    await expect(ops.operator('renamePlan', rename)).rejects.toThrow(
      'metadata acknowledgement lost',
    );
  } finally {
    store.record = originalRecord;
  }
  expect(await store.artifact(plan.artifactId)).toMatchObject({ title: 'First edit' });
  await ops.operator('renamePlan', { ...rename, title: 'Later edit', operationId: randomUUID() });
  store.close();
  store = await openStore(join(root, 'data'));
  const resumed = new Operations(store, () => {});
  await expect(resumed.operator('renamePlan', rename)).resolves.toMatchObject({
    artifactId: plan.artifactId,
  });
  expect(await store.artifact(plan.artifactId)).toMatchObject({
    title: 'Later edit',
    originSession,
  });
});
it('serializes concurrent session attachment so a different session cannot silently overwrite the winner', async () => {
  const { ops, plan } = await setup();
  const sessions = [originSession, { ...originSession, sessionId: 'competing-agent' }];
  const results = await Promise.allSettled(
    sessions.map((session) =>
      ops.tool('attach_artifact_session', {
        artifactId: plan.artifactId,
        originSession: session,
        operationId: randomUUID(),
      }),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
    { reason: { code: 'SESSION_CONFLICT' } },
  ]);
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  expect((await store.artifact(plan.artifactId)).originSession).toEqual(sessions[winner]);
});
