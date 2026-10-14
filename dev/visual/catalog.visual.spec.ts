import { test, expect } from '@playwright/test';
import { z } from 'zod';
import { resolve } from 'node:path';
import { readStoryBindings } from '../catalog-source';
import { catalog } from '../catalog';
import { resolveCatalog, validateCatalog, visualBaselineName } from '../catalog-coverage';
const bindings = await readStoryBindings(resolve('.'));

test('coverage links resolve to registered stories and filters retain honest denominators', async ({ page, request }) => {
  await page.goto('/iframe.html?id=catalog-coverage--overview&viewMode=story');
  await expect(page.getByRole('region', { name: 'Component and interface coverage inventory' })).toBeVisible();
  const index = z.object({ entries: z.record(z.string(), z.unknown()) }).parse(await (await request.get('/index.json')).json());
  expect(validateCatalog(resolveCatalog(bindings),bindings,new Set(Object.keys(index.entries)))).toEqual([]);
  const runtime = await page.evaluate(async () => { return JSON.parse(document.querySelector('[data-catalog-bindings]')!.getAttribute('data-catalog-bindings')!); });
  const compared = (items: typeof bindings) => items.filter(item => item.id !== 'catalog-coverage--overview').map(({id,states,transitions,interaction}) => ({id,states,transitions,interaction})).sort((a,b) => a.id.localeCompare(b.id));
  expect(compared(runtime)).toEqual(compared(bindings));
  const links = await page.locator('.catalog-state-links a').evaluateAll(elements => elements.map(element => element.getAttribute('href')));
  expect(links.length).toBeGreaterThan(0);
  for (const href of links) {
    const id = new URL(href!, 'http://127.0.0.1:6006').searchParams.get('path')!.replace('/story/', '');
    expect(index.entries).toHaveProperty(id);
  }
  const totals = await page.locator('.catalog-stats > span').allTextContents();
  await page.getByLabel('Category').selectOption('native');
  await expect(page.locator('.catalog-entry')).toHaveCount(catalog.filter(entry => entry.kind === 'native').length);
  await expect(page.locator('.catalog-stats > span')).toHaveText(totals);
  await page.getByLabel('Category').selectOption('all');
  await page.getByLabel('Search', { exact: true }).fill('Mermaid');
  await expect(page.locator('.catalog-entry')).toHaveCount(1);
});

for (const binding of bindings.filter(binding => binding.sheet)) {
  const name = visualBaselineName(binding.id);
  test(`${binding.id} production state sheet`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`/iframe.html?id=${binding.id}&viewMode=story`);
    await expect(page.locator('#storybook-root')).not.toBeEmpty();
    // Enumerate expected frame elements before navigation completes; about:blank
    // is not grounds to omit a state panel from readiness assertions.
    const sheet = page.locator('[data-catalog-sheet-total]');
    if (await sheet.count()) await expect(sheet).toHaveAttribute('data-catalog-sheet-ready','true',{timeout:30000});
    const panels = page.locator('iframe[src*="iframe.html"]');
    const panelCount = await panels.count();
    for (let index = 0; index < panelCount; index++) {
      const frame = panels.nth(index).contentFrame();
      await expect(frame.locator('[data-catalog-rendered]')).toHaveCount(1);
      await expect(frame.locator('.sb-errordisplay')).not.toBeVisible();
    }
    await page.mouse.move(0,0);
    const grid = page.locator('.catalog-grid').first();
    const target = await grid.count() ? grid : page.locator('#storybook-root');
    const captureBounds = await target.boundingBox();
    expect(captureBounds).not.toBeNull();
    for (let index = 0; index < panelCount; index++) {
      const bounds = await panels.nth(index).boundingBox();
      expect(bounds, `Frame ${index} must occupy its own visible panel`).not.toBeNull();
      expect(bounds!.y + bounds!.height, `Frame ${index} must not overflow the captured sheet`).toBeLessThanOrEqual(captureBounds!.y + captureBounds!.height + 1);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(captureBounds!.x + captureBounds!.width + 1);
    }
    await expect(target).toHaveScreenshot(`${name}.png`, { animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}

test('guide keeps its controls fixed while only long content scrolls', async ({ page }) => {
  for (const height of [600, 400]) {
    await page.setViewportSize({ width: 1200, height });
    await page.goto('/iframe.html?id=help-guide--long-content&viewMode=story');
    const dialog = page.getByRole('dialog', { name: 'Projector guide' });
    const content = dialog.locator('.guide-content');
    await expect(content).toContainText('Offline documentation');
    const before = await dialog.getByRole('button', { name: 'Close', exact: true }).boundingBox();
    expect(await dialog.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    expect(await content.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
    await content.focus();
    await page.keyboard.press('PageDown');
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const afterKeyboard = await content.evaluate(element => element.scrollTop);
    await content.hover();
    await page.mouse.wheel(0, 200);
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(afterKeyboard);
    expect(await dialog.evaluate(element => element.scrollTop)).toBe(0);
    expect(await dialog.getByRole('button', { name: 'Close', exact: true }).boundingBox()).toEqual(before);
  }
});

test('document annotation highlights follow the measured passage after resize and scroll', async ({ page }) => {
  await page.goto('/iframe.html?id=document-annotations--text-highlight&viewMode=story');
  for (const width of [1400, 760, 420]) {
    await page.setViewportSize({ width, height: 600 });
    await expect.poll(async () => page.evaluate(() => {
      const text = document.querySelector('.plan-document p [data-text-path]');
      const highlights = Array.from(document.querySelectorAll('.text-highlight'));
      if (!text || !highlights.length) return Infinity;
      const range = document.createRange(); range.selectNodeContents(text);
      const rects = Array.from(range.getClientRects());
      if (rects.length !== highlights.length) return Infinity;
      return Math.max(...rects.map((expected,index) => {
        const actual = highlights[index].getBoundingClientRect();
        return Math.max(Math.abs(expected.x-actual.x),Math.abs(expected.y-actual.y),Math.abs(expected.width-actual.width),Math.abs(expected.height-actual.height));
      }));
    })).toBeLessThan(1);
    if (width === 420) expect(await page.evaluate(() => {
      const range=document.createRange();range.selectNodeContents(document.querySelector('.plan-document p [data-text-path]')!);
      return range.getClientRects().length;
    })).toBeGreaterThan(1);
    await page.evaluate(() => { document.body.style.minHeight = '1800px'; window.scrollTo(0, 45); });
    await expect.poll(async () => page.evaluate(() => {
      const range = document.createRange();range.selectNodeContents(document.querySelector('.plan-document p [data-text-path]')!);
      const rect = range.getClientRects()[0];const highlight = document.querySelector('.text-highlight')!.getBoundingClientRect();
      const marker=document.querySelector<SVGElement>('.inline-annotation-number')!;
      const last=Array.from(range.getClientRects()).at(-1)!;
      const path = marker.querySelector<SVGPathElement>('path')!;
      const tip = path.getPointAtLength(0).matrixTransform(path.getScreenCTM()!);
      return Math.max(Math.abs(rect.y-highlight.y),Math.abs(Number(marker.dataset.pointerX)-(last.right+window.scrollX)),Math.abs(Number(marker.dataset.pointerY)-(last.top+last.height/4+window.scrollY)),Math.abs(tip.x-last.right),Math.abs(tip.y-(last.top+last.height/4)));
    })).toBeLessThan(1);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
});

test('annotation area, candidate and editor use the current document layout', async ({ page }) => {
  for (const width of [1400, 420]) {
    await page.setViewportSize({ width, height: 600 });
    for (const story of ['hovered-block', 'drag-selection', 'area-marker', 'candidate', 'empty-editor', 'overlapping', 'clipped-marker']) {
      await page.goto(`/iframe.html?id=document-annotations--${story}&viewMode=story`);
      await expect(page.locator('.plan-document p')).toBeVisible();
      await expect.poll(() => page.evaluate(story => {
        const passage = document.querySelector('.plan-document p')!;
        const block = passage.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(passage.querySelector('[data-text-path]')!);
        const rects = Array.from(range.getClientRects()), last = rects.at(-1)!;
        if (story === 'hovered-block' || story === 'drag-selection' || story === 'area-marker') {
          const overlay = document.querySelector(story === 'hovered-block' ? '.element-hover-outline' : story === 'drag-selection' ? '.area-rectangle' : '.text-highlight');
          if (!overlay) return false;
          const actual = overlay.getBoundingClientRect();
          return (['x','y','width','height'] as const).every(key => Math.abs(actual[key] - block[key]) < 1);
        }
        if (story === 'candidate') {
          const button = document.querySelector('.selection-annotate')?.getBoundingClientRect();
          return Boolean(button && Math.abs(button.x - rects[0].x) < 1 && Math.abs(button.y - last.bottom - 8) < 1);
        }
        if (story === 'empty-editor') {
          const editor = document.querySelector('.annotation-popover')?.getBoundingClientRect();
          return Boolean(editor && editor.left >= 0 && editor.right <= innerWidth && editor.top >= 0 && editor.bottom <= innerHeight && Math.abs(editor.x+editor.width/2-last.right) <= editor.width/2 && Math.min(Math.abs(editor.top-last.top),Math.abs(editor.bottom-last.top)) < 40);
        }
        if (story === 'clipped-marker') return document.querySelectorAll('.inline-annotation-number').length === 0;
        const paths = Array.from(document.querySelectorAll<SVGPathElement>('.inline-annotation-number path'));
        return paths.length === 2 && paths.every((path, index) => {
          const tip = path.getPointAtLength(0).matrixTransform(path.getScreenCTM()!);
          return Math.abs(tip.x - last.right - index*24) < 1 && Math.abs(tip.y - last.top - last.height/4) < 1;
        });
      }, story)).toBe(true);
    }
  }
});
