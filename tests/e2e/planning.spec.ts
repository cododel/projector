import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
class Mcp {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<number, (value: Record<string, unknown>) => void>();
  next = 0;
  constructor(socket: string) {
    this.child = spawn(process.execPath, [resolve('out/bridge.cjs')], {
      env: { ...process.env, BLUEPRINT_RUNTIME_DESCRIPTOR: socket },
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.id === 'number') {
        this.pending.get(value.id)?.(value);
        this.pending.delete(value.id);
      }
    });
    this.child.stderr.on('data', (chunk) => console.error(String(chunk)));
  }
  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = ++this.next;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'alpha-e2e', version: '1' },
    });
    expect(result.result).toMatchObject({
      instructions: expect.stringContaining('approval does not authorize implementation'),
    });
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }
  async tool(name: string, args: unknown): Promise<Record<string, unknown>> {
    const response = await this.request('tools/call', { name, arguments: args });
    const result = response.result as { content: { text: string }[]; isError?: boolean };
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }
  close() {
    this.child.stdin.end();
  }
}
let app: ElectronApplication;
let bridge: Mcp;
let root: string;
test.afterEach(async () => {
  bridge?.close();
  await app?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
test('production Electron + real MCP publication, review, Save, revision and restart', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-e2e-'));
  const data = join(root, 'data');
  const project = join(root, 'project');
  const socket = join(root, 's.sock');
  await mkdir(project);
  await mkdir(data);
  const launch = () =>
    electron.launch({
      args: [resolve('.')],
      env: { ...process.env, BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: socket },
    });
  app = await launch();
  const page = await app.firstWindow();
  await expect(page.getByText('Make decisions before implementation')).toBeVisible();
  await page.getByRole('button', { name: 'MCP connection', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'MCP connection' })).toContainText(
    'Production build from source',
  );
  await expect(page.getByRole('dialog', { name: 'MCP connection' })).toContainText(
    `BLUEPRINT_RUNTIME_DESCRIPTOR = ${JSON.stringify(socket)}`,
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // Exercise native folder choice with a deterministic dialog result.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, project);
  await page.getByRole('button', { name: '+ Open project folder' }).click();
  await expect(page.getByText('RECIPIENT SESSION')).toHaveCount(0);
  bridge = new Mcp(socket);
  await bridge.initialize();
  const guide = await bridge.tool('get_blueprint_guide', {});
  expect(guide.guideVersion).toBe('0.1.0-alpha.1+guide.5');
  const context = await bridge.tool('get_blueprint_context', {});
  const projectId = (context.project as { id: string }).id;
  const a = await bridge.tool('create_artifact', {
    projectId,
    kind: 'blueprint',
    title: 'Permission policy',
    originSession: { harness: 'codex', sessionId: 'isolated-alpha-session' },
    operationId: randomUUID(),
  });
  // Unpublished entities remain interactive without publishing or accepting answers.
  await page.getByRole('button', { name: 'Permission policy', exact: true }).click();
  const preview = page.frameLocator('iframe');
  await expect(page.getByRole('heading', { name: 'Waiting for your agent' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy message for agent' })).toBeVisible();
  await writeFile(join(String(a.sourcePath), 'plan.mdx'), 'import unsafe from "unsafe";');
  await page.getByRole('button', { name: 'Permission policy', exact: true }).click();
  await expect(preview.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const source =
    '# Permission policy\n\nOwners manage membership.\n\nRepeated phrase then **Repeated phrase** and final words.\n\n<Details title="Historical notes">\n\nNested **permission** contract.\n\n</Details>\n\n<Choice id="invite" meaning="Who may invite?" semanticsVersion="1" options={["Owner","Member"]} defaultValue="Owner" />';
  await writeFile(join(String(a.sourcePath), 'plan.mdx'), source);
  const r = await bridge.tool('publish_artifact', {
    artifactId: a.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  });
  await bridge.tool('show_artifact', { artifactId: a.artifactId, revisionId: r.revisionId });
  const frame = page.frameLocator('iframe');
  // The valid draft preview has the same heading. Wait for the published revision before
  // probing the iframe; its intentional draft-to-version navigation destroys the old context.
  await expect(page.getByRole('combobox', { name: 'Document version' })).toHaveValue(
    String(r.revisionId),
  );
  await expect(frame.getByRole('heading', { name: 'Permission policy' })).toBeVisible();
  const isolation = await frame.locator('body').evaluate(() => ({
    node: typeof (window as unknown as { process?: unknown }).process,
    bridge: typeof (window as unknown as { blueprint?: unknown }).blueprint,
  }));
  expect(isolation).toEqual({ node: 'undefined', bridge: 'undefined' });
  const denied = await frame.locator('body').evaluate(
    () =>
      new Promise<string>((resolve) => {
        const id = crypto.randomUUID();
        const handler = (event: MessageEvent) => {
          if (event.data?.id === id) {
            window.removeEventListener('message', handler);
            resolve(String(event.data.error));
          }
        };
        window.addEventListener('message', handler);
        window.parent.postMessage(
          { type: 'blueprint-request', id, method: 'approve', params: {} },
          'blueprint://app',
        );
      }),
  );
  expect(denied).toBe('Document operation is not allowed.');

  await frame.getByLabel('Member', { exact: true }).check();
  await expect(page.getByText('Saved locally')).toBeVisible();
  await frame
    .locator('p')
    .filter({ hasText: 'Owners manage membership.' })
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  await expect(frame.getByLabel('Annotation comment')).toHaveCount(0);
  await frame.getByRole('button', { name: 'Annotate', exact: true }).click();
  await frame.getByLabel('Annotation comment').fill('Clarify delegation rules');
  await frame.locator('.annotation-comment-composer').evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
  await page.screenshot({ path: '.tmp/tasks/annotation-polish-20261010/document-composer.png' });
  await frame.getByRole('button', { name: 'Save private annotation' }).click();
  await expect(page.getByText('Clarify delegation rules')).toBeVisible();
  const before = await bridge.tool('read_artifact', { artifactId: a.artifactId, part: 'state' });
  expect(String(before.content)).not.toContain('Clarify delegation rules');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Copy update message', exact: true }).first(),
  ).toBeVisible();
  const feedback = await bridge.tool('read_artifact', { artifactId: a.artifactId, part: 'state' });
  expect(String(feedback.content)).toContain('Clarify delegation rules');
  expect(String(feedback.content)).toContain('Member');
  // Select the second occurrence and cross bold/plain leaf boundaries.
  const repeated = frame.locator('p').filter({ hasText: 'Repeated phrase then' });
  await repeated.evaluate((element) => {
    const start = element.querySelector('strong span')?.firstChild;
    const end = element.querySelectorAll('span')[2]?.firstChild;
    if (!start || !end) throw new Error('Missing rendered text leaves');
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, 10);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(frame.getByLabel('Annotation comment')).toHaveCount(0);
  await frame.getByRole('button', { name: 'Annotate', exact: true }).click();
  await frame.getByLabel('Annotation comment').fill('The second occurrence crosses text leaves');
  await frame.getByRole('button', { name: 'Save private annotation' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const precise = await bridge.tool('read_artifact', { artifactId: a.artifactId, part: 'state' });
  const saved = JSON.parse(String(precise.content)) as {
    annotations: {
      text?: string;
      quote?: string;
      source?: { anchor?: { start: { path: number[] }; end: { path: number[] } } };
      anchor?: { start: { path: number[] }; end: { path: number[] } };
    }[];
  };
  expect(saved.annotations).toHaveLength(2);
  const anchor = saved.annotations[1].source?.anchor ?? saved.annotations[1].anchor;
  expect(anchor?.start.path).not.toEqual(anchor?.end.path);
  await page.getByRole('button', { name: 'Delete annotation 2', exact: true }).click();
  await expect(page.locator('.annotation')).toHaveCount(1);
  await expect(frame.locator('.inline-annotation-number')).toHaveCount(1);
  await expect(frame.locator('.inline-annotation-number')).toHaveText('1');
  await expect(
    page.getByRole('button', { name: 'Approve this version', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Approve this version', exact: true }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await writeFile(join(String(a.sourcePath), 'plan.mdx'), source + '\n\nDelegation is explicit.');
  const next = await bridge.tool('publish_artifact', {
    artifactId: a.artifactId,
    expectedLatestRevision: r.revisionId,
    operationId: randomUUID(),
  });
  await bridge.tool('show_artifact', { artifactId: a.artifactId, revisionId: next.revisionId });
  await expect(frame.getByText('Delegation is explicit.')).toBeVisible();
  await expect(frame.getByLabel('Member', { exact: true })).toBeChecked();
  await expect(page.getByText('In review', { exact: true })).toBeVisible();
  // Close last window: macOS runtime survives and bridge still answers.
  await page.close();
  expect((await bridge.tool('get_blueprint_guide', {})).guideVersion).toBe('0.1.0-alpha.1+guide.5');
  bridge.close();
  await app.close();
  app = await launch();
  const restarted = await app.firstWindow();
  await restarted.getByRole('button', { name: 'Permission policy', exact: true }).click();
  await expect(
    restarted.frameLocator('iframe').getByLabel('Member', { exact: true }),
  ).toBeChecked();
  await expect(restarted.getByText('Saved states', { exact: true })).toBeAttached();
  await restarted.screenshot({ path: '.tmp/alpha-production.png' });
});
test('unfinished private annotation survives restart and cannot approve the document', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-editor-'));
  const data = join(root, 'data');
  const project = join(root, 'project');
  const socket = join(root, 's.sock');
  await mkdir(data);
  await mkdir(project);
  const launch = () =>
    electron.launch({
      args: [resolve('.')],
      env: { ...process.env, BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: socket },
    });
  app = await launch();
  let page = await app.firstWindow();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, project);
  await page.getByRole('button', { name: '+ Open project folder' }).click();
  bridge = new Mcp(socket);
  await bridge.initialize();
  const context = await bridge.tool('get_blueprint_context', {});
  const artifact = await bridge.tool('create_artifact', {
    projectId: (context.project as { id: string }).id,
    kind: 'blueprint',
    title: 'Access policy planning',
    originSession: { harness: 'codex', sessionId: 'editor-session' },
    operationId: randomUUID(),
  });
  await writeFile(
    join(String(artifact.sourcePath), 'plan.mdx'),
    '# Access policy planning\n\nAgree on the permission contract before implementation.',
  );
  const revision = await bridge.tool('publish_artifact', {
    artifactId: artifact.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  });
  await bridge.tool('show_artifact', {
    artifactId: artifact.artifactId,
    revisionId: revision.revisionId,
  });
  let frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Access policy planning' })).toBeVisible();
  await frame
    .locator('p')
    .filter({ hasText: 'Agree on the permission contract before implementation.' })
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selected = window.getSelection();
      selected?.removeAllRanges();
      selected?.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  await frame.getByRole('button', { name: 'Annotate', exact: true }).click();
  await frame.getByLabel('Annotation comment').fill('Keep this unfinished comment');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect
    .poll(async () => {
      return page.evaluate(async () => {
        const api = (
          window as unknown as {
            blueprint: { invoke: (name: string, args?: unknown) => Promise<unknown> };
          }
        ).blueprint;
        const snapshot = (await api.invoke('snapshot')) as {
          selected: { artifactId: string; revisionId: string };
        };
        const doc = (await api.invoke('getDocument', snapshot.selected)) as {
          editor?: { comment: string };
        };
        return doc.editor?.comment;
      });
    })
    .toBe('Keep this unfinished comment');
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Access policy planning', exact: true }).click();
  frame = page.frameLocator('iframe');
  await expect(frame.getByLabel('Annotation comment')).toHaveValue('Keep this unfinished comment');
  await expect(
    page.getByRole('button', { name: 'Approve this version', exact: true }),
  ).toBeDisabled();
  await frame.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(frame.getByLabel('Annotation comment')).toHaveCount(0);
});

test('overlapping markers, disclosed old-version navigation and private annotation edits survive restart', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-anchor-'));
  const data = join(root, 'data'),
    project = join(root, 'project'),
    socket = join(root, 's.sock');
  await mkdir(data);
  await mkdir(project);
  const launch = () =>
    electron.launch({
      args: [resolve('.')],
      env: { ...process.env, BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: socket },
    });
  app = await launch();
  let page = await app.firstWindow();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, project);
  await page.getByRole('button', { name: '+ Open project folder' }).click();
  bridge = new Mcp(socket);
  await bridge.initialize();
  const context = await bridge.tool('get_blueprint_context', {});
  const a = await bridge.tool('create_artifact', {
    projectId: (context.project as { id: string }).id,
    kind: 'blueprint',
    title:
      'A long artifact title with many words that must remain at most two lines in the compact sidebar',
    originSession: { harness: 'codex', sessionId: 'anchors-test' },
    operationId: randomUUID(),
  });
  const source =
    '# Anchor checks\n\n<Details title="Earlier decisions">\n\nRepeated **decision** text.\n\n</Details>';
  await writeFile(join(String(a.sourcePath), 'plan.mdx'), source);
  const revision = await bridge.tool('publish_artifact', {
    artifactId: a.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  });
  await bridge.tool('show_artifact', { artifactId: a.artifactId, revisionId: revision.revisionId });
  let frame = page.frameLocator('iframe');
  await frame.locator('summary').click();
  for (const comment of ['First overlapping comment', 'Second overlapping comment']) {
    await frame
      .locator('p')
      .filter({ hasText: 'Repeated decision text.' })
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selected = window.getSelection();
        selected?.removeAllRanges();
        selected?.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
    await frame.getByRole('button', { name: 'Annotate', exact: true }).click();
    await frame.getByLabel('Annotation comment').fill(comment);
    await frame.getByLabel('Annotation comment').evaluate((element) => {
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
      );
    });
    await expect(frame.getByLabel('Annotation comment')).toHaveValue(comment);
    await frame.getByLabel('Annotation comment').press('Shift+Enter');
    await expect(frame.getByLabel('Annotation comment')).toHaveValue(comment + '\n');
    if (comment.startsWith('Second')) {
      await frame.getByLabel('Annotation comment').press('x');
    } else {
      await frame.getByLabel('Annotation comment').press('Backspace');
      await frame.locator('.annotation-comment-composer').evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished),
        );
      });
      await page.screenshot({ path: '.tmp/tasks/comment-composer-20261009/create.png' });
    }
    await frame.getByLabel('Annotation comment').press('Enter');
    await expect(frame.getByLabel('Annotation comment')).toHaveCount(0);
    await expect(
      page.getByText(comment.startsWith('Second') ? comment + '\nx' : comment, { exact: true }),
    ).toBeVisible();
  }
  await expect(frame.locator('.inline-annotation-number')).toHaveText(['1', '2']);
  await expect(page.locator('svg.annotation-number')).toHaveCount(2);
  await expect(page.locator('svg.annotation-number text').first()).toHaveAttribute(
    'font-size',
    '10',
  );
  const badgeOutline = await page
    .locator('svg.annotation-number path')
    .first()
    .evaluate((path) => {
      const box = (path as SVGGraphicsElement).getBBox();
      return { width: box.width, height: box.height };
    });
  expect(badgeOutline.width).toBeCloseTo(22, 1);
  expect(badgeOutline.height).toBeCloseTo(22, 1);
  await expect(page.locator('svg.annotation-number path').first()).toHaveAttribute(
    'stroke',
    'white',
  );
  await page.screenshot({ path: '.tmp/tasks/annotation-markers-20261011/compact-badges.png' });
  await page
    .locator('svg.annotation-number')
    .first()
    .screenshot({ path: '.tmp/tasks/annotation-markers-20261011/round-badge.png' });
  const boxes = await frame
    .locator('.inline-annotation-number path')
    .evaluateAll((elements) => elements.map((e) => e.getBoundingClientRect().x));
  expect(boxes[0]).not.toBe(boxes[1]);
  // Neighboring annotations keep compact badges, rather than stretching a tail to the quote.
  for (const path of await frame.locator('.inline-annotation-number path').all()) {
    expect(await path.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(
      30,
    );
  }
  await frame.locator('body').evaluate((body) => {
    const spacer = document.createElement('div');
    spacer.id = 'scroll-fixture';
    spacer.style.height = '2200px';
    body.append(spacer);
    window.scrollTo(0, 800);
  });
  await expect(frame.locator('.inline-annotation-number')).toHaveCount(0);
  await frame.locator('body').evaluate(() => window.scrollTo(0, 0));
  await expect(frame.locator('.inline-annotation-number')).toHaveText(['1', '2']);
  await frame
    .locator('p')
    .filter({ hasText: 'Repeated decision text.' })
    .evaluate((paragraph) => {
      const clip = document.createElement('div');
      clip.id = 'nested-annotation-scroll';
      clip.style.cssText = 'width:120px;height:50px;overflow:auto';
      paragraph.before(clip);
      clip.append(paragraph);
      paragraph.style.cssText = 'width:400px;white-space:nowrap;margin:0';
    });
  // The quote is partly visible, but its annotation point is clipped.
  await expect(frame.locator('.inline-annotation-number')).toHaveCount(0);
  await frame.locator('#nested-annotation-scroll').evaluate((element) => {
    element.scrollLeft = 80;
  });
  await expect(frame.locator('.inline-annotation-number')).toHaveText(['1', '2']);
  await frame.locator('#nested-annotation-scroll').evaluate((element) => {
    element.scrollLeft = 240;
  });
  await expect(frame.locator('.inline-annotation-number')).toHaveCount(0);
  await frame.locator('#nested-annotation-scroll').evaluate((element) => {
    const paragraph = element.querySelector('p')!;
    paragraph.removeAttribute('style');
    element.replaceWith(paragraph);
    document.getElementById('scroll-fixture')?.remove();
  });
  await expect(frame.locator('.inline-annotation-number')).toHaveText(['1', '2']);
  const height = await page.locator('.plan-row').evaluate((e) => e.getBoundingClientRect().height);
  expect(height).toBeLessThanOrEqual(36);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Edit annotation 1', exact: true }).click();
  await page.getByLabel('Edit annotation', { exact: true }).fill('Unfinished edit remains private');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const api = (
          window as unknown as {
            blueprint: { invoke(name: string, args?: unknown): Promise<unknown> };
          }
        ).blueprint;
        const snapshot = (await api.invoke('snapshot')) as { selected: unknown };
        const document = (await api.invoke('getDocument', snapshot.selected)) as {
          editor?: { comment: string };
        };
        return document.editor?.comment;
      }),
    )
    .toBe('Unfinished edit remains private');
  const before = await bridge.tool('read_artifact', { artifactId: a.artifactId, part: 'state' });
  expect(String(before.content)).toContain('First overlapping comment');
  expect(String(before.content)).not.toContain('Unfinished edit remains private');
  bridge.close();
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  frame = page.frameLocator('iframe');
  await expect(page.getByLabel('Edit annotation', { exact: true })).toHaveValue(
    'Unfinished edit remains private',
  );
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByLabel('Edit annotation', { exact: true }).press('Enter');
  await expect(page.getByText('Unfinished edit remains private', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  bridge = new Mcp(socket);
  await bridge.initialize();
  await writeFile(join(String(a.sourcePath), 'plan.mdx'), source + '\n\nNew revision note.');
  const next = await bridge.tool('publish_artifact', {
    artifactId: a.artifactId,
    expectedLatestRevision: revision.revisionId,
    operationId: randomUUID(),
  });
  await bridge.tool('show_artifact', { artifactId: a.artifactId, revisionId: next.revisionId });
  await expect(frame.getByText('New revision note.')).toBeVisible();
  await page.locator('.annotation-jump').first().click();
  await expect(page.getByLabel('Document version')).toHaveValue(String(revision.revisionId));
  await expect(frame.locator('details')).toHaveAttribute('open', '');
  await expect(frame.locator('.text-highlight.focused').first()).toBeVisible();
  await page.getByRole('button', { name: 'Edit annotation 2', exact: true }).click();
  await page.getByLabel('Edit annotation', { exact: true }).fill('ee');
  await page.getByLabel('Edit annotation', { exact: true }).press('Shift+Enter');
  await page.getByLabel('Edit annotation', { exact: true }).press('x');
  await expect(page.getByLabel('Edit annotation', { exact: true })).toHaveValue('ee\nx');
  await page.screenshot({ path: '.tmp/tasks/comment-composer-20261009/edit.png' });
  await page.getByLabel('Edit annotation', { exact: true }).press('Escape');
  await expect(page.getByText('Second overlapping comment\nx', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Edit annotation', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit annotation 2', exact: true }).click();
  await page
    .locator('.annotation-comment-composer')
    .getByRole('button', { name: 'Delete annotation' })
    .click();
  await expect(page.locator('.annotation')).toHaveCount(1);
});

test('text markers bind to widget and disclosure state and historical preview never overwrites working answers', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-bound-state-'));
  const data = join(root, 'data'),
    project = join(root, 'project'),
    socket = join(root, 's.sock');
  await mkdir(data);
  await mkdir(project);
  app = await electron.launch({
    args: [resolve('.')],
    env: { ...process.env, BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: socket },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, project);
  await page.getByRole('button', { name: '+ Open project folder' }).click();
  bridge = new Mcp(socket);
  await bridge.initialize();
  const context = await bridge.tool('get_blueprint_context', {});
  const a = await bridge.tool('create_artifact', {
    projectId: (context.project as { id: string }).id,
    kind: 'blueprint',
    title: 'State-bound feedback',
    originSession: { harness: 'codex', sessionId: 'state-bound' },
    operationId: randomUUID(),
  });
  await writeFile(
    join(String(a.sourcePath), 'plan.mdx'),
    '# State-bound feedback\n\n<TextAnswer id="answer" meaning="Chosen value" semanticsVersion="1" defaultValue="Original" />\n\n<Details title="Decision details">\n\nA specific decision in this state.\n\n</Details>',
  );
  const r = await bridge.tool('publish_artifact', {
    artifactId: a.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  });
  await bridge.tool('show_artifact', { artifactId: a.artifactId, revisionId: r.revisionId });
  const frame = page.frameLocator('iframe');
  await frame.locator('summary').click();
  await frame
    .locator('p')
    .filter({ hasText: 'A specific decision in this state.' })
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selected = window.getSelection();
      selected?.removeAllRanges();
      selected?.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  await frame.getByRole('button', { name: 'Annotate', exact: true }).click();
  await frame.getByLabel('Annotation comment').fill('The original expanded decision');
  await frame.getByRole('button', { name: 'Save private annotation' }).click();
  await expect(frame.getByLabel('Annotation comment')).toHaveCount(0);
  await expect(frame.locator('.inline-annotation-number')).toHaveCount(1);
  const badge = frame.locator('.inline-annotation-number');
  expect(await badge.evaluate((element) => getComputedStyle(element, '::after').clipPath)).not.toBe(
    'none',
  );
  await page.getByRole('button', { name: 'Annotate document', exact: true }).click();
  const paragraphBox = await frame
    .locator('p')
    .filter({ hasText: 'A specific decision in this state.' })
    .boundingBox();
  if (!paragraphBox) throw Error('Missing bound text');
  await page.mouse.move(paragraphBox.x + 20, paragraphBox.y + paragraphBox.height / 2);
  await expect(frame.locator('.element-hover-outline')).toBeVisible();
  await page.screenshot({ path: '.tmp/tasks/annotation-context-20261009/document-pointer.png' });
  await page.keyboard.press('Escape');
  await expect(frame.getByLabel('Select annotation area')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = JSON.parse(
    String(
      (await bridge.tool('read_artifact', { artifactId: a.artifactId, part: 'state' })).content,
    ),
  ) as {
    annotations: {
      source: {
        stateContext: {
          stateHash: string;
          values: { answer: string };
          view: { details: Record<string, boolean> };
        };
      };
    }[];
  };
  expect(saved.annotations[0].source.stateContext.values.answer).toBe('Original');
  expect(Object.values(saved.annotations[0].source.stateContext.view.details)).toEqual([true]);
  await frame.getByLabel('Chosen value', { exact: true }).fill('Working value');
  await expect(frame.locator('.inline-annotation-number')).toHaveCount(0);
  await frame.locator('summary').click();
  await expect(frame.locator('details')).not.toHaveAttribute('open', '');
  await page.locator('.annotation-jump').click();
  await expect(frame.getByRole('button', { name: 'Return to working state' })).toBeVisible();
  await expect(frame.getByLabel('Chosen value', { exact: true })).toHaveValue('Original');
  await expect(frame.getByLabel('Chosen value', { exact: true })).toBeDisabled();
  await expect(frame.locator('details')).toHaveAttribute('open', '');
  await expect(frame.locator('.inline-annotation-number')).toHaveCount(1);
  const actual = await page.evaluate(async () => {
    const api = (
      window as unknown as { blueprint: { invoke(name: string, args?: unknown): Promise<unknown> } }
    ).blueprint;
    const snapshot = (await api.invoke('snapshot')) as { selected: unknown };
    return api.invoke('getDocument', snapshot.selected);
  });
  expect(actual).toMatchObject({ state: { values: { answer: 'Working value' } } });
  await frame.getByRole('button', { name: 'Return to working state' }).click();
  await expect(frame.getByLabel('Chosen value', { exact: true })).toHaveValue('Working value');
  await expect(frame.getByLabel('Chosen value', { exact: true })).toBeEnabled();
  await expect(frame.locator('details')).not.toHaveAttribute('open', '');
  await expect(frame.locator('.inline-annotation-number')).toHaveCount(0);
  await frame.getByLabel('Chosen value', { exact: true }).fill('Original');
  await frame.locator('summary').click();
  await expect(frame.locator('.inline-annotation-number')).toHaveCount(1);
  await frame.locator('summary').click();
  await expect(frame.locator('.inline-annotation-number')).toHaveCount(0);
});
