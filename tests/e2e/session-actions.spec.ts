import { test, expect, electron, type ElectronApplication } from './test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from '../support/process';
import { promisify } from 'node:util';
import { notificationWindow } from './notification-window';
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
  await page.getByRole('button', { name: 'Second chat', exact: true }).hover();
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
  await page.getByRole('button', { name: 'Second chat', exact: true }).hover();
  await page.getByRole('button', { name: 'Archive Second chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Second chat', exact: true })).toHaveCount(0);
  const notifications = await notificationWindow(app);
  const notice = notifications.locator('.notification-alert').filter({ hasText: 'Archived chat' });
  await expect(notice).toContainText('Archived chat');
  await expect(notice.getByRole('button', { name: 'View', exact: true })).toHaveCount(0);
  await expect(notice).toHaveCSS('opacity', '1');
  const native = await app.evaluate(({ BrowserWindow }) => {
    const overlay = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/notifications.html'))!;
    return { parent: overlay.getParentWindow()?.id, alwaysOnTop: overlay.isAlwaysOnTop() };
  });
  expect(native.parent).toBeTruthy();
  expect(native.alwaysOnTop).toBe(false);
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

test('project session title fades and scrolls only during hover or focus', async ({diagnostics}) => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bp-session-title-')));
  const project = join(root, 'project'),
    primary = join(root, 'primary');
  await mkdir(primary);
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', primary, ...args]);
  await git('init', '--initial-branch=main');
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  diagnostics.expect({role:'test-child',kind:'stderr',phase:'test',message:/^Preparing worktree \(detached HEAD [0-9a-f]+\)$/,count:1});
  await git('worktree', 'add', '--detach', project);
  const title = 'A long session title that exposes the final words';
  app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...process.env,
      PROJECTOR_DATA: join(root, 'data'),
      CODEX_HOME: join(root, 'home'),
      PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'endpoint.json'),
      CODEX_FIXTURE_PROJECT: project,
      CODEX_FIXTURE_EMPTY: '0',
      PROJECTOR_E2E_HARNESS_INTERVAL_MS: '200',
      CODEX_FIXTURE_SESSION_METADATA: JSON.stringify({
        'thread-exact-fixture': { name: title },
        'pin-target': { name: 'Short' },
      }),
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  }, project);
  await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
  const select = page.getByRole('button', { name: title, exact: true });
  await expect(select).toBeVisible({ timeout: 10000 });
  await expect(select).not.toContainText('›_');
  const row = select.locator('..');
  const viewport = row.locator('.session-title');
  const text = viewport.locator('.session-title-text');
  await expect(viewport).not.toHaveCSS('text-overflow', 'ellipsis');
  await expect(text).toBeVisible();
  await expect(row.locator('.session-worktree')).toHaveAttribute('title', `Worktree · ${project}`);
  await expect(viewport).not.toHaveCSS('mask-image', 'none');
  await expect(
    page.getByRole('button', { name: 'Short', exact: true }).locator('.session-title'),
  ).toHaveCSS('mask-image', 'none');
  await page.screenshot({ path: '.tmp/tasks/session-row-20261013/normal.png' });
  await page.locator('.tree-heading').hover();
  await expect(row.locator('.session-actions button').last()).toHaveCSS('opacity', '0');
  await select.hover();
  await expect(row.locator('.session-actions button').last()).toHaveCSS('opacity', '1');
  await expect
    .poll(() => text.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41))
    .toBeLessThan(-1);
  await expect
    .poll(() => viewport.evaluate((el) => el.classList.contains('at-end')), { timeout: 15000 })
    .toBe(true);
  await expect(viewport).toHaveCSS('mask-image', 'none');
  const end = await text.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  await page.waitForTimeout(400);
  expect(await text.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41)).toBe(end);
  await page.screenshot({ path: '.tmp/tasks/session-row-20261013/hover.png' });
  await page
    .locator('.app')
    .evaluate((el) => (el as HTMLElement).style.setProperty('--left-sidebar-width', '400px'));
  await expect(viewport).not.toHaveClass(/at-end/);
  await expect(viewport).not.toHaveClass(/overflowing/);
  await expect(text).toHaveCSS('transform', 'none');
  await page.locator('.app').evaluate(el => (el as HTMLElement).style.setProperty('--left-sidebar-width', '210px'));
  await expect(viewport).toHaveClass(/overflowing/);
  await expect
    .poll(() => text.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41))
    .toBeLessThan(-1);
  await page.locator('.tree-heading').hover();
  await expect(text).toHaveCSS('transform', 'none');
  await select.focus();
  await expect
    .poll(() => text.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41))
    .toBeLessThan(-1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(text).toHaveCSS('transform', 'none');
  await select.click();
  await expect(row).toHaveClass(/active/);
  await page.screenshot({ path: '.tmp/tasks/session-row-20261013/selected.png' });
  await row.getByRole('button', { name: `Pin ${title}`, exact: true }).click();
  await page.locator('.tree-heading').hover();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await expect(row.getByRole('button', { name: `Unpin ${title}`, exact: true })).toHaveCSS(
    'opacity',
    '1',
  );
  await expect(row.getByRole('button', { name: `Archive ${title}`, exact: true })).toHaveCSS(
    'pointer-events',
    'none',
  );
  await page.screenshot({ path: '.tmp/tasks/session-row-20261013/pinned.png' });
});

test('busy Archive updates a deduplicated alert, retries without takeover and retains Undo after release', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bp-busy-archive-')));
  const project = join(root, 'project'); await mkdir(project);
  const audit = join(root, 'audit.jsonl'), writer = join(root, 'writer.txt');
  await writeFile(writer, 'thread-exact-fixture');
  app = await electron.launch({ args: [resolve('.')], env: {
    ...process.env, PROJECTOR_DATA: join(root, 'data'), CODEX_HOME: join(root, 'home'),
    PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'endpoint.json'), CODEX_FIXTURE_PROJECT: project,
    CODEX_FIXTURE_EMPTY: '0', CODEX_FIXTURE_ACTIVE_WRITER_FILE: writer,
    CODEX_FIXTURE_AUDIT: audit, PROJECTOR_E2E_HARNESS_INTERVAL_MS: '200',
  } });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  }, project);
  await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
  const row = page.locator('.project-session-row').filter({ has: page.getByRole('button', { name: 'Exact fixture session', exact: true }) });
  await row.hover();
  await row.getByRole('button', { name: 'Archive Exact fixture session', exact: true }).click();
  const notifications = await notificationWindow(app);
  const island = notifications.locator('.notification-alert').filter({ hasText: 'Session is in use' });
  await expect(island).toContainText('Session is in use');
  await expect(island).toContainText('Close its current Codex process');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  const state = () => page.evaluate(() => (window as unknown as { projector: { invoke(name: string): Promise<{ harnesses: { error: string | null }; terminals: unknown[]; selectedWorkspace: string | null }> } }).projector.invoke('applicationSnapshot'));
  expect((await state()).harnesses.error).toBeNull();
  const before = await state();
  await row.hover();
  await row.getByRole('button', { name: 'Archive Exact fixture session', exact: true }).click();
  await expect(island).toHaveCount(1);
  await island.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(island.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await expect(island).toContainText('Session is in use');
  expect((await state()).selectedWorkspace).toBe(before.selectedWorkspace);
  expect((await state()).terminals).toEqual([]);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await page.screenshot({ path: '.tmp/tasks/notification-island-20261013/warning.png' });
  await notifications.emulateMedia({ reducedMotion: 'reduce' });
  await expect(island).toHaveCSS('transition-duration', '0s');
  await island.getByRole('button', { name: 'Dismiss Session is in use', exact: true }).click();
  await expect(island).toHaveCount(0);
  await row.hover();
  await row.getByRole('button', { name: 'Archive Exact fixture session', exact: true }).click();
  await expect(island).toContainText('Session is in use');
  await notifications.emulateMedia({ reducedMotion: 'no-preference' });
  const warningHeight = (await island.boundingBox())!.height;
  await writeFile(writer, '');
  await island.getByRole('button', { name: 'Retry', exact: true }).click();
  const archived = notifications.locator('.notification-alert').filter({ hasText: 'Archived chat' });
  await expect(archived).toContainText('Archived chat');
  await expect(archived.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await archived.boundingBox())!.height).toBeLessThan(warningHeight);
  await page.screenshot({ path: '.tmp/tasks/notification-island-20261013/success.png' });
  await archived.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(archived).toHaveCount(0);
  await expect(row).toBeVisible();
  // Dismiss removes the single updated warning, with no duplicate hiding behind it.
  const calls = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method?: string });
  expect(calls.some(call => ['thread/start', 'thread/resume'].includes(call.method ?? ''))).toBe(false);
  expect(calls.filter(call => call.method === 'thread/archive')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'thread/unarchive')).toHaveLength(1);
  await expect(row).toBeVisible();
});

for (const phase of ['metadata', 'resume'] as const) {
  test(`Resume shows one warning for a writer conflict during ${phase}`, async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'bp-resume-conflict-')));
    const project = join(root, 'project');
    await mkdir(project);
    app = await electron.launch({ args: [resolve('.')], env: {
      ...process.env, PROJECTOR_DATA: join(root, 'data'), CODEX_HOME: join(root, 'home'),
      PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'endpoint.json'), CODEX_FIXTURE_PROJECT: project,
      CODEX_FIXTURE_EMPTY: '0',
      CODEX_FIXTURE_ACTIVE_WRITER: phase === 'metadata' ? 'thread-exact-fixture' : '',
      CODEX_FIXTURE_RESUME_WRITER: phase === 'resume' ? 'thread-exact-fixture' : '',
    } });
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, project) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    }, project);
    await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
    await page.getByRole('button', { name: 'Exact fixture session', exact: true }).click();
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    const notices = (await notificationWindow(app)).locator('.notification-alert');
    await expect(notices.filter({ hasText: 'Session is in use' })).toHaveCount(1);
    await expect(notices.filter({ hasText: 'Operation failed' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { projector: { invoke(name: string): Promise<{
        harnesses: { error: string | null }; terminals: unknown[];
      }> } }).projector.invoke('applicationSnapshot').then(({ harnesses, terminals }) => ({
        error: harnesses.error, terminals,
      })),
    )).toEqual({ error: null, terminals: [] });
  });
}
