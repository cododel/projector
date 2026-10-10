import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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
    env: { ...process.env, BLUEPRINT_DATA: data, BLUEPRINT_SOCKET: socket },
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
        `mcp_servers.blueprint.env.BLUEPRINT_SOCKET=${JSON.stringify(socket)}`,
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
            ) => Promise<{ artifacts: { title: string; latestRevision: string | null }[] }>;
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
    const second = `Continue only the Blueprint test. Call get_blueprint_guide annotations, then read_artifact(artifactId="${artifact.id}", part="state", savedStateId="${packet}"). Read the published artifact ${artifact.id} revision ${artifact.latestRevision}, source part if needed. Publish a second revision of the same artifact preserving its widget definition, with a new paragraph "Members may invite after explicit agreement." Set expectedLatestRevision to ${artifact.latestRevision}. Call show_artifact for the new revision. Do not implement anything or change configuration. Return only confirmation of the feedback decision and new revision.`;
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
        `mcp_servers.blueprint.env.BLUEPRINT_SOCKET=${JSON.stringify(socket)}`,
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
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
