import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';

let app: ElectronApplication | undefined, root: string;
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});
test('session pin persists; archive and undo preserve workspaces and use exact protocol IDs', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bp-session-actions-')));
  const project = join(root, 'project'),
    data = join(root, 'data'),
    home = join(root, 'home');
  await Promise.all([project, data, home].map((path) => mkdir(path)));
  const metadata = join(root, 'metadata.json'),
    audit = join(root, 'audit.jsonl');
  await writeFile(
    metadata,
    JSON.stringify({
      'pin-target': { name: 'Second chat', updatedAt: 1 },
      'thread-exact-fixture': { name: 'First chat', updatedAt: 2 },
    }),
  );
  const launch = () =>
    electron.launch({
      args: [resolve('.')],
      env: {
        ...process.env,
        PROJECTOR_DATA: data,
        PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'endpoint.json'),
        CODEX_HOME: home,
        CODEX_FIXTURE_PROJECT: project,
        CODEX_FIXTURE_EMPTY: '0',
        CODEX_FIXTURE_METADATA_FILE: metadata,
        CODEX_FIXTURE_AUDIT: audit,
        PROJECTOR_E2E_HARNESS_INTERVAL_MS: '200',
      },
    });
  app = await launch();
  let page = await app.firstWindow();
  const state = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          projector: { invoke(name: string): Promise<ApplicationWorkspaceSnapshot> };
        }
      ).projector.invoke('applicationSnapshot'),
    );
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  }, project);
  await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Second chat', exact: true })).toBeVisible();
  const before = await state();
  await page.getByRole('button', { name: 'Pin Second chat', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Unpin Second chat', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect((await state()).selectedWorkspace).toBe(before.selectedWorkspace);
  expect(await page.locator('.harness-session .session-title').first().textContent()).toBe(
    'Second chat',
  );
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await expect(page.getByRole('button', { name: 'Unpin Second chat', exact: true })).toBeVisible();
  const preserved = (await state()).workspaces;
  await page.getByRole('button', { name: 'Archive Second chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Second chat', exact: true })).toHaveCount(0);
  const notice = page.locator('.archive-notice');
  await expect(notice).toContainText('Archived chat');
  await expect(notice.getByRole('button', { name: 'View', exact: true })).toHaveCount(0);
  await expect(notice).toHaveCSS('opacity', '1');
  const noticeBounds = await notice.boundingBox();
  const toolbarBounds = await page.getByRole('toolbar', { name: 'Window toolbar', exact: true }).boundingBox();
  expect(noticeBounds!.y).toBeGreaterThanOrEqual(toolbarBounds!.y + toolbarBounds!.height);
  expect(noticeBounds!.y).toBeLessThanOrEqual(toolbarBounds!.y + toolbarBounds!.height + 8);
  await page.screenshot({ path: '.tmp/tasks/session-actions-20261012/archive-notice.png' });
  await notice.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Unpin Second chat', exact: true })).toBeVisible();
  expect((await state()).workspaces).toEqual(preserved);
  const requests = (await readFile(audit, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { method?: string; params?: { threadId?: string } });
  expect(requests.filter((value) => value.method === 'thread/archive')).toEqual([
    expect.objectContaining({ params: { threadId: 'pin-target' } }),
  ]);
  expect(requests.filter((value) => value.method === 'thread/unarchive')).toEqual([
    expect.objectContaining({ params: { threadId: 'pin-target' } }),
  ]);
  expect(
    requests.some((value) => value.method === 'thread/start' || value.method === 'thread/resume'),
  ).toBe(false);
});
