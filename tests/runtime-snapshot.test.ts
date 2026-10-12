import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument } from '../src/document';
import { openStore, type Store } from '../src/runtime/store';
import { Operations } from '../src/runtime/operations';

let store: Store;
let root: string;
afterEach(async () => {
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
const source =
  '# Plan\n\nRepeated phrase.\n\n<Choice id="role" meaning="Selected role" semanticsVersion="1" options={["Owner","Member"]} defaultValue="Owner" />';
async function setup() {
  root = await mkdtemp(join(tmpdir(), 'bp-snapshot-'));
  const project = join(root, 'project');
  await mkdir(project);
  const compile = vi.fn(async (source: string) => parseDocument(source));
  store = await openStore(join(root, 'data'), compile);
  const p = await store.register(project);
  const ops = new Operations(store, () => {});
  const create = async (title: string) => {
    const artifact = await store.create({
      projectId: p.id,
      kind: 'projector',
      title,
      originSession: { harness: 'codex', sessionId: title },
      operationId: randomUUID(),
    });
    await writeFile(join(artifact.sourcePath, 'plan.mdx'), source);
    return artifact;
  };
  const publish = async (artifactId: string) =>
    store.publish({
      artifactId,
      expectedLatestRevision: (await store.artifact(artifactId)).latestRevision,
      operationId: randomUUID(),
    });
  const snapshot = async () =>
    (await ops.operator('snapshot', {})) as {
      artifacts: {
        id: string;
        displayStatus: string;
        privateChanges: boolean;
        latestRevision: string | null;
      }[];
      draft: { annotations: { id: string; comment: string }[] };
      savedStates: { id: string }[];
    };
  return { compile, ops, create, publish, snapshot };
}

it('lists draft and published plans without compiling previews or loading full documents', async () => {
  const { compile, create, publish, snapshot } = await setup();
  const published = await create('published');
  await publish(published.artifactId);
  const draft = await create('draft');
  compile.mockClear();
  const document = vi.spyOn(store, 'document');
  expect((await snapshot()).artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: published.artifactId,
        displayStatus: 'In review',
        privateChanges: false,
      }),
      expect.objectContaining({
        id: draft.artifactId,
        displayStatus: 'Draft',
        privateChanges: false,
      }),
    ]),
  );
  expect(compile).not.toHaveBeenCalled();
  expect(document).not.toHaveBeenCalled();
});

it('refreshes status, answers, annotations and approval on every snapshot without publishing private work', async () => {
  const { ops, create, publish, snapshot } = await setup();
  const artifact = await create('first');
  const revision = await publish(artifact.artifactId);
  const item = async () => (await snapshot()).artifacts.find((a) => a.id === artifact.artifactId)!;
  expect(await item()).toMatchObject({ displayStatus: 'In review', privateChanges: false });
  await store.approve(artifact.artifactId, revision.revisionId);
  expect(await item()).toMatchObject({ displayStatus: 'Approved', privateChanges: false });
  await store.setValue(artifact.artifactId, revision.revisionId, 'role', 'Member');
  expect(await item()).toMatchObject({ displayStatus: 'In review', privateChanges: true });
  const annotation = await store.annotate({
    artifactId: artifact.artifactId,
    revisionId: revision.revisionId,
    quote: 'Repeated phrase.',
    prefix: '',
    suffix: '',
    blockId: (await store.revision(artifact.artifactId, revision.revisionId)).blocks[1].id!,
    comment: 'Keep this answer',
  });
  expect(await item()).toMatchObject({ displayStatus: 'In review', privateChanges: true });
  expect((await snapshot()).draft.annotations).toEqual([
    expect.objectContaining({ id: annotation.id, comment: 'Keep this answer' }),
  ]);
  expect(
    await ops.tool('read_artifact', { artifactId: artifact.artifactId, part: 'state' }),
  ).toMatchObject({ savedState: null });
  const saved = await store.states.save({
    artifactId: artifact.artifactId,
    revisionId: revision.revisionId,
    expectedLatestSavedStateId: null,
    operationId: randomUUID(),
  });
  expect(await item()).toMatchObject({ displayStatus: 'In review', privateChanges: false });
  expect((await snapshot()).savedStates).toEqual([expect.objectContaining({ id: saved.id })]);
  await store.approve(artifact.artifactId, revision.revisionId);
  expect(await item()).toMatchObject({ displayStatus: 'Approved', privateChanges: false });
  await store.editAnnotation(annotation.id, 'Reconsider this answer');
  expect(await item()).toMatchObject({ displayStatus: 'In review', privateChanges: true });
  expect((await store.states.read(artifact.artifactId))?.annotations[0].comment).toBe(
    'Keep this answer',
  );
  const next = await publish(artifact.artifactId);
  expect(await item()).toMatchObject({
    latestRevision: next.revisionId,
    displayStatus: 'In review',
    privateChanges: true,
  });
});

it('keeps editor and legacy Submit status rules while invalidating request-scoped reads after writes', async () => {
  const { ops, create, publish, snapshot } = await setup();
  const artifact = await create('legacy');
  const revision = await publish(artifact.artifactId);
  const project = (await store.artifact(artifact.artifactId)).projectId;
  await store.bind(project, 'legacy');
  const item = async () => (await snapshot()).artifacts.find((a) => a.id === artifact.artifactId)!;
  await store.saveEditor(artifact.artifactId, revision.revisionId, {
    selection: { quote: 'Repeated phrase.', prefix: '', suffix: '', blockId: 'block' },
    comment: 'Pending',
  });
  expect(await item()).toMatchObject({ privateChanges: true });
  await store.saveEditor(artifact.artifactId, revision.revisionId, null);
  expect(await item()).toMatchObject({ privateChanges: false });
  await store.setValue(artifact.artifactId, revision.revisionId, 'role', 'Member');
  expect(await item()).toMatchObject({ privateChanges: true });
  await store.submit(project, randomUUID());
  expect(await item()).toMatchObject({ privateChanges: false });
  await store.approve(artifact.artifactId, revision.revisionId);
  expect(await item()).toMatchObject({ displayStatus: 'Approved' });
  // The agent writes source files externally; the next publication and snapshot must see it.
  await writeFile(join(artifact.sourcePath, 'plan.mdx'), source + '\n\nExternal agent update.');
  const next = await publish(artifact.artifactId);
  expect(await item()).toMatchObject({
    latestRevision: next.revisionId,
    displayStatus: 'In review',
    privateChanges: false,
  });
  expect(
    (
      (await ops.operator('getDocument', {
        artifactId: artifact.artifactId,
        revisionId: next.revisionId,
      })) as { revision: { source: string } }
    ).revision.source,
  ).toContain('External agent update.');
  await writeFile(
    store.statePath(artifact.artifactId, next.revisionId),
    JSON.stringify({ values: { role: 'invalid' } }),
  );
  await expect(snapshot()).rejects.toMatchObject({ code: 'CORRUPT_DATA' });
});
