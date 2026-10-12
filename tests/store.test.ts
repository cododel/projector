import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, type Store } from '../src/runtime/store';
import { Operations } from '../src/runtime/operations';
let store: Store;
const dirs: string[] = [];
afterEach(async () => {
  store?.close();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const source =
  '# Permission policy\n\nOwners manage membership.\n\n<Choice id="invite" meaning="Who invites?" semanticsVersion="1" options={["Owner","Member"]} defaultValue="Owner" />';
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'bp-store-'));
  dirs.push(root);
  const project = join(root, 'project');
  await import('node:fs/promises').then((f) => f.mkdir(project));
  store = await openStore(root);
  const p = await store.register(project);
  await store.bind(p.id, 'test-session');
  const input = {
    projectId: p.id,
    kind: 'projector' as const,
    title: 'Policy',
    originSession: { harness: 'codex' as const, sessionId: 'test-session' },
    operationId: randomUUID(),
  };
  const a = await store.create(input);
  await writeFile(join(a.sourcePath, 'plan.mdx'), source);
  const publish = {
    artifactId: a.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  };
  const r = await store.publish(publish);
  return { root, p, a, r, input, publish };
}
describe('real storage planning cycle', () => {
  it('normalizes recipient deep links to a session ID before binding and persists that ID', async () => {
    const { root, p } = await setup();
    const ops = new Operations(store, () => {});
    const sessionId = '01a11a07-49c3-7150-8a1f-d617760a395a';
    for (const input of [
      ` codex://threads/${sessionId} `,
      `codex://threads/${sessionId}?view=review`,
      ` ${sessionId} `,
    ]) {
      await ops.operator('bindSession', { projectId: p.id, sessionId: input });
      expect(store.project(p.id).recipient).toEqual({ harness: 'codex', sessionId });
    }
    store.close();
    store = await openStore(root);
    expect(store.project(p.id).recipient).toEqual({ harness: 'codex', sessionId });
  });
  it.each([
    'https://threads/test-session',
    'codex://other/test-session',
    'codex://threads/',
    'codex://threads/test-session/extra',
    'codex://user@threads/test-session',
  ])('rejects invalid recipient links without changing the binding: %s', async (sessionId) => {
    const { p } = await setup();
    const ops = new Operations(store, () => {});
    await expect(ops.operator('bindSession', { projectId: p.id, sessionId })).rejects.toMatchObject(
      {
        code: 'INVALID_SESSION_LINK',
      },
    );
    expect(store.project(p.id).recipient?.sessionId).toBe('test-session');
  });
  it('keeps draft private, submits immutable answers and annotations, and records separate approval', async () => {
    const { p, a, r } = await setup();
    const ops = new Operations(store, () => {});
    await store.setValue(a.artifactId, r.revisionId, 'invite', 'Member');
    const revision = await store.revision(a.artifactId, r.revisionId);
    await store.annotate({
      artifactId: a.artifactId,
      revisionId: r.revisionId,
      quote: 'Owners manage membership.',
      prefix: '',
      suffix: '',
      blockId: revision.blocks[1].id!,
      comment: 'Should invitations be delegated?',
    });
    expect(
      await ops.tool('list_feedback', {
        projectId: p.id,
        recipient: { harness: 'codex', sessionId: 'test-session' },
      }),
    ).toMatchObject({ items: [] });
    expect(
      JSON.stringify(
        await ops.tool('read_artifact', { artifactId: a.artifactId, revisionId: r.revisionId }),
      ),
    ).not.toContain('Should invitations');
    await expect(store.approve(a.artifactId, r.revisionId)).rejects.toMatchObject({
      code: 'UNSUBMITTED_FEEDBACK',
    });
    const operationId = randomUUID();
    const packet = await store.submit(p.id, operationId);
    expect(packet.answers[`${a.artifactId}:${r.revisionId}`].values.invite).toBe('Member');
    expect(packet.annotations[0].comment).toBe('Should invitations be delegated?');
    expect(await store.submit(p.id, operationId)).toEqual(packet);
    await store.setValue(a.artifactId, r.revisionId, 'invite', 'Owner');
    expect((await store.feedback(packet.id)).answers).toEqual(packet.answers);
    await expect(store.approve(a.artifactId, r.revisionId)).rejects.toMatchObject({
      code: 'UNSUBMITTED_FEEDBACK',
    });
    await store.submit(p.id, randomUUID());
    await store.approve(a.artifactId, r.revisionId);
    expect(await store.document(a.artifactId, r.revisionId)).toMatchObject({ approved: true });
  });
  it('preserves state across restart, keeps old anchors, transfers compatible values without approval', async () => {
    const { root, p, a, r } = await setup();
    await store.setValue(a.artifactId, r.revisionId, 'invite', 'Member');
    await store.submit(p.id, randomUUID());
    await store.approve(a.artifactId, r.revisionId);
    store.close();
    store = await openStore(root);
    expect((await store.state(a.artifactId, r.revisionId)).values.invite).toBe('Member');
    await writeFile(join(a.sourcePath, 'plan.mdx'), source + '\n\nMore details.');
    const next = await store.publish({
      artifactId: a.artifactId,
      expectedLatestRevision: r.revisionId,
      operationId: randomUUID(),
    });
    expect((await store.state(a.artifactId, next.revisionId)).values.invite).toBe('Member');
    expect((await store.document(a.artifactId, next.revisionId)).approved).toBe(false);
    await writeFile(
      join(a.sourcePath, 'plan.mdx'),
      source.replace('semanticsVersion="1"', 'semanticsVersion="2"'),
    );
    const incompatible = await store.publish({
      artifactId: a.artifactId,
      expectedLatestRevision: next.revisionId,
      operationId: randomUUID(),
    });
    expect((await store.state(a.artifactId, incompatible.revisionId)).values.invite).toBe('Owner');
    expect((await store.state(a.artifactId, r.revisionId)).values.invite).toBe('Member');
  });
  it('retries publication by operation id and refuses changed content or stale revision', async () => {
    const { a, r, publish } = await setup();
    expect(await store.publish(publish)).toEqual(r);
    await writeFile(join(a.sourcePath, 'plan.mdx'), source + '\nChanged');
    await expect(store.publish(publish)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await expect(store.publish({ ...publish, operationId: randomUUID() })).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
  });
  it('rejects invalid widget values and symlink escape at actual read boundary', async () => {
    const { root, a, r } = await setup();
    await expect(
      store.setValue(a.artifactId, r.revisionId, 'invite', 'Admin'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const outside = join(root, 'outside.mdx');
    await writeFile(outside, source);
    await rm(join(a.sourcePath, 'plan.mdx'));
    await symlink(outside, join(a.sourcePath, 'plan.mdx'));
    await expect(
      store.publish({
        artifactId: a.artifactId,
        expectedLatestRevision: r.revisionId,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
  });
  it('ignores staging directories and recovers publication after missing acknowledgement index', async () => {
    const { a, r, publish } = await setup();
    store.db.prepare('DELETE FROM operations WHERE key=?').run('publish:' + publish.operationId);
    expect(await store.publish(publish)).toEqual(r);
    expect((await store.artifact(a.artifactId)).revisions).toHaveLength(1);
  });
  it('does not expose working values via a published artifact or permit MCP approval', async () => {
    const { a, r } = await setup();
    const ops = new Operations(store, () => {});
    await store.setValue(a.artifactId, r.revisionId, 'invite', 'Member');
    const result = await ops.tool('read_artifact', {
      artifactId: a.artifactId,
      revisionId: r.revisionId,
    });
    expect(result).toMatchObject({ privateStateIncluded: false });
    await expect(ops.tool('approve', {})).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
  });
  it('defers requested version while comment is being edited', async () => {
    const { a, r } = await setup();
    const ops = new Operations(store, () => {});
    await ops.operator('editing', { active: true });
    expect(await ops.show(a.artifactId, r.revisionId)).toEqual({ status: 'deferred' });
    expect(ops.selected).toBeNull();
    await ops.operator('editing', { active: false });
    expect(ops.selected).toEqual({ artifactId: a.artifactId, revisionId: r.revisionId });
  });
});
describe('crash, recipient and directory boundaries', () => {
  it('refuses recipient changes while private feedback exists', async () => {
    const { p, a, r } = await setup();
    await store.setValue(a.artifactId, r.revisionId, 'invite', 'Member');
    await expect(store.bind(p.id, 'other-session')).rejects.toMatchObject({
      code: 'UNSUBMITTED_FEEDBACK',
    });
    const ops = new Operations(store, () => {});
    await ops.operator('bindSession', {
      projectId: p.id,
      sessionId: 'codex://threads/test-session',
    });
    await expect(
      ops.operator('bindSession', { projectId: p.id, sessionId: 'codex://threads/other-session' }),
    ).rejects.toMatchObject({ code: 'UNSUBMITTED_FEEDBACK' });
    expect(store.project(p.id).recipient?.sessionId).toBe('test-session');
  });
  it('rejects an outside source directory and outside output directories', async () => {
    const { root, a, r, p } = await setup();
    const fs = await import('node:fs/promises');
    const outside = join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'plan.mdx'), source);
    await fs.rm(a.sourcePath, { recursive: true });
    await fs.symlink(outside, a.sourcePath);
    await expect(
      store.publish({
        artifactId: a.artifactId,
        expectedLatestRevision: r.revisionId,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
    await fs.rm(a.sourcePath);
    await fs.mkdir(a.sourcePath);
    await fs.writeFile(join(a.sourcePath, 'plan.mdx'), source);
    const artifactRoot = join(p.path, '.projector', 'artifacts', a.artifactId);
    await fs.rm(join(artifactRoot, 'revisions'), { recursive: true });
    await fs.symlink(outside, join(artifactRoot, 'revisions'));
    await expect(
      store.publish({
        artifactId: a.artifactId,
        expectedLatestRevision: null,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
    await fs.rm(join(artifactRoot, 'revisions'));
    await fs.mkdir(join(artifactRoot, 'revisions'));
    await fs.symlink(outside, join(p.path, '.projector', 'feedback'));
    await fs.symlink(outside, join(p.path, '.projector', 'approvals'));
    expect(await fs.readdir(outside)).toEqual(['plan.mdx']);
  });
  it('recovers create and registered project identity when operation/index rows are missing', async () => {
    const { p, a, input } = await setup();
    store.db.prepare('DELETE FROM operations WHERE key=?').run('create:' + input.operationId);
    expect((await store.create(input)).artifactId).toBe(a.artifactId);
    store.db.prepare('DELETE FROM projects WHERE id=?').run(p.id);
    const restored = await store.register(p.path);
    expect(restored.id).toBe(p.id);
    expect((await store.artifact(a.artifactId)).projectId).toBe(p.id);
  });
  it('reconciles a package committed before clearing the draft, and preserves subsequent edits', async () => {
    const { root, p, a, r } = await setup();
    await store.setValue(a.artifactId, r.revisionId, 'invite', 'Member');
    const reconcile = store.reconcilePacket.bind(store);
    store.reconcilePacket = async () => {
      throw new Error('Simulated process loss after durable packet');
    };
    const operationId = randomUUID();
    await expect(store.submit(p.id, operationId)).rejects.toThrow('Simulated process loss');
    store.reconcilePacket = reconcile;
    store.close();
    store = await openStore(root);
    expect((await store.draft(store.project(p.id))).answers).toEqual({});
    expect(
      (await store.feedback(operationId)).answers[`${a.artifactId}:${r.revisionId}`].values.invite,
    ).toBe('Member');
    await store.setValue(a.artifactId, r.revisionId, 'invite', 'Owner');
    expect((await store.submit(p.id, operationId)).id).toBe(operationId);
    expect(
      (await store.draft(store.project(p.id))).answers[`${a.artifactId}:${r.revisionId}`].values
        .invite,
    ).toBe('Owner');
  });
  it('preserves migration after committed publication loses operation acknowledgement', async () => {
    const { a, r } = await setup();
    await store.setValue(a.artifactId, r.revisionId, 'invite', 'Member');
    await writeFile(join(a.sourcePath, 'plan.mdx'), source + '\n\nNew revision');
    const record = store.record.bind(store);
    store.record = () => {
      throw new Error('Lost acknowledgement');
    };
    const args = {
      artifactId: a.artifactId,
      expectedLatestRevision: r.revisionId,
      operationId: randomUUID(),
    };
    await expect(store.publish(args)).rejects.toThrow('Lost acknowledgement');
    store.record = record;
    const next = await store.publish(args);
    expect((await store.state(a.artifactId, next.revisionId)).values.invite).toBe('Member');
  });
});
describe('private journal and version validation', () => {
  it('recovers a pending answer journal into both state and draft', async () => {
    const { root, p, a, r } = await setup();
    const fs = await import('node:fs/promises');
    const draftPath = store.draftPath(store.project(p.id));
    const statePath = store.statePath(a.artifactId, r.revisionId);
    await fs.mkdir(join(root, 'changes'));
    await fs.writeFile(
      join(root, 'changes', 'pending.json'),
      JSON.stringify({
        statePath,
        state: { values: { invite: 'Member' } },
        draftPath,
        draft: {
          annotations: [],
          answers: {
            [`${a.artifactId}:${r.revisionId}`]: {
              artifactId: a.artifactId,
              revisionId: r.revisionId,
              values: { invite: 'Member' },
            },
          },
        },
      }),
    );
    store.close();
    store = await openStore(root);
    expect((await store.state(a.artifactId, r.revisionId)).values.invite).toBe('Member');
    await expect(store.approve(a.artifactId, r.revisionId)).rejects.toMatchObject({
      code: 'UNSUBMITTED_FEEDBACK',
    });
  });
  it('rejects newer persisted formats instead of treating them as current', async () => {
    const { p, a, r } = await setup();
    const fs = await import('node:fs/promises');
    const path = join(
      p.path,
      '.projector',
      'artifacts',
      a.artifactId,
      'revisions',
      r.revisionId,
      'manifest.json',
    );
    const manifest = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
    manifest.formatVersion = 99;
    await fs.writeFile(path, JSON.stringify(manifest));
    await expect(store.revision(a.artifactId, r.revisionId)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });
});
it('discards unpublished changes and restores the last submitted state without deleting packages', async () => {
  const { p, a, r } = await setup();
  await store.setValue(a.artifactId, r.revisionId, 'invite', 'Member');
  const packet = await store.submit(p.id, randomUUID());
  await store.setValue(a.artifactId, r.revisionId, 'invite', 'Owner');
  await store.discard(p.id);
  expect((await store.state(a.artifactId, r.revisionId)).values.invite).toBe('Member');
  expect((await store.draft(store.project(p.id))).answers).toEqual({});
  expect((await store.feedback(packet.id)).id).toBe(packet.id);
  await store.approve(a.artifactId, r.revisionId);
});
it('does not publish discarded private values inherited by a compatible new revision', async () => {
  const { a, r, p } = await setup();
  await store.setValue(a.artifactId, r.revisionId, 'invite', 'Member');
  await writeFile(join(a.sourcePath, 'plan.mdx'), source + '\n\nNew details');
  const next = await store.publish({
    artifactId: a.artifactId,
    expectedLatestRevision: r.revisionId,
    operationId: randomUUID(),
  });
  await store.discard(p.id);
  await store.approve(a.artifactId, next.revisionId);
  const approval = (await store.approval(a.artifactId, next.revisionId)) as {
    state: { values: { invite: string } };
  } | null;
  expect(approval?.state.values.invite).toBe('Owner');
});
it('rejects actual Submit and approval writes through outside directories', async () => {
  const { root, a, r, p } = await setup();
  const fs = await import('node:fs/promises');
  const outside = join(root, 'outside-write');
  await fs.mkdir(outside);
  await store.setValue(a.artifactId, r.revisionId, 'invite', 'Member');
  await fs.symlink(outside, join(p.path, '.projector', 'feedback'));
  await expect(store.submit(p.id, randomUUID())).rejects.toMatchObject({
    code: 'PATH_OUTSIDE_PROJECT',
  });
  await fs.rm(join(p.path, '.projector', 'feedback'));
  await store.discard(p.id);
  await fs.symlink(outside, join(p.path, '.projector', 'approvals'));
  await expect(store.approve(a.artifactId, r.revisionId)).rejects.toMatchObject({
    code: 'PATH_OUTSIDE_PROJECT',
  });
  expect(await fs.readdir(outside)).toEqual([]);
});
it('restores the agreed compatible baseline when discarding edits in a newer revision', async () => {
  const { a, r, p } = await setup();
  await store.setValue(a.artifactId, r.revisionId, 'invite', 'Member');
  await store.submit(p.id, randomUUID());
  await writeFile(join(a.sourcePath, 'plan.mdx'), source + '\nNew version');
  const next = await store.publish({
    artifactId: a.artifactId,
    expectedLatestRevision: r.revisionId,
    operationId: randomUUID(),
  });
  await store.setValue(a.artifactId, next.revisionId, 'invite', 'Owner');
  await store.discard(p.id);
  expect((await store.state(a.artifactId, next.revisionId)).values.invite).toBe('Member');
});

it('revokes approval append-only, retries idempotently and does not alter the saved document', async () => {
  const { a, r } = await setup();
  await store.approve(a.artifactId, r.revisionId);
  const before = await store.approvalHistory(a.artifactId, r.revisionId);
  const operationId = randomUUID();
  await store.revokeApproval(a.artifactId, r.revisionId, operationId);
  await store.revokeApproval(a.artifactId, r.revisionId, operationId);
  const after = await store.approvalHistory(a.artifactId, r.revisionId);
  expect(after).toHaveLength(before.length + 1);
  expect(after.slice(0, -1)).toEqual(before);
  expect(after.at(-1)).toMatchObject({ type: 'revoked', operationId });
  store.db.prepare('DELETE FROM operations WHERE key=?').run('revoke:' + operationId);
  await store.revokeApproval(a.artifactId, r.revisionId, operationId);
  expect(await store.approvalHistory(a.artifactId, r.revisionId)).toEqual(after);
  expect((await store.document(a.artifactId, r.revisionId)).approved).toBe(false);
  await store.approve(a.artifactId, r.revisionId);
  expect((await store.document(a.artifactId, r.revisionId)).approved).toBe(true);
});
it('reports retained, new, changed and removed fields without discarding old values', async () => {
  const { a, r } = await setup();
  await store.setValue(a.artifactId, r.revisionId, 'invite', 'Member');
  const extra =
    '<Choice id="new" meaning="New" semanticsVersion="1" options={["Yes","No"]} defaultValue="No" />';
  await writeFile(join(a.sourcePath, 'plan.mdx'), source + '\n\n' + extra);
  const next = await store.publish({
    artifactId: a.artifactId,
    expectedLatestRevision: r.revisionId,
    operationId: randomUUID(),
  });
  expect((await store.document(a.artifactId, next.revisionId)).migrationSummary).toEqual({
    retained: ['invite'],
    added: ['new'],
    requiresResponse: [],
    removed: [],
  });
  await writeFile(
    join(a.sourcePath, 'plan.mdx'),
    source.replace('semanticsVersion="1"', 'semanticsVersion="2"'),
  );
  const last = await store.publish({
    artifactId: a.artifactId,
    expectedLatestRevision: next.revisionId,
    operationId: randomUUID(),
  });
  expect((await store.document(a.artifactId, last.revisionId)).migrationSummary).toEqual({
    retained: [],
    added: [],
    requiresResponse: ['invite'],
    removed: ['new'],
  });
  expect((await store.state(a.artifactId, r.revisionId)).values.invite).toBe('Member');
});
