import { expect, type ElectronApplication, type Page } from './test';

export async function notificationWindow(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => app.windows().some(page => page.url().includes('/notifications.html'))).toBe(true);
  return app.windows().find(page => page.url().includes('/notifications.html'))!;
}
