import { test, expect } from '@playwright/test';
import { z } from 'zod';

test('coverage links resolve to registered Storybook stories', async ({ page, request }) => {
  await page.goto('/iframe.html?id=catalog-coverage--overview&viewMode=story');
  await expect(page.getByRole('table', { name: 'Component and interface coverage inventory' })).toBeVisible();
  const index = z.object({ entries: z.record(z.string(), z.unknown()) }).parse(await (await request.get('/index.json')).json());
  const links = await page.locator('.catalog-state-links a').evaluateAll(elements => elements.map(element => element.getAttribute('href')));
  expect(links.length).toBeGreaterThan(0);
  for (const href of links) {
    const id = new URL(href!, 'http://127.0.0.1:6006').searchParams.get('path')!.replace('/story/', '');
    expect(index.entries).toHaveProperty(id);
  }
});

for (const [name, id, count] of [
  ['notifications', 'notifications-stack--state-sheet', 9],
  ['sessions', 'sessions-project-row--state-sheet', 9],
] as const) {
  test(`${name} production state sheet`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`/iframe.html?id=${id}&viewMode=story`);
    await expect(page.locator('.catalog-grid > section')).toHaveCount(count);
    // Wait for the real stack's ResizeObserver measurement; never capture its
    // initial clipped layout as the baseline. Fixed frames have paused timers.
    if (name === 'notifications') await expect(page.locator('.notification-alert').first()).toHaveCSS('height', /\d+px/);
    await page.mouse.move(0, 0);
    await expect(page.locator('.catalog-grid')).toHaveScreenshot(`${name}.png`, { animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}
