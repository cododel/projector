import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { Mcp } from './mcp';

interface CompletedTool {
  tool: string;
  arguments: Record<string, unknown>;
  result: { content: { type: string; text?: string }[] };
  error: unknown;
  status: string;
}

function completedTools(log: string): CompletedTool[] {
  return log
    .trim()
    .split('\n')
    .flatMap((line) => {
      const event = JSON.parse(line) as {
        type: string;
        item?: CompletedTool & { type: string; server: string };
      };
      return event.type === 'item.completed' &&
        event.item?.type === 'mcp_tool_call' &&
        event.item.server === 'blueprint'
        ? [event.item]
        : [];
    });
}

function modelRead(tools: CompletedTool[], name: string, args: Record<string, unknown>): string {
  let cursor: string | null = null;
  let output = '';
  const visited = new Set<string | null>();
  do {
    expect(visited.has(cursor), `${name}: repeated cursor`).toBe(false);
    visited.add(cursor);
    const call = tools.find(
      (tool) =>
        tool.tool === name &&
        Object.entries(args).every(([key, value]) => tool.arguments[key] === value) &&
        (tool.arguments.cursor ?? null) === cursor,
    );
    expect(call, `${name}: missing completed read for cursor ${cursor}`).toBeDefined();
    expect(call!.status).toBe('completed');
    expect(call!.error).toBeNull();
    const result = JSON.parse(
      call!.result.content.find((content) => content.type === 'text')!.text!,
    ) as Record<string, unknown>;
    expect(typeof result.content).toBe('string');
    expect(result.artifactId).toBe(args.artifactId);
    expect(result.savedStateId).toBe(args.savedStateId);
    if (args.attachmentId) expect(result.id).toBe(args.attachmentId);
    output += String(result.content);
    expect(result.complete).toBe(result.cursor === null);
    expect(result.cursor === null || typeof result.cursor === 'string').toBe(true);
    cursor = result.cursor as string | null;
  } while (cursor !== null);
  return output;
}
test('Codex CLI model obtains bundled guide and publishes a plan', async () => {
  test.skip(
    process.env.BLUEPRINT_CODEX_TEST !== '1',
    'Opt-in: uses authenticated Codex and a model; standard suite is offline.',
  );
  test.setTimeout(180000);
  const root = await mkdtemp(join(tmpdir(), 'bp-codex-'));
  const project = join(root, 'project');
  const data = join(root, 'data');
  const socket = join(root, 's.sock');
  await mkdir(project);
  await mkdir(data);
  const app = await electron.launch({
    args: [resolve('.')],
    env: { ...process.env, BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: socket },
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    await page.getByRole('button', { name: '+ Open project folder' }).click();
    const prompt =
      'This is an isolated Blueprint integration test in a disposable folder. Use only the blueprint MCP server and local file writes under this folder. Call get_blueprint_guide overview and authoring and widgets, then get_blueprint_context. Create exactly one artifact of kind blueprint with title "Codex permission plan", using the returned project id and explicit originSession {harness:"codex",sessionId:"codex-isolated-test"}. This supplied session identity is test metadata, not a detected live session. Write plan.mdx with heading Codex permission plan, one Choice widget id invite meaning "Who may invite?" semanticsVersion "1", options Owner and Member, defaultValue Owner. Publish first revision with expectedLatestRevision null and a unique operationId. Call show_artifact. Do not change user config, skills, hooks or existing sessions. Do not implement the planned feature. Return artifactId and revisionId.';
    child = spawn(
      'codex',
      [
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--json',
        '-C',
        project,
        ...[
          'get_blueprint_guide',
          'get_blueprint_context',
          'create_artifact',
          'publish_artifact',
          'read_artifact',
          'read_attachment',
          'show_artifact',
          'list_feedback',
          'read_feedback',
          'report_feedback',
        ].flatMap((name) => ['-c', `mcp_servers.blueprint.tools.${name}.approval_mode="auto"`]),
        '-c',
        `mcp_servers.blueprint.command=${JSON.stringify(process.execPath)}`,
        '-c',
        `mcp_servers.blueprint.args=[${JSON.stringify(resolve('out/bridge.cjs'))}]`,
        '-c',
        `mcp_servers.blueprint.env.BLUEPRINT_RUNTIME_DESCRIPTOR=${JSON.stringify(socket)}`,
        prompt,
      ],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    let errors = '';
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      log += line + '\n';
    });
    child.stderr!.on('data', (chunk) => {
      errors += String(chunk);
    });
    const code = await new Promise<number | null>((res, rej) => {
      child!.once('exit', res);
      child!.once('error', rej);
    });
    await writeFile(resolve('.tmp/codex-alpha-events.jsonl'), log);
    await writeFile(resolve('.tmp/codex-alpha-stderr.txt'), errors);
    expect(code, errors).toBe(0);
    const snapshot = await page.evaluate(async () => {
      return (
        window as unknown as {
          blueprint: {
            invoke: (
              name: string,
            ) => Promise<{
              artifacts: { id: string; title: string; latestRevision: string | null }[];
            }>;
          };
        }
      ).blueprint.invoke('snapshot');
    });
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.artifacts[0].latestRevision).toBeTruthy();
    await expect(
      page.frameLocator('iframe').getByRole('heading', { name: 'Codex permission plan' }),
    ).toBeVisible();
    const frame = page.frameLocator('iframe');
    await frame.getByLabel('Member', { exact: true }).check();
    await expect(page.getByText('Saved locally')).toBeVisible();
    await page.getByRole('button', { name: 'Annotate document', exact: true }).click();
    const area = await frame.getByLabel('Select annotation area').boundingBox();
    if (!area) throw new Error('Missing document capture surface');
    await page.mouse.move(area.x + 25, area.y + 30);
    await page.mouse.down();
    await page.mouse.move(area.x + 220, area.y + 100);
    await page.mouse.up();
    await frame.getByLabel('Annotation comment').fill('Review the captured permission heading');
    await frame.getByLabel('Annotation comment').press('Enter');
    await expect(page.locator('.annotation p')).toContainText(
      'Review the captured permission heading',
    );
    const client = new Mcp(socket);
    try {
      await client.initialize();
      const privateArtifact = snapshot.artifacts[0];
      expect(
        await client.tool('read_artifact', { artifactId: privateArtifact.id, part: 'state' }),
      ).toMatchObject({ savedState: null });
    } finally {
      client.close();
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Copy update message', exact: true }).first(),
    ).toBeVisible();
    const published = await page.evaluate(async () => {
      return (
        window as unknown as {
          blueprint: {
            invoke: (name: string) => Promise<{
              savedStates: { id: string }[];
              artifacts: { id: string; latestRevision: string }[];
            }>;
          };
        }
      ).blueprint.invoke('snapshot');
    });
    const packet = published.savedStates[0].id;
    const artifact = published.artifacts[0];
    const reference = new Mcp(socket);
    let expectedState: {
      id: string;
      annotations: { comment: string; source: { attachmentId: string } }[];
    };
    let expectedImage = '';
    try {
      await reference.initialize();
      const readAll = async (name: string, args: Record<string, unknown>) => {
        let cursor: string | null = null;
        let content = '';
        do {
          const result = await reference.tool(name, { ...args, ...(cursor ? { cursor } : {}) });
          content += String(result.content);
          cursor = result.cursor as string | null;
        } while (cursor !== null);
        return content;
      };
      expectedState = JSON.parse(
        await readAll('read_artifact', {
          artifactId: artifact.id,
          part: 'state',
          savedStateId: packet,
        }),
      );
      expect(expectedState.annotations).toHaveLength(1);
      expect(expectedState.annotations[0].comment).toBe('Review the captured permission heading');
      expectedImage = await readAll('read_attachment', {
        artifactId: artifact.id,
        savedStateId: packet,
        attachmentId: expectedState.annotations[0].source.attachmentId,
      });
    } finally {
      reference.close();
    }
    await app.evaluate(({ clipboard }) => {
      // Keep the operator's clipboard intact; real desktop clipboard is a manual boundary.
      clipboard.writeText = async (text) => {
        (globalThis as unknown as { blueprintTestCopied: string }).blueprintTestCopied = text;
      };
    });
    await page.getByRole('button', { name: 'Copy update message', exact: true }).first().click();
    // Copy validates the immutable saved state before writing the clipboard.
    await expect(page.getByRole('button', { name: 'Copied', exact: true }).first()).toBeVisible();
    const update = await app.evaluate(
      () => (globalThis as unknown as { blueprintTestCopied: string }).blueprintTestCopied,
    );
    expect(update).toContain(artifact.id);
    expect(update).toContain(packet);
    const second = `Continue only the Blueprint test. The operator manually supplies this copied message: ${update}. Call get_blueprint_guide annotations, then read_artifact(artifactId="${artifact.id}", part="state", savedStateId="${packet}"). Read the annotation screenshot with read_attachment using its returned attachmentId; follow all cursors until complete, and retain the separate annotation comment. Read the published artifact ${artifact.id} revision ${artifact.latestRevision}, source part if needed. Publish a second revision of the same artifact preserving its widget definition, with a new paragraph "Members may invite after explicit agreement." Set expectedLatestRevision to ${artifact.latestRevision}. Call show_artifact for the new revision. Do not implement anything or change configuration. Return only confirmation of the feedback decision and new revision.`;
    child = spawn(
      'codex',
      [
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        '--json',
        '-C',
        project,
        ...[
          'get_blueprint_guide',
          'get_blueprint_context',
          'create_artifact',
          'publish_artifact',
          'read_artifact',
          'read_attachment',
          'show_artifact',
          'list_feedback',
          'read_feedback',
          'report_feedback',
        ].flatMap((name) => ['-c', `mcp_servers.blueprint.tools.${name}.approval_mode="auto"`]),
        '-c',
        `mcp_servers.blueprint.command=${JSON.stringify(process.execPath)}`,
        '-c',
        `mcp_servers.blueprint.args=[${JSON.stringify(resolve('out/bridge.cjs'))}]`,
        '-c',
        `mcp_servers.blueprint.env.BLUEPRINT_RUNTIME_DESCRIPTOR=${JSON.stringify(socket)}`,
        second,
      ],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let secondLog = '';
    let secondErrors = '';
    createInterface({ input: child.stdout! }).on('line', (line) => {
      secondLog += line + '\n';
    });
    child.stderr!.on('data', (chunk) => {
      secondErrors += String(chunk);
    });
    const nextCode = await new Promise<number | null>((res, rej) => {
      child!.once('exit', res);
      child!.once('error', rej);
    });
    await writeFile(resolve('.tmp/codex-alpha-feedback-events.jsonl'), secondLog);
    await writeFile(resolve('.tmp/codex-alpha-feedback-stderr.txt'), secondErrors);
    expect(nextCode, secondErrors).toBe(0);
    await expect(frame.getByText('Members may invite after explicit agreement.')).toBeVisible();
    await expect(frame.getByLabel('Member', { exact: true })).toBeChecked();
    expect(log).toContain('get_blueprint_guide');
    expect(secondLog).toContain('read_artifact');
    expect(secondLog).toContain('read_attachment');
    expect(secondLog).toContain('Review the captured permission heading');
    const tools = completedTools(secondLog);
    expect(
      JSON.parse(
        modelRead(tools, 'read_artifact', {
          artifactId: artifact.id,
          part: 'state',
          savedStateId: packet,
        }),
      ),
    ).toEqual(expectedState);
    const image = modelRead(tools, 'read_attachment', {
      artifactId: artifact.id,
      savedStateId: packet,
      attachmentId: expectedState.annotations[0].source.attachmentId,
    });
    const sha256 = (base64: string) =>
      createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
    expect(image.length).toBe(expectedImage.length);
    expect(sha256(image)).toBe(sha256(expectedImage));
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
