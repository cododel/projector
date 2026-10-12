import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
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
const source =
  '# Plan\n\nSame phrase. Same phrase.\n\n<Choice id="role" meaning="Selected role" semanticsVersion="1" options={["Owner","Member"]} defaultValue="Owner" />';
async function setup() {
  root = await mkdtemp(join(tmpdir(), 'bp-save-'));
  const project = join(root, 'project');
  await mkdir(project);
  store = await openStore(join(root, 'data'));
  const p = await store.register(project);
  const ops = new Operations(store, () => {});
  const create = async (sessionId: string) => {
    const a = await store.create({
      projectId: p.id,
      kind: 'projector',
      title: 'Plan',
      originSession: { harness: 'codex', sessionId },
      operationId: randomUUID(),
    });
    await writeFile(join(a.sourcePath, 'plan.mdx'), source);
    const r = await store.publish({
      artifactId: a.artifactId,
      expectedLatestRevision: null,
      operationId: randomUUID(),
    });
    return { a, r };
  };
  return { p, ops, create };
}
it('refuses to create a demo without explicit origin even when a legacy project recipient exists', async () => {
  const { p, ops } = await setup();
  await store.bind(p.id, 'unrelated-session');
  await expect(ops.operator('demo', { projectId: p.id })).rejects.toMatchObject({
    code: 'ORIGIN_SESSION_REQUIRED',
  });
  expect(await store.artifacts()).toHaveLength(0);
});
it('selects a workspace document without re-emitting public navigation', async () => {
  const { ops, create } = await setup();
  const { a, r } = await create('author-session');
  const events: unknown[] = [];
  const selected = new Operations(store, (event) => events.push(event));
  await selected.operator('openArtifact', { artifactId: a.artifactId, revisionId: r.revisionId, workspace: true });
  expect(selected.selected).toEqual({ artifactId: a.artifactId, revisionId: r.revisionId });
  expect(events).toEqual([{ type: 'refresh' }]);
  await selected.tool('show_artifact', { artifactId: a.artifactId, revisionId: r.revisionId });
  expect(events).toEqual([{ type: 'refresh' }, { type: 'show-artifact', artifactId: a.artifactId, revisionId: r.revisionId }, { type: 'refresh' }]);
  expect((await store.artifact(a.artifactId)).originSession?.sessionId).toBe('author-session');
  expect(ops.selected).toBeNull();
});
it.each([null, 'unrelated-session'])(
  'creates demos for their explicit sessions independent of project recipient %s',
  async (recipient) => {
    const { p, ops } = await setup();
    if (recipient) await store.bind(p.id, recipient);
    for (const sessionId of ['first-demo-session', 'second-demo-session']) {
      await ops.operator('demo', {
        projectId: p.id,
        originSession: { harness: 'codex', sessionId },
      });
      const artifact = await store.artifact(ops.selected!.artifactId);
      expect(artifact.originSession).toEqual({ harness: 'codex', sessionId });
      expect(artifact.latestRevision).toBe(ops.selected!.revisionId);
    }
    expect(await store.artifacts()).toHaveLength(2);
    expect(store.project(p.id).recipient?.sessionId ?? null).toBe(recipient);
  },
);
it('creates independent artifacts without a project session and only exposes explicit immutable Save snapshots', async () => {
  const { p, ops, create } = await setup();
  const { a, r } = await create('session-one');
  const second = await create('session-two');
  expect(p.recipient).toBeNull();
  await store.setValue(a.artifactId, r.revisionId, 'role', 'Member');
  await expect(
    ops.tool('read_artifact', { artifactId: a.artifactId, part: 'state' }),
  ).resolves.toMatchObject({ savedState: null });
  const revision = await store.revision(a.artifactId, r.revisionId);
  await store.annotate({
    artifactId: a.artifactId,
    revisionId: r.revisionId,
    quote: 'Same phrase.',
    prefix: '',
    suffix: '',
    blockId: revision.blocks[1].id!,
    comment: 'Second occurrence',
  });
  store.close();
  store = await openStore(join(root, 'data'));
  const resumed = new Operations(store, () => {});
  expect((await store.document(a.artifactId, r.revisionId)).annotations).toHaveLength(1);
  expect((await store.document(second.a.artifactId, second.r.revisionId)).annotations).toHaveLength(
    0,
  );
  const args = {
    artifactId: a.artifactId,
    revisionId: r.revisionId,
    operationId: randomUUID(),
    expectedLatestSavedStateId: null,
  };
  const saved = (await resumed.operator('saveState', args)) as { id: string };
  expect(await resumed.operator('saveState', args)).toEqual(saved);
  const read = (await resumed.tool('read_artifact', {
    artifactId: a.artifactId,
    part: 'state',
  })) as { content: string };
  const data = JSON.parse(read.content);
  expect(data.answers[`${a.artifactId}:${r.revisionId}`].values.role).toBe('Member');
  expect(data.annotations[0]).toMatchObject({
    number: 1,
    text: 'Same phrase.',
    annotation: 'Second occurrence',
    source: { artifactId: a.artifactId, revisionId: r.revisionId },
  });
  expect((await store.document(a.artifactId, r.revisionId)).annotations).toHaveLength(1);
  await store.editAnnotation(data.annotations[0].id, 'Private edit');
  const old = (await resumed.tool('read_artifact', {
    artifactId: a.artifactId,
    part: 'state',
    savedStateId: saved.id,
  })) as { content: string };
  expect(old.content).toContain('Second occurrence');
  expect(old.content).not.toContain('Private edit');
  await expect(
    resumed.operator('saveState', { ...args, operationId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  await expect(resumed.tool('saveState', args)).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
});
it('previews missing, valid and invalid unpublished source without publishing', async () => {
  const { p, ops } = await setup();
  const a = await store.create({
    projectId: p.id,
    kind: 'projector',
    title: 'Draft',
    originSession: { harness: 'codex', sessionId: 's' },
    operationId: randomUUID(),
  });
  await ops.operator('openArtifact', { artifactId: a.artifactId, revisionId: null });
  expect(
    await ops.operator('getDocument', { artifactId: a.artifactId, revisionId: null }),
  ).toMatchObject({ draft: true, waiting: true });
  await writeFile(join(a.sourcePath, 'plan.mdx'), source);
  expect(
    await ops.operator('getDocument', { artifactId: a.artifactId, revisionId: null }),
  ).toMatchObject({ draft: true, preview: { widgets: [{ id: 'role' }] } });
  await writeFile(join(a.sourcePath, 'plan.mdx'), 'import Evil from "evil"\n\n# Draft');
  expect(
    await ops.operator('getDocument', { artifactId: a.artifactId, revisionId: null }),
  ).toMatchObject({
    draft: true,
    error: expect.any(String),
    source: expect.stringContaining('import Evil'),
  });
  expect((await store.artifact(a.artifactId)).latestRevision).toBeNull();
});
it('rejects Save while unfinished annotation exists and does not leave partial checkpoint on conflict', async () => {
  const { create, ops, p } = await setup();
  const { a, r } = await create('s');
  await store.saveEditor(a.artifactId, r.revisionId, {
    selection: { quote: 'Same', prefix: '', suffix: '', blockId: 'document' },
    comment: 'pending',
  });
  await expect(
    ops.operator('saveState', {
      artifactId: a.artifactId,
      revisionId: r.revisionId,
      expectedLatestSavedStateId: null,
      operationId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'UNFINISHED_ANNOTATION' });
  expect(await readdir(join(p.path, '.projector', 'artifacts', a.artifactId))).not.toContain(
    'states',
  );
});
it('recovers committed Save after lost acknowledgement without duplicate state or modified replay', async () => {
  const { create, ops } = await setup();
  const { a, r } = await create('s');
  await store.setValue(a.artifactId, r.revisionId, 'role', 'Member');
  const args = {
    artifactId: a.artifactId,
    revisionId: r.revisionId,
    operationId: randomUUID(),
    expectedLatestSavedStateId: null,
  };
  const original = store.record.bind(store);
  store.record = () => {
    throw new Error('index acknowledgement lost');
  };
  await expect(ops.operator('saveState', args)).rejects.toThrow('index acknowledgement lost');
  store.record = original;
  const committed = await store.states.read(a.artifactId);
  expect(committed?.answers[`${a.artifactId}:${r.revisionId}`].values.role).toBe('Member');
  await store.setValue(a.artifactId, r.revisionId, 'role', 'Owner');
  const replay = (await ops.operator('saveState', args)) as { id: string };
  expect(replay.id).toBe(committed?.id);
  expect(await store.states.list(a.artifactId)).toHaveLength(1);
  expect((await store.state(a.artifactId, r.revisionId)).values.role).toBe('Owner');
});
it('keeps draft captures private and freezes image numbering with a saved state', async () => {
  const { create, ops } = await setup();
  const { a, r } = await create('s');
  const capture = {
    id: randomUUID(),
    png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    source: {
      kind: 'document-area' as const,
      capturedAt: new Date().toISOString(),
      viewport: { width: 100, height: 80, deviceScaleFactor: 1 },
      rect: { x: 10, y: 10, width: 20, height: 20 },
      pointer: { x: 29, y: 27 },
      zoomFactor: 1,
      scroll: { x: 0, y: 0 },
    },
  };
  const ann = await store.addAreaAnnotation({
    artifactId: a.artifactId,
    revisionId: r.revisionId,
    comment: 'Look here',
    kind: 'document-area',
    capture,
  });
  const retry = {
    artifactId: a.artifactId,
    revisionId: r.revisionId,
    comment: 'Look here',
    kind: 'document-area' as const,
    capture,
  };
  expect(await store.addAreaAnnotation(retry)).toEqual(ann);
  await expect(
    store.addAreaAnnotation({
      ...retry,
      capture: {
        ...capture,
        source: { ...capture.source, rect: { ...capture.source.rect, x: 15 } },
      },
    }),
  ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  await expect(
    store.addAreaAnnotation({
      ...retry,
      capture: {
        ...capture,
        png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6PVIAAAAASUVORK5CYII=',
      },
    }),
  ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
  await expect(
    ops.tool('read_attachment', {
      artifactId: a.artifactId,
      savedStateId: 'private',
      attachmentId: capture.id,
    }),
  ).rejects.toMatchObject({ code: 'UNKNOWN_SAVED_STATE' });
  const saved = await store.states.save({
    artifactId: a.artifactId,
    revisionId: r.revisionId,
    operationId: randomUUID(),
    expectedLatestSavedStateId: null,
  });
  const image = await store.states.attachment(a.artifactId, saved.id, capture.id);
  const svg = Buffer.from(image.base64, 'base64').toString();
  expect(svg).toContain('>1</text>');
  expect(svg).toContain('M29 27 ');
  expect(saved.annotations[0].source.capture?.pointer).toEqual({ x: 29, y: 27 });
  expect(svg).toContain('data:image/png;base64,');
  expect(saved.annotations[0].source.attachmentId).toBe(capture.id);
  await store.editAnnotation(ann.id, null);
  expect((await store.states.read(a.artifactId, saved.id))?.annotations).toHaveLength(1);
  expect((await store.states.attachment(a.artifactId, saved.id, capture.id)).base64).toBe(
    image.base64,
  );
  const savedRoot = join(
    root,
    'project',
    '.projector',
    'artifacts',
    a.artifactId,
    'states',
    saved.id,
  );
  const manifestPath = join(savedRoot, 'state.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // A manually corrupted public manifest must not widen attachment access to other project files.
  manifest.attachments[0].file = '../../source/plan.mdx';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(store.states.attachment(a.artifactId, saved.id, capture.id)).rejects.toMatchObject({
    code: 'PATH_OUTSIDE_PROJECT',
  });
});
it('invalidates approval on changed annotations and new saved checkpoints', async () => {
  const { create } = await setup();
  const { a, r } = await create('s');
  const first = await store.states.save({
    artifactId: a.artifactId,
    revisionId: r.revisionId,
    operationId: randomUUID(),
    expectedLatestSavedStateId: null,
  });
  await store.approve(a.artifactId, r.revisionId);
  expect((await store.document(a.artifactId, r.revisionId)).approved).toBe(true);
  const revision = await store.revision(a.artifactId, r.revisionId);
  await store.annotate({
    artifactId: a.artifactId,
    revisionId: r.revisionId,
    quote: 'Same phrase.',
    prefix: '',
    suffix: '',
    blockId: revision.blocks[1].id!,
    comment: 'Review',
  });
  expect((await store.document(a.artifactId, r.revisionId)).approved).toBe(false);
  await expect(store.approve(a.artifactId, r.revisionId)).rejects.toMatchObject({
    code: 'UNSUBMITTED_FEEDBACK',
  });
  await store.states.save({
    artifactId: a.artifactId,
    revisionId: r.revisionId,
    operationId: randomUUID(),
    expectedLatestSavedStateId: first.id,
  });
  expect((await store.document(a.artifactId, r.revisionId)).approved).toBe(false);
});
it('does not expose a partial Save if an attachment fails before checkpoint commit', async () => {
  const { create, p } = await setup();
  const { a, r } = await create('s');
  const capture = {
    id: randomUUID(),
    png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    source: {
      kind: 'document-area' as const,
      capturedAt: new Date().toISOString(),
      viewport: { width: 100, height: 80, deviceScaleFactor: 1 },
      rect: { x: 10, y: 10, width: 20, height: 20 },
      zoomFactor: 1,
      scroll: { x: 0, y: 0 },
    },
  };
  await store.addAreaAnnotation({
    artifactId: a.artifactId,
    revisionId: r.revisionId,
    comment: 'Look here',
    kind: 'document-area',
    capture,
  });
  await rm(join(root, 'data', 'captures', a.artifactId, capture.id + '.png'));
  await expect(
    store.states.save({
      artifactId: a.artifactId,
      revisionId: r.revisionId,
      operationId: randomUUID(),
      expectedLatestSavedStateId: null,
    }),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await store.states.list(a.artifactId)).toEqual([]);
  const dirs = await readdir(join(p.path, '.projector', 'artifacts', a.artifactId, 'states'));
  expect(dirs.every((n) => n.startsWith('.stage-'))).toBe(true);
  store.close();
  store = await openStore(join(root, 'data'));
  expect(await store.states.read(a.artifactId)).toBeNull();
  expect((await store.document(a.artifactId, r.revisionId)).annotations).toHaveLength(1);
});
