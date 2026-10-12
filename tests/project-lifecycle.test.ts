import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, rename, cp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, type Store } from '../src/runtime/store';
let store: Store;
let root: string;
afterEach(async () => {
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  root = await mkdtemp(join(tmpdir(), 'bp-project-life-'));
  await mkdir(join(root, 'original'));
  store = await openStore(join(root, 'data'));
  return store.register(join(root, 'original'));
}
it('recovers a moved identity while retaining private data and rejecting an unrelated folder', async () => {
  const p = await setup();
  await rename(p.path, join(root, 'moved'));
  expect((await store.projectAvailability())[0].available).toBe(false);
  await expect(store.artifacts()).resolves.toEqual([]);
  await mkdir(join(root, 'other'));
  await expect(store.relocate(p.id, join(root, 'other'))).rejects.toMatchObject({
    code: 'PROJECT_ID_MISMATCH',
  });
  await store.relocate(p.id, join(root, 'moved'));
  expect(store.project(p.id).path).toBe(await realpath(join(root, 'moved')));
  expect((await store.register(join(root, 'moved'))).id).toBe(p.id);
});
it('rejects copied identity and archives copied history before creating an empty identity', async () => {
  const p = await setup();
  await cp(p.path, join(root, 'copy'), { recursive: true });
  await expect(store.register(join(root, 'copy'))).rejects.toMatchObject({
    code: 'PROJECT_ID_CONFLICT',
  });
  const fresh = await store.registerCopy(join(root, 'copy'), p.id);
  expect(fresh.id).not.toBe(p.id);
  expect(JSON.parse(await readFile(join(fresh.backupPath, 'project.json'), 'utf8')).id).toBe(p.id);
  expect(await store.artifacts()).toEqual([]);
  store.removeProject(fresh.id);
  expect(
    JSON.parse(await readFile(join(root, 'copy', '.projector', 'project.json'), 'utf8')).id,
  ).toBe(fresh.id);
  expect(store.projects()).toHaveLength(1);
});

it('retains removed identity ownership and private work without importing it into a copy', async () => {
  const p = await setup();
  const artifact = await store.create({
    projectId: p.id,
    kind: 'projector',
    title: 'Private original',
    originSession: { harness: 'codex', sessionId: 'original' },
    operationId: 'create',
  });
  await writeFile(
    join(artifact.sourcePath, 'plan.mdx'),
    '# Original\n\n<Choice id="choice" meaning="Decision" semanticsVersion="1" options={["A","B"]} defaultValue="A" />',
  );
  const revision = await store.publish({
    artifactId: artifact.artifactId,
    expectedLatestRevision: null,
    operationId: 'publish',
  });
  await store.setValue(artifact.artifactId, revision.revisionId, 'choice', 'B');
  await cp(p.path, join(root, 'copy'), { recursive: true });
  store.removeProject(p.id);
  expect(store.projects()).toEqual([]);
  await expect(store.register(join(root, 'copy'))).rejects.toMatchObject({
    code: 'PROJECT_ID_CONFLICT',
  });
  const copy = await store.registerCopy(join(root, 'copy'), p.id);
  expect(copy.id).not.toBe(p.id);
  expect(await store.artifacts()).toEqual([]);
  expect((await store.register(p.path)).id).toBe(p.id);
  expect((await store.state(artifact.artifactId, revision.revisionId)).values.choice).toBe('B');
  expect(await store.artifacts()).toHaveLength(1);
});

it('reopens legacy project storage with the same identity, revisions and private answers', async () => {
  const project = await setup();
  const artifact = await store.create({
    projectId: project.id,
    kind: 'projector',
    title: 'Legacy plan',
    originSession: { harness: 'codex', sessionId: 'author' },
    operationId: 'legacy-create',
  });
  await writeFile(
    join(artifact.sourcePath, 'plan.mdx'),
    '# Legacy\n\n<Choice id="q" meaning="Question" semanticsVersion="1" options={["A","B"]} defaultValue="A" />',
  );
  const revision = await store.publish({
    artifactId: artifact.artifactId,
    expectedLatestRevision: null,
    operationId: 'legacy-publish',
  });
  await store.setValue(artifact.artifactId, revision.revisionId, 'q', 'B');
  const manifestPath = join(
    project.path,
    '.projector',
    'artifacts',
    artifact.artifactId,
    'artifact.json',
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.kind = 'blueprint';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rename(join(project.path, '.projector'), join(project.path, '.blueprint'));
  store.close();
  store = await openStore(join(root, 'data'));
  expect((await store.register(project.path)).id).toBe(project.id);
  expect((await store.artifact(artifact.artifactId)).kind).toBe('blueprint');
  expect((await store.state(artifact.artifactId, revision.revisionId)).values.q).toBe('B');
  expect((await store.revision(artifact.artifactId, revision.revisionId)).source).toContain(
    '# Legacy',
  );
  expect(await store.base(project)).toBe(join(project.path, '.blueprint'));
});

it('refuses two populated project roots rather than merging identities', async () => {
  const project = await setup();
  await mkdir(join(project.path, '.blueprint'));
  await writeFile(
    join(project.path, '.blueprint', 'project.json'),
    JSON.stringify({ id: 'other-id', formatVersion: 1 }),
  );
  await expect(store.register(project.path)).rejects.toMatchObject({
    code: 'PROJECT_DATA_CONFLICT',
  });
  expect(
    JSON.parse(await readFile(join(project.path, '.projector', 'project.json'), 'utf8')).id,
  ).toBe(project.id);
  expect(
    JSON.parse(await readFile(join(project.path, '.blueprint', 'project.json'), 'utf8')).id,
  ).toBe('other-id');
});
