import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mcp } from './mcp';

let app: ElectronApplication, root: string, mcp: Mcp | undefined;
test.afterEach(async () => {
  mcp?.close();
  mcp = undefined;
  await app?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
type RpcGate = {
  arm(name: string): void;
  release(): void;
  held: boolean;
  requests: { name: string; args?: Record<string, unknown> }[];
};

// Delay the acknowledgement after the real runtime has processed an operation.
// MCP remains connected to that runtime independently and can publish while the
// shell awaits its older reply. The double controls timing, never state/content.
async function installGate() {
  const probeFile = join(root, 'ipc-probe.cjs');
  await writeFile(probeFile, 'process.parentPort.on("message",()=>{});');
  await app.evaluate(({ utilityProcess }, file) => {
    const probe = utilityProcess.fork(file, [], { stdio: 'ignore' });
    const prototype = Object.getPrototypeOf(probe);
    probe.kill();
    const post = prototype.postMessage;
    const emit = prototype.emit;
    const ids = new Map<string, string>();
    let armed: string | undefined;
    let held: { target: Electron.UtilityProcess; message: unknown } | undefined;
    const gate: RpcGate = {
      requests: [],
      get held() { return Boolean(held); },
      arm(name) {
        if (held) throw Error('Release the previous response before arming');
        gate.requests.length = 0;
        armed = name;
      },
      release() {
        const response = held;
        held = undefined;
        if (response) Reflect.apply(emit, response.target, ['message', response.message]);
      },
    };
    Object.assign(globalThis, { refreshGate: gate });
    prototype.postMessage = function (value: { type?: string; id?: string; name?: string; args?: Record<string, unknown> }) {
      if (value.type === 'operator' && value.id && value.name) {
        ids.set(value.id, value.name);
        gate.requests.push({ name: value.name, args: value.args });
      }
      return Reflect.apply(post, this, [value]);
    };
    prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
      const response = args[0] as { type?: string; id?: string } | undefined;
      if (event === 'message' && response?.type === 'operator-response' && response.id) {
        const name = ids.get(response.id);
        if (name && name === armed) {
          armed = undefined;
          held = { target: this, message: response };
          return true;
        }
      }
      return Reflect.apply(emit, this, [event, ...args]);
    };
  }, probeFile);
}
async function arm(name: string) {
  await app.evaluate((_, name) => {
    (globalThis as unknown as { refreshGate: RpcGate }).refreshGate.arm(name);
  }, name);
}
async function held() {
  await expect
    .poll(() =>
      app.evaluate(() => (globalThis as unknown as { refreshGate: RpcGate }).refreshGate.held),
    )
    .toBe(true);
}
async function release() {
  await app.evaluate(() => {
    (globalThis as unknown as { refreshGate: RpcGate }).refreshGate.release();
  });
}
async function requests(name: string) {
  return app.evaluate((_, name) => {
    return (globalThis as unknown as { refreshGate: RpcGate }).refreshGate.requests.filter(
      (request) => request.name === name,
    );
  }, name);
}
async function start() {
  root = await mkdtemp(join(tmpdir(), 'bp-refresh-'));
  const data = join(root, 'data'),
    project = join(root, 'project'),
    socket = join(root, 's.sock');
  await Promise.all([data, project].map((path) => mkdir(path)));
  const launch = () =>
    electron.launch({
      args: [resolve('.')],
      env: { ...process.env, BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: socket },
    });
  app = await launch();
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, project);
  await page.getByRole('button', { name: '+ Open project folder' }).click();
  mcp = new Mcp(socket);
  await mcp.initialize();
  const context = await mcp.tool('get_blueprint_context', {});
  const create = async (title: string) => {
    const artifact = await mcp!.tool('create_artifact', {
      projectId: (context.project as { id: string }).id,
      kind: 'blueprint',
      title,
      originSession: { harness: 'codex', sessionId: randomUUID() },
      operationId: randomUUID(),
    });
    const source = `# ${title}\n\nA decision requiring review.\n\n<TextAnswer id="answer" meaning="Decision" semanticsVersion="1" defaultValue="" />`;
    await writeFile(join(String(artifact.sourcePath), 'plan.mdx'), source);
    const revision = await mcp!.tool('publish_artifact', {
      artifactId: artifact.artifactId,
      expectedLatestRevision: null,
      operationId: randomUUID(),
    });
    return {
      artifactId: String(artifact.artifactId),
      sourcePath: String(artifact.sourcePath),
      revisionId: String(revision.revisionId),
      source,
    };
  };
  const a = await create('First refresh plan'),
    b = await create('Second refresh plan');
  await mcp.tool('show_artifact', { artifactId: a.artifactId, revisionId: a.revisionId });
  await expect(
    page.frameLocator('iframe').getByRole('heading', { name: 'First refresh plan' }),
  ).toBeVisible();
  return { page, a, b, launch, socket };
}
async function comment(page: Page, text: string, submit = true) {
  const frame = page.frameLocator('iframe');
  await frame
    .locator('p')
    .filter({ hasText: 'A decision requiring review.' })
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  await frame.getByRole('button', { name: 'Annotate', exact: true }).click();
  await frame.getByLabel('Annotation comment', { exact: true }).fill(text);
  if (submit) {
    await frame.getByLabel('Annotation comment', { exact: true }).press('Enter');
    await expect(page.locator('.annotation p')).toContainText(text);
  }
}

test('refreshes arriving during a plan load coalesce and retain a later MCP publication', async () => {
  const { page, a, b } = await start();
  await page
    .frameLocator('iframe')
    .getByLabel('Decision', { exact: true })
    .fill('Private first answer');
  await comment(page, 'Private first annotation');
  await page.getByRole('button', { name: 'Project overview', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await installGate();
  await arm('snapshot');
  await page.getByRole('button', { name: 'Second refresh plan', exact: true }).click();
  await held();
  await writeFile(
    join(String(b.sourcePath), 'plan.mdx'),
    b.source + '\n\nLatest published decision.',
  );
  const next = await mcp!.tool('publish_artifact', {
    artifactId: b.artifactId,
    expectedLatestRevision: b.revisionId,
    operationId: randomUUID(),
  });
  await mcp!.tool('show_artifact', { artifactId: b.artifactId, revisionId: next.revisionId });
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    for (let index = 0; index < 5; index++) contents.send('blueprint:refresh');
  });
  // IPC round-trip is a barrier after the delivered shell events, not a sleep.
  await page.evaluate(async () => {
    await (
      window as unknown as { blueprint: { invoke(name: string): Promise<unknown> } }
    ).blueprint.invoke('browserSnapshot');
  });
  expect(await requests('snapshot')).toHaveLength(1);
  await release();
  const frame = page.frameLocator('iframe');
  await expect(frame.getByText('Latest published decision.', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Document version' })).toHaveValue(
    String(next.revisionId),
  );
  await expect(frame.getByLabel('Decision', { exact: true })).toHaveValue('');
  await expect(page.locator('.annotation')).toHaveCount(0);
  await page.getByRole('button', { name: 'Project overview', exact: true }).click();
  await page.getByRole('button', { name: 'First refresh plan', exact: true }).click();
  await expect(frame.getByLabel('Decision', { exact: true })).toHaveValue('Private first answer');
  await expect(page.locator('.annotation p')).toHaveText(['Private first annotation']);
  expect(
    String((await mcp!.tool('read_artifact', { artifactId: a.artifactId, part: 'state' })).content),
  ).not.toContain('Private first annotation');
});

test('switching drains pending answer and annotation acknowledgements before leaving the plan', async () => {
  const { page: original, a, launch, socket } = await start();
  let page = original;
  await installGate();
  await arm('setValue');
  await page
    .frameLocator('iframe')
    .getByLabel('Decision', { exact: true })
    .fill('Pending private answer');
  await held();
  await page.getByRole('button', { name: 'Project overview', exact: true }).click();
  await page.evaluate(async () => {
    await (
      window as unknown as { blueprint: { invoke(name: string): Promise<unknown> } }
    ).blueprint.invoke('browserSnapshot');
  });
  expect(await requests('openArtifact')).toHaveLength(0);
  await release();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Second refresh plan', exact: true }).click();
  await expect(
    page.frameLocator('iframe').getByRole('heading', { name: 'Second refresh plan' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Project overview', exact: true }).click();
  await page.getByRole('button', { name: 'First refresh plan', exact: true }).click();
  await expect(page.frameLocator('iframe').getByLabel('Decision', { exact: true })).toHaveValue(
    'Pending private answer',
  );
  await comment(page, 'Pending private annotation', false);
  await arm('addAnnotation');
  await page.getByRole('button', { name: 'Project overview', exact: true }).click();
  await held();
  expect(await requests('openArtifact')).toHaveLength(0);
  await release();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Second refresh plan', exact: true }).click();
  await expect(
    page.frameLocator('iframe').getByRole('heading', { name: 'Second refresh plan' }),
  ).toBeVisible();
  mcp!.close();
  mcp = undefined;
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Project overview', exact: true }).click();
  await page.getByRole('button', { name: 'First refresh plan', exact: true }).click();
  await expect(page.frameLocator('iframe').getByLabel('Decision', { exact: true })).toHaveValue(
    'Pending private answer',
  );
  await expect(page.locator('.annotation p')).toHaveText(['Pending private annotation']);
  mcp = new Mcp(socket);
  await mcp.initialize();
  const privateState = await mcp.tool('read_artifact', { artifactId: a.artifactId, part: 'state' });
  expect(String(privateState.content)).not.toContain('Pending private');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Copy update message', exact: true }),
  ).toBeVisible();
  const saved = JSON.parse(
    String(
      (
        await mcp.tool('read_artifact', {
          artifactId: a.artifactId,
          part: 'state',
        })
      ).content,
    ),
  ) as {
    answers: Record<string, { values: { answer: string } }>;
    annotations: { text: string; annotation: string; source: { revisionId: string } }[];
  };
  expect(Object.values(saved.answers).map((answer) => answer.values.answer)).toEqual([
    'Pending private answer',
  ]);
  expect(saved.annotations).toHaveLength(1);
  expect(saved.annotations[0]).toMatchObject({
    text: 'A decision requiring review.',
    annotation: 'Pending private annotation',
    source: { revisionId: a.revisionId },
  });
});
