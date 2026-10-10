import { it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, type Store } from '../src/runtime/store';
import { Operations } from '../src/runtime/operations';

let root: string;
let store: Store;
afterEach(async () => {
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  root = await mkdtemp(join(tmpdir(), 'bp-context-'));
  await mkdir(join(root, 'project'));
  store = await openStore(join(root, 'data'));
  const p = await store.register(join(root, 'project'));
  const a = await store.create({
    projectId: p.id,
    title: 'Stateful plan',
    kind: 'blueprint',
    originSession: { harness: 'codex', sessionId: 'context-session' },
    operationId: randomUUID(),
  });
  await writeFile(
    join(a.sourcePath, 'plan.mdx'),
    '# Plan\n\nOriginal wording.\n\n<Details title="Options">\n\nExpanded wording.\n\n</Details>\n\n<Choice id="role" meaning="Role" semanticsVersion="1" options={["Owner","Member"]} defaultValue="Owner" />',
  );
  const r = await store.publish({
    artifactId: a.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  });
  const revision = await store.revision(a.artifactId, r.revisionId);
  const detail = revision.blocks.find((b) => b.type === 'details')!.id!;
  const ops = new Operations(store, () => {});
  return { artifactId: a.artifactId, revisionId: r.revisionId, detail, ops };
}
it('binds annotations to exact widget and disclosure state without overwriting later working choices', async () => {
  const { artifactId, revisionId, detail, ops } = await setup();
  const initial = (await ops.operator('captureAnnotationState', {
    artifactId,
    revisionId,
    view: { details: {} },
  })) as {
    stateHash: string;
    values: Record<string, string>;
    view: { details: Record<string, boolean> };
  };
  expect(initial).toMatchObject({
    stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    values: { role: 'Owner' },
    view: { details: { [detail]: false } },
  });
  await store.setValue(artifactId, revisionId, 'role', 'Member');
  const changed = (await ops.operator('captureAnnotationState', {
    artifactId,
    revisionId,
    view: { details: {} },
  })) as typeof initial;
  expect(changed.stateHash).not.toBe(initial.stateHash);
  await ops.operator('setViewState', {
    artifactId,
    revisionId,
    view: { details: { [detail]: true } },
  });
  const expanded = (await ops.operator('captureAnnotationState', {
    artifactId,
    revisionId,
    view: { details: { [detail]: true } },
  })) as typeof initial;
  expect(expanded.stateHash).not.toBe(changed.stateHash);
  const annotation = await ops.operator('addAnnotation', {
    artifactId,
    revisionId,
    blockId: 'document',
    quote: 'Original wording.',
    comment: 'For the owner state',
    stateContext: initial,
  });
  expect(annotation).toMatchObject({ stateContext: initial });
  const saved = (await ops.operator('saveState', {
    artifactId,
    revisionId,
    operationId: randomUUID(),
    expectedLatestSavedStateId: null,
  })) as { id: string };
  const response = (await ops.tool('read_artifact', {
    artifactId,
    savedStateId: saved.id,
    part: 'state',
  })) as { content: string };
  const state = JSON.parse(response.content);
  expect(state.annotations[0].source.stateContext).toEqual(initial);
  expect(state.answers[artifactId + ':' + revisionId].values.role).toBe('Member');
  store.close();
  store = await openStore(join(root, 'data'));
  const reopened = await store.document(artifactId, revisionId);
  expect(reopened).toMatchObject({
    state: { values: { role: 'Member' } },
    view: { details: { [detail]: true } },
  });
});
it('rejects forged context hashes and disclosure IDs instead of treating them as valid bindings', async () => {
  const { artifactId, revisionId, ops } = await setup();
  const context = (await ops.operator('captureAnnotationState', {
    artifactId,
    revisionId,
    view: { details: {} },
  })) as { stateHash: string };
  await expect(
    ops.operator('addAnnotation', {
      artifactId,
      revisionId,
      blockId: 'document',
      quote: 'Original wording.',
      comment: 'Forged state',
      stateContext: { ...context, stateHash: '0'.repeat(64) },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ANNOTATION_STATE' });
  await expect(
    ops.operator('setViewState', { artifactId, revisionId, view: { details: { missing: true } } }),
  ).rejects.toMatchObject({ code: 'INVALID_VIEW_STATE' });
});
