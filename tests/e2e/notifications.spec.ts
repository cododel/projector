import { test, expect, electron, type ElectronApplication } from './test';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { notificationWindow } from './notification-window';

let app: ElectronApplication | undefined, root: string;
test.afterEach(async () => { await app?.close(); app = undefined; if (root) await rm(root, { recursive: true, force: true }); });
async function setup() {
  root = await mkdtemp(join(tmpdir(), 'projector-notices-'));
  const project = join(root, 'project'); await mkdir(project);
  app = await electron.launch({ args: [resolve('.')], env: { ...process.env,
    PROJECTOR_DATA: join(root, 'data'), CODEX_HOME: join(root, 'home'),
    PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'endpoint.json'), CODEX_FIXTURE_PROJECT: project,
    CODEX_FIXTURE_EMPTY: '0', CODEX_FIXTURE_SESSION_METADATA: JSON.stringify({
      'notice-a': { name: 'Chat A' }, 'notice-b': { name: 'Chat B' },
      'notice-c': { name: 'Chat C' }, 'notice-d': { name: 'Chat D with a long title '.repeat(8) },
    }),
  } });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
  await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
  const overlay = await notificationWindow(app);
  await overlay.getByRole('button', { name: 'Got it', exact: true }).click();
  await expect(overlay.locator('.notification-alert')).toHaveCount(0);
  return { page, overlay };
}

test('independent Archive/Undo stack has newest-first overflow, wrapping and native lifecycle', async () => {
  const { page, overlay } = await setup();
  const names = ['Chat A', 'Chat B', 'Chat C', 'Chat D with a long title '.repeat(8).trim()];
  for (const name of names) {
    const row = page.getByRole('button', { name, exact: true }).locator('..');
    await row.hover(); await row.getByRole('button', { name: `Archive ${name}`, exact: true }).click();
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  const alerts = overlay.locator('.notification-alert:not(.leaving)');
  await expect(alerts).toHaveCount(3);
  await expect(alerts.first()).toContainText(names[3]);
  await expect(alerts.nth(1)).toContainText('Chat C');
  await overlay.emulateMedia({ colorScheme: null });
  await app!.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await expect(alerts.first()).toHaveCSS('background-color', 'rgb(23, 25, 29)');
  await expect(alerts.first()).toHaveCSS('border-top-color', 'rgb(150, 178, 215)');
  await app!.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  await expect(alerts.first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(alerts.first()).toHaveCSS('border-top-color', 'rgb(60, 89, 196)');
  await expect(alerts.first().locator('.alert-copy p')).toHaveCSS('white-space', 'pre-wrap');
  await expect(overlay.getByRole('button', { name: 'More · 1', exact: true })).toBeVisible();
  await overlay.getByRole('button', { name: 'More · 1', exact: true }).click();
  await expect(alerts).toHaveCount(4);
  await overlay.emulateMedia({ reducedMotion: 'reduce' });
  await expect(alerts.first()).toHaveCSS('transition-duration', '0s');
  await overlay.getByRole('button', { name: 'Show latest', exact: true }).click();
  await expect(alerts).toHaveCount(3);
  await page.waitForTimeout(5300); // Undo is sticky in visible and hidden windows.
  await expect(alerts).toHaveCount(3);
  const native = await app!.evaluate(({ BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/notifications.html'))!;
    const parent = child.getParentWindow()!;
    return { child: child.getBounds(), parent: parent.getContentBounds(), top: child.isAlwaysOnTop(), visible: child.isVisible(), parentVisible: parent.isVisible() };
  });
  const titlebarHeight = await page.locator('.window-titlebar').evaluate(el => el.getBoundingClientRect().height);
  const alertTop = await alerts.first().evaluate(el => el.getBoundingClientRect().top);
  expect(native.child.y + alertTop - native.parent.y - titlebarHeight).toBe(12);
  expect(native.top).toBe(false); expect(native.child.height).toBeLessThanOrEqual(native.parent.height * 0.6);
  expect(Math.abs(native.child.x + native.child.width / 2 - native.parent.x - native.parent.width / 2)).toBeLessThanOrEqual(1);
  if (!native.parentVisible) expect(native.visible).toBe(false);
  const newest = alerts.first(); await newest.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: names[3], exact: true })).toBeVisible();
  await expect(alerts).toHaveCount(3);
  expect(await overlay.evaluate(() => typeof (window as unknown as { projector?: unknown }).projector)).toBe('undefined');
});

test('per-operation waiting updates independently; visible-time info pauses for hover, focus and hidden parent', async () => {
  const { page, overlay } = await setup();
  const emit = (waiting: boolean, operationId: string, error?: string) => app!.evaluate(({ BrowserWindow }, value) => {
    const parent = BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!;
    parent.webContents.send('projector:operation-status', value);
  }, { waiting, operationId, operation: 'isolated storage operation', error });
  const focusedBefore = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null);
  await emit(true, 'op-one'); await emit(true, 'op-two');
  await expect(overlay.locator('.notification-alert:not(.leaving)')).toHaveCount(2);
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)).toBe(focusedBefore);
  await emit(false, 'op-one');
  const info = overlay.locator('[data-operation="op-one"]');
  const waiting = overlay.locator('[data-operation="op-two"]');
  await expect(info).toContainText('Operation completed');
  await expect(waiting).toContainText('Waiting for local storage');
  await overlay.emulateMedia({ colorScheme: 'light' });
  await expect(waiting).toHaveCSS('border-top-color', 'rgb(123, 96, 38)');
  await overlay.emulateMedia({ colorScheme: 'dark' });
  await expect(waiting).toHaveCSS('border-top-color', 'rgb(216, 190, 135)');
  await emit(false, 'op-two', 'Unknown write outcome');
  await expect(waiting).toHaveCSS('border-top-color', 'rgb(240, 165, 173)');
  const originalTop = await waiting.evaluate(el => (el as HTMLElement).offsetTop);
  await waiting.getByRole('button', { name: 'Dismiss Storage operation needs attention', exact: true }).click();
  const exitPosition = await overlay.waitForFunction(() => {
    const leaving = document.querySelector<HTMLElement>('[data-operation="op-two"].leaving');
    return leaving ? { top: leaving.offsetTop } : null;
  });
  expect(await exitPosition.jsonValue()).toEqual({ top: originalTop });
  await expect(waiting).toHaveCount(0);
  await emit(true, 'op-two'); await emit(false, 'op-two', 'Unknown write outcome');
  await expect(waiting).toContainText('Unknown write outcome');
  await info.hover(); await page.waitForTimeout(5300); await expect(info).toHaveCount(1);
  await overlay.locator('body').hover({ position: { x: 1, y: 1 } });
  await info.getByRole('button', { name: 'Dismiss Operation completed', exact: true }).focus();
  await page.waitForTimeout(5300); await expect(info).toHaveCount(1);
  await overlay.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  const visible = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!.isVisible());
  if (visible) await expect(info).toHaveCount(0, { timeout: 7000 });
  else { await page.waitForTimeout(5300); await expect(info).toHaveCount(1); }
  await expect(waiting).toContainText('Unknown write outcome');
  await waiting.getByRole('button', { name: 'Dismiss Storage operation needs attention', exact: true }).click();
  await expect(waiting).toHaveCount(0);
});

test('notification keyboard entry remains reachable inside dirty settings; parent resize and hide own the overlay', async () => {
  const { page, overlay } = await setup();
  await app!.evaluate(({ BrowserWindow }) => {
    const parent = BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!;
    parent.webContents.send('projector:operation-status', { waiting: true, operationId: 'settings-warning', operation: 'settings' });
  });
  await expect(overlay.locator('.notification-alert')).toContainText('Waiting for local storage');
  await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true });
    window.dispatchEvent(event);
  });
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Plan placement').selectOption('tab');
  const access = dialog.getByRole('button', { name: 'Notifications · 1', exact: true });
  await access.focus(); await expect(access).toBeFocused();
  const visible = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!.isVisible());
  await access.press('Enter');
  if (visible) {
    await expect(overlay.getByRole('button', { name: 'Dismiss Waiting for local storage', exact: true })).toBeFocused();
    await overlay.keyboard.press('Escape');
    await expect(access).toBeFocused();
  }
  await app!.evaluate(({ BrowserWindow }) => {
    const parent = BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!;
    const b = parent.getBounds(); parent.setBounds({ ...b, width: b.width + 40 });
  });
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/notifications.html'))!;
    const parent = child.getParentWindow()!.getContentBounds(), b = child.getBounds();
    return Math.abs(b.x + b.width / 2 - parent.x - parent.width / 2);
  })).toBeLessThanOrEqual(1);
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!.hide());
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/notifications.html'))!.isVisible())).toBe(false);
  await app!.evaluate(({ BrowserWindow }) => {
    const parent = BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!;
    parent.once('close', event => event.preventDefault());
    parent.close();
  });
  await expect.poll(() => overlay.isClosed()).toBe(true);
  const restored = await notificationWindow(app!);
  await expect(restored.locator('[data-operation="settings-warning"]')).toContainText('Waiting for local storage');
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.getParentWindow()).length)).toBe(1);
});

test('dismissing an uncertain-write alert retains recovery in Settings without replaying the change', async ({ diagnostics }) => {
  const { page, overlay } = await setup();
  const data = join(root, 'data');
  await app!.evaluate(async (_, directory) => {
    const fs = process.getBuiltinModule('fs/promises') as typeof import('node:fs/promises');
    const { syncBuiltinESMExports } = process.getBuiltinModule('module') as typeof import('node:module');
    const original = fs.open;
    const fault = { enabled: true };
    Object.assign(globalThis, { notificationDirectoryFault: fault, restoreNotificationFs: () => {
      fs.open = original; syncBuiltinESMExports();
    } });
    fs.open = async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (String(args[0]) === directory) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (fault.enabled) throw Object.assign(new Error('isolated directory sync failure'), { code: 'EIO' });
          await sync();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
  }, data);
  try {
  const openSettings = async () => {
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true })));
    return page.getByRole('dialog', { name: 'Settings', exact: true });
  };
  const dialog = await openSettings();
  await dialog.getByLabel('Plan placement').selectOption('tab');
  diagnostics.phase('uncertain-write');
  diagnostics.expect({ role: 'main', kind: 'console-error', phase: 'uncertain-write', message: /^Error occurred in handler for 'projector:invoke': ProjectorError: Workspace metadata may already be saved\. Retry confirmation before making another change\.\n[\s\S]*$/, count: 1 });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(overlay.getByRole('button', { name: 'Confirm local write', exact: true })).toBeVisible();
  const bytes = await readFile(join(data, 'application-workspace.json'), 'utf8');
  await expect(overlay.locator('.notification-alert.error:not(.leaving)')).toContainText('Workspace metadata may already be saved.');
  const dismissedIds = await overlay.locator('.notification-alert:not(.leaving)').evaluateAll(elements => elements.map(el => (el as HTMLElement).dataset.notificationId!));
  for (const id of dismissedIds) {
    const notice = overlay.locator(`[data-notification-id="${id}"]:not(.leaving)`);
    await notice.locator('.alert-dismiss').click();
    await expect(notice).toHaveCount(0);
  }
  await expect(overlay.locator('.notification-alert:not(.leaving)')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const reopened = await openSettings();
  await expect(reopened.getByRole('button', { name: 'Review pending write', exact: true })).toBeVisible();
  await reopened.getByRole('button', { name: 'Review pending write', exact: true }).click();
  const confirmation = overlay.locator('.notification-alert:not(.leaving)').filter({ hasText: 'Local workspace storage needs confirmation' });
  const noticeId = await confirmation.getAttribute('data-notification-id');
  diagnostics.phase('confirmation-failure');
  diagnostics.expect({ role: 'main', kind: 'console-error', phase: 'confirmation-failure', message: /^Error occurred in handler for 'projector:invoke': ProjectorError: Workspace metadata may already be saved\. Retry confirmation before making another change\.\n[\s\S]*$/, count: 1 });
  await confirmation.getByRole('button', { name: 'Confirm local write', exact: true }).click();
  await expect(confirmation).toHaveAttribute('data-notification-id', noticeId!);
  await overlay.emulateMedia({ colorScheme: 'light' });
  await expect(confirmation).toHaveCSS('border-top-color', 'rgb(173, 70, 56)');
  await expect(confirmation.getByRole('button', { name: 'Confirm local write', exact: true })).toBeEnabled();
  expect(await readFile(join(data, 'application-workspace.json'), 'utf8')).toBe(bytes);
  diagnostics.phase('test');
  await app!.evaluate(() => {
    const own = globalThis as unknown as { notificationDirectoryFault: { enabled: boolean }; restoreNotificationFs(): void };
    own.notificationDirectoryFault.enabled = false; own.restoreNotificationFs();
  });
  await confirmation.getByRole('button', { name: 'Confirm local write', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(reopened.getByRole('button', { name: 'Review pending write', exact: true })).toHaveCount(0);
  expect(await readFile(join(data, 'application-workspace.json'), 'utf8')).toBe(bytes);
  } finally {
    await app!.evaluate(() => {
      const own = globalThis as unknown as { notificationDirectoryFault: { enabled: boolean }; restoreNotificationFs(): void };
      own.notificationDirectoryFault.enabled = false; own.restoreNotificationFs();
    });
  }
});

test('interrupted native stack reflow continues from the current visual position', async () => {
  const { overlay } = await setup();
  const emit = (id: string) => app!.evaluate(({ BrowserWindow }, operationId) => {
    BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!.webContents.send('projector:operation-status', { waiting: true, operationId, operation: 'reflow' });
  }, id);
  await emit('reflow-first');
  const first = overlay.locator('[data-operation="reflow-first"]');
  await expect(first).toBeVisible();
  await first.evaluate(el => { for (const animation of el.getAnimations()) if (animation.effect?.getTiming().duration === 180) animation.finish(); });
  await emit('reflow-second');
  await expect(overlay.locator('[data-operation="reflow-second"]')).toBeVisible();
  // Compare painted positions: child measurements and ResizeObserver origins
  // must be delivered before freezing the reflow, not a transient pre-paint DOM.
  await overlay.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const before = await first.evaluate(el => {
    const motion = el.getAnimations().filter(a => a.effect?.getTiming().duration === 220).at(-1);
    if (!motion) throw new Error('Expected production reflow animation');
    motion.pause(); motion.currentTime = 110;
    return { top: el.getBoundingClientRect().top, offset: (el as HTMLElement).offsetTop, translate: getComputedStyle(el).translate, transform: getComputedStyle(el).transform, frames: motion.effect instanceof KeyframeEffect ? motion.effect.getKeyframes() : [], kind: motion.constructor.name };
  });
  await emit('reflow-third');
  await expect(overlay.locator('[data-operation="reflow-third"]')).toBeVisible();
  const after = await first.evaluate(el => {
    const motion = el.getAnimations().filter(a => a.effect?.getTiming().duration === 220).at(-1);
    if (!motion) throw new Error('Expected interrupted production reflow animation');
    motion.pause(); motion.currentTime = 0;
    return { top: el.getBoundingClientRect().top, offset: (el as HTMLElement).offsetTop, translate: getComputedStyle(el).translate, transform: getComputedStyle(el).transform, frames: motion.effect instanceof KeyframeEffect ? motion.effect.getKeyframes() : [], kind: motion.constructor.name };
  });
  await test.info().attach('interrupted-reflow', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
  expect(Math.abs(after.top - before.top)).toBeLessThan(1);
});

test('collapsed and offscreen info retains visible lifetime until fully revealed', async () => {
  const { page, overlay } = await setup();
  const emit = (operationId: string, waiting: boolean, error?: string) => app!.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!.webContents.send('projector:operation-status', value);
  }, { operationId, waiting, operation: 'visibility', error });
  await emit('older-info', true); await emit('older-info', false);
  for (let i = 0; i < 4; i++) {
    await emit(`tall-${i}`, true); await emit(`tall-${i}`, false, 'Long operation detail belongs to its original context. '.repeat(12));
  }
  const info = overlay.locator('[data-operation="older-info"]');
  await expect(info).toHaveCount(0); // Collapsed presentation must retain controller state and lifetime.
  await page.waitForTimeout(5300);
  await overlay.getByRole('button', { name: 'More · 2', exact: true }).click();
  await expect(info).toHaveCount(1);
  await overlay.locator('.notification-stack').evaluate(el => { el.scrollTop = 0; });
  const offscreen = await info.evaluate(el => {
    const bounds = el.getBoundingClientRect(), viewport = el.closest('.notification-stack')!.getBoundingClientRect();
    return bounds.top >= viewport.bottom;
  });
  expect(offscreen).toBe(true);
  await page.waitForTimeout(5300); await expect(info).toHaveCount(1);
  await overlay.locator('body').hover({ position: { x: 1, y: 1 } });
  await info.evaluate(el => el.scrollIntoView({ block: 'end' }));
  const visible = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!.isVisible());
  if (visible) await expect(info).toHaveCount(0, { timeout: 7000 });
  else { await page.waitForTimeout(5300); await expect(info).toHaveCount(1); }
});


test('explicit notification focus reaches controls after a cold child is created', async () => {
  const { page, overlay } = await setup();
  await app!.evaluate(({ BrowserWindow }) => {
    const parent = BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!;
    parent.once('close', event => event.preventDefault()); parent.close();
  });
  await expect.poll(() => overlay.isClosed()).toBe(true);
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await app!.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!.webContents.send('projector:operation-status', {
      waiting: true, operationId: 'cold-focus', operation: 'cold child',
    });
  });
  await page.getByRole('toolbar', { name: 'Window toolbar' })
    .getByRole('button', { name: 'Notifications · 1', exact: true }).click();
  const cold = await notificationWindow(app!);
  await expect(cold.locator('[data-operation="cold-focus"]')).toBeVisible();
  const visible = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!.isVisible());
  if (visible) await expect(cold.getByRole('button', { name: 'Dismiss Waiting for local storage', exact: true })).toBeFocused();
  else expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getParentWindow())!.isVisible())).toBe(false);
});

test('native hit testing recovers without mousemove and leaves gaps and rounded corners transparent', async () => {
  const { overlay } = await setup();
  const visible = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!.isVisible());
  // Only cursor coordinates are doubled. The real dedicated preload, DOM hit test,
  // sender validation and native ignore-mouse switch remain on the production path.
  await app!.evaluate(({ BrowserWindow, screen }) => {
    const child = BrowserWindow.getAllWindows().find(w => w.getParentWindow())!;
    const probe = { point: { x: -10000, y: -10000 }, ignored: true, samples: 0 };
    Object.assign(globalThis, { notificationPointerProbe: probe });
    screen.getCursorScreenPoint = () => { probe.samples++; return probe.point; };
    const original = child.setIgnoreMouseEvents.bind(child);
    child.setIgnoreMouseEvents = (ignore, options) => { probe.ignored = ignore; original(ignore, options); };
    child.setIgnoreMouseEvents(true, { forward: true });
    const parent = child.getParentWindow()!;
    for (let i = 0; i < 3; i++) parent.webContents.send('projector:operation-status', { waiting: true, operationId: `pointer-${i}`, operation: 'native hit-test fixture' });
  });
  const alerts = overlay.locator('.notification-alert:not(.leaving)');
  await expect(alerts).toHaveCount(3);
  // Use settled geometry, including actual CSS border radius, rather than a
  // test implementation of which portions of the native window are clickable.
  await expect(alerts.first()).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await overlay.waitForFunction(() => [...document.querySelectorAll('.notification-alert')].every(el => !el.getAnimations().some(a => a.playState === 'running')));
  expect(await alerts.evaluateAll(els => els.every(el => (el as HTMLElement).offsetHeight >= (el.querySelector('.notification-alert-content') as HTMLElement).offsetHeight + 2))).toBe(true);
  const rects = await alerts.evaluateAll(els => els.map(el => el.getBoundingClientRect().toJSON()));
  const dismiss = await alerts.first().locator('.alert-dismiss').boundingBox();
  expect(dismiss).not.toBeNull();
  const point = async (x: number, y: number) => app!.evaluate(({ BrowserWindow }, value) => {
    const child = BrowserWindow.getAllWindows().find(w => w.getParentWindow())!, bounds = child.getBounds();
    const probe = (globalThis as unknown as { notificationPointerProbe: { point: { x: number; y: number } } }).notificationPointerProbe;
    probe.point = { x: bounds.x + value.x, y: bounds.y + value.y };
  }, { x, y });
  const ignored = () => app!.evaluate(() => (globalThis as unknown as { notificationPointerProbe: { ignored: boolean } }).notificationPointerProbe.ignored);
  await point(dismiss!.x + dismiss!.width / 2, dismiss!.y + dismiss!.height / 2);
  if (!visible) {
    await overlay.waitForTimeout(100);
    expect(await ignored()).toBe(true);
    expect(await app!.evaluate(() => (globalThis as unknown as { notificationPointerProbe: { samples: number } }).notificationPointerProbe.samples)).toBe(0);
    return;
  }
  await expect.poll(ignored).toBe(false);
  await point(rects[0].x + 1, rects[0].y + 1);
  await expect.poll(ignored).toBe(true);
  await point(rects[0].x + rects[0].width / 2, rects[0].bottom + 4);
  await expect.poll(ignored).toBe(true);
  await point(dismiss!.x + dismiss!.width / 2, dismiss!.y + dismiss!.height / 2);
  await expect.poll(ignored).toBe(false);
  // No synthetic mousemove primes the overlay before this click.
  await app!.evaluate(({ BrowserWindow }, point) => {
    const contents = BrowserWindow.getAllWindows().find(w => w.getParentWindow())!.webContents;
    contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }, { x: Math.round(dismiss!.x + dismiss!.width / 2), y: Math.round(dismiss!.y + dismiss!.height / 2) });
  await expect(alerts).toHaveCount(2);
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!.hide());
  const samples = await app!.evaluate(() => (globalThis as unknown as { notificationPointerProbe: { samples: number } }).notificationPointerProbe.samples);
  await overlay.waitForTimeout(100);
  expect(await app!.evaluate(() => (globalThis as unknown as { notificationPointerProbe: { samples: number } }).notificationPointerProbe.samples)).toBe(samples);
});
