import { afterEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store, type Annotation } from '../src/runtime/store';
import { Operations } from '../src/runtime/operations';
let store: Store;
let root: string;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
afterEach(async () => {
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
const source =
  '# Plan\n\nA retained selection.\n\n<Choice id="role" meaning="Role" semanticsVersion="1" options={["Owner","Member"]} defaultValue="Owner" />';
async function setup() {
  root = await mkdtemp(join(tmpdir(), 'bp-legacy-migration-'));
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  const data = join(root, 'data');
  store = await openStore(data);
  const project = await store.register(projectPath);
  const create = async (sessionId: string) => {
    const artifact = await store.create({
      projectId: project.id,
      kind: 'projector',
      title: 'Plan',
      originSession: { harness: 'codex', sessionId },
      operationId: randomUUID(),
    });
    await writeFile(join(artifact.sourcePath, 'plan.mdx'), source);
    const revision = await store.publish({
      artifactId: artifact.artifactId,
      expectedLatestRevision: null,
      operationId: randomUUID(),
    });
    return { artifact, revision };
  };
  return { data, project, create };
}
it('migrates all legacy recipient namespaces to their artifacts without publication or altering packages and approvals', async () => {
  const { data, project, create } = await setup();
  const first = await create('one');
  const second = await create('two');
  const annotation = (
    id: string,
    artifactId: string,
    revisionId: string,
    comment: string,
  ): Annotation => ({
    id,
    artifactId,
    revisionId,
    quote: 'A retained selection.',
    prefix: '',
    suffix: '',
    blockId: 'document',
    comment,
  });
  const published = annotation(
    'already-submitted',
    first.artifact.artifactId,
    first.revision.revisionId,
    'Published baseline',
  );
  const privateOne = annotation(
    'private-one',
    first.artifact.artifactId,
    first.revision.revisionId,
    'PRIVATE FIRST NAMESPACE',
  );
  const privateTwo = annotation(
    'private-two',
    second.artifact.artifactId,
    second.revision.revisionId,
    'PRIVATE SECOND NAMESPACE',
  );
  const firstKey = `${first.artifact.artifactId}:${first.revision.revisionId}`;
  const secondKey = `${second.artifact.artifactId}:${second.revision.revisionId}`;
  const feedback = {
    formatVersion: 1,
    id: 'legacy-package',
    projectId: project.id,
    recipient: { harness: 'codex', sessionId: 'old-one' },
    createdAt: '2026-10-08T00:00:00.000Z',
    status: 'saved',
    annotations: [published],
    answers: {
      [firstKey]: {
        artifactId: first.artifact.artifactId,
        revisionId: first.revision.revisionId,
        values: { role: 'Owner' },
      },
    },
    notification: 'Legacy notification',
  };
  const packetDir = join(project.path, '.projector', 'feedback', feedback.id);
  await mkdir(packetDir, { recursive: true });
  const packetPath = join(packetDir, 'package.json');
  await writeFile(packetPath, JSON.stringify(feedback));
  const approvalState = { values: { role: 'Owner' } };
  const approval = {
    id: 'legacy-approval',
    artifactId: first.artifact.artifactId,
    revisionId: first.revision.revisionId,
    state: approvalState,
    stateHash: hash(approvalState),
    implementationAuthorized: false,
  };
  const approvalDir = join(project.path, '.projector', 'approvals');
  await mkdir(approvalDir, { recursive: true });
  const approvalPath = join(
    approvalDir,
    hash({ artifactId: first.artifact.artifactId, revisionId: first.revision.revisionId }) +
      '.json',
  );
  await writeFile(approvalPath, JSON.stringify(approval));
  const draftsDir = join(data, 'drafts', project.id);
  await mkdir(draftsDir, { recursive: true });
  const draftOnePath = join(draftsDir, hash({ harness: 'codex', sessionId: 'old-one' }) + '.json');
  const draftTwoPath = join(draftsDir, hash({ harness: 'codex', sessionId: 'old-two' }) + '.json');
  await writeFile(
    draftOnePath,
    JSON.stringify({
      annotations: [privateOne],
      answers: {
        [firstKey]: {
          artifactId: first.artifact.artifactId,
          revisionId: first.revision.revisionId,
          values: { role: 'Member' },
        },
      },
    }),
  );
  await writeFile(
    draftTwoPath,
    JSON.stringify({
      annotations: [privateTwo],
      answers: {
        [secondKey]: {
          artifactId: second.artifact.artifactId,
          revisionId: second.revision.revisionId,
          values: { role: 'Member' },
        },
      },
    }),
  );
  for (const { artifact, revision } of [first, second]) {
    const path = store.statePath(artifact.artifactId, revision.revisionId);
    await mkdir(join(data, 'states', artifact.artifactId), { recursive: true });
    await writeFile(path, JSON.stringify({ values: { role: 'Member' } }));
    await rm(store.states.path(artifact.artifactId), { force: true });
  }
  const originalPacket = await readFile(packetPath, 'utf8');
  const originalApproval = await readFile(approvalPath, 'utf8');
  store.close();
  store = await openStore(data);
  const ops = new Operations(store, () => {});
  const firstDraft = await store.states.draft(first.artifact.artifactId);
  const secondDraft = await store.states.draft(second.artifact.artifactId);
  expect(firstDraft.annotations.map((a) => a.id)).toEqual(['already-submitted', 'private-one']);
  expect(secondDraft.annotations.map((a) => a.id)).toEqual(['private-two']);
  expect(firstDraft.answers[firstKey].values.role).toBe('Member');
  expect(secondDraft.answers[secondKey].values.role).toBe('Member');
  for (const target of [first, second]) {
    expect(
      await ops.tool('read_artifact', { artifactId: target.artifact.artifactId, part: 'state' }),
    ).toMatchObject({ savedState: null });
    const publicData = JSON.stringify(
      await ops.tool('read_artifact', { artifactId: target.artifact.artifactId }),
    );
    expect(publicData).not.toContain('PRIVATE');
  }
  const legacyRead = (await ops.tool('read_feedback', {
    packageId: feedback.id,
    part: 'manifest',
  })) as { content: string };
  expect(JSON.parse(legacyRead.content)).toEqual(feedback);
  expect(await store.approval(first.artifact.artifactId, first.revision.revisionId)).toEqual(
    approval,
  );
  expect(
    (await store.publicState(first.artifact.artifactId, first.revision.revisionId)).values.role,
  ).toBe('Owner');
  expect(
    (await store.document(first.artifact.artifactId, first.revision.revisionId)).approved,
  ).toBe(false);
  expect(await readFile(packetPath, 'utf8')).toBe(originalPacket);
  expect(await readFile(approvalPath, 'utf8')).toBe(originalApproval);
  // Reopening migration is stable and cannot republish a private namespace.
  store.close();
  store = await openStore(data);
  expect(
    (await store.states.draft(first.artifact.artifactId)).annotations.map((a) => a.id),
  ).toEqual(['already-submitted', 'private-one']);
  expect(await store.states.read(first.artifact.artifactId)).toBeNull();
});
it('requires an unfinished private browser composer to be completed or cancelled before approval', async () => {
  const { create } = await setup();
  const { artifact, revision } = await create('one');
  const ops = new Operations(store, () => {});
  await ops.operator('saveBrowserEditor', {
    artifactId: artifact.artifactId,
    editor: {
      artifactId: artifact.artifactId,
      tabId: 'pending-tab',
      revisionId: revision.revisionId,
      comment: 'UNFINISHED PRIVATE COMMENT',
      capture: {
        id: 'pending',
        source: {
          kind: 'browser-area',
          url: 'http://localhost:8000/',
          title: 'Test',
          capturedAt: new Date().toISOString(),
          viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
          zoomFactor: 1,
          scroll: { x: 0, y: 0 },
        },
      },
    },
  });
  await expect(
    ops.operator('approve', { artifactId: artifact.artifactId, revisionId: revision.revisionId }),
  ).rejects.toMatchObject({ code: 'UNSUBMITTED_FEEDBACK' });
});

it('preserves a recoverable private legacy answer when its redundant state file is missing', async () => {
  const { data, project, create } = await setup();
  const { artifact, revision } = await create('one');
  const key = `${artifact.artifactId}:${revision.revisionId}`;
  const legacyDirectory = join(data, 'drafts', project.id);
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(
    join(legacyDirectory, 'old-recipient.json'),
    JSON.stringify({
      annotations: [],
      answers: {
        [key]: {
          artifactId: artifact.artifactId,
          revisionId: revision.revisionId,
          values: { role: 'Member' },
        },
      },
    }),
  );
  await rm(store.states.path(artifact.artifactId), { force: true });
  await rm(store.statePath(artifact.artifactId, revision.revisionId), { force: true });
  store.close();
  store = await openStore(data);
  expect((await store.states.draft(artifact.artifactId)).answers[key].values.role).toBe('Member');
  expect((await store.state(artifact.artifactId, revision.revisionId)).values.role).toBe('Member');
  expect(
    await new Operations(store, () => {}).tool('read_artifact', {
      artifactId: artifact.artifactId,
      part: 'state',
    }),
  ).toMatchObject({ savedState: null });
});

it('retains a legacy approval record when the same document revision receives a new approval', async () => {
  const { project, create } = await setup();
  const { artifact, revision } = await create('one');
  const approvalDir = join(project.path, '.projector', 'approvals');
  await mkdir(approvalDir, { recursive: true });
  const approvalPath = join(
    approvalDir,
    hash({ artifactId: artifact.artifactId, revisionId: revision.revisionId }) + '.json',
  );
  const previousState = { values: { role: 'Owner' } };
  const legacyApproval = {
    id: 'legacy-approval',
    artifactId: artifact.artifactId,
    revisionId: revision.revisionId,
    stateHash: hash(previousState),
    state: previousState,
    implementationAuthorized: false,
  };
  await writeFile(approvalPath, JSON.stringify(legacyApproval));
  const original = await readFile(approvalPath, 'utf8');
  await store.setValue(artifact.artifactId, revision.revisionId, 'role', 'Member');
  const saved = await store.states.save({
    artifactId: artifact.artifactId,
    revisionId: revision.revisionId,
    operationId: randomUUID(),
    expectedLatestSavedStateId: null,
  });
  await store.approve(artifact.artifactId, revision.revisionId);
  expect(await readFile(approvalPath, 'utf8')).toBe(original);
  expect(await store.approval(artifact.artifactId, revision.revisionId)).toMatchObject({
    savedStateId: saved.id,
    stateHash: hash({ values: { role: 'Member' } }),
  });
});
