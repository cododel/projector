import { newBrowserTab } from './workspace-ui';
import { test, expect, electron } from './test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mcp } from './mcp';

test('document area capture stays private until Save and opens its numbered frozen viewport after resizing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-doc-area-'));
  const data = join(root, 'data');
  const project = join(root, 'project');
  const socket = join(root, 's.sock');
  await mkdir(data);
  await mkdir(project);
  const app = await electron.launch({
    args: [resolve('.')],
    env: { ...process.env, PROJECTOR_DATA: data, PROJECTOR_RUNTIME_DESCRIPTOR: socket },
  });
  let mcp: Mcp | undefined;
  try {
    const page = await app.firstWindow();
    const titlebar = page.getByRole('toolbar', { name: 'Window toolbar' });
    await expect(titlebar).toBeVisible();
    const leftTop = titlebar.locator('.titlebar-left');
    const rightTop = titlebar.locator('.titlebar-right');
    const centerTop = titlebar.locator('.titlebar-center');
    await expect(leftTop).toBeVisible();
    const leftBounds = (await leftTop.boundingBox())!;
    const sidebarBounds = (await page.locator('.sidebar').boundingBox())!;
    expect(leftBounds.x + leftBounds.width).toBeCloseTo(sidebarBounds.x + sidebarBounds.width, 0);
    expect((await centerTop.boundingBox())!.x).toBeCloseTo(leftBounds.x + leftBounds.width, 0);
    await expect(rightTop).toHaveCount(0);
    await expect(page.locator('.feedback-panel')).toBeHidden();

    await expect(titlebar.getByRole('button', { name: 'Hide projects sidebar' })).toBeVisible();
    await expect(titlebar.getByRole('button', { name: 'Show feedback sidebar' })).toBeDisabled();
    expect(
      await titlebar.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region')),
    ).toBe('drag');
    expect(
      await titlebar
        .locator('button')
        .first()
        .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region')),
    ).toBe('no-drag');
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!.getWindowButtonPosition(),
      ),
    ).toEqual({ x: 14, y: 13 });
    await page.screenshot({ path: resolve('.tmp/tasks/titlebar-20261010/welcome.png') });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    await page.getByRole('button', { name: '+ Open project folder' }).click();
    mcp = new Mcp(socket);
    await mcp.initialize();
    const context = await mcp.tool('get_projector_context', {});
    const a = await mcp.tool('create_artifact', {
      projectId: (context.project as { id: string }).id,
      kind: 'projector',
      title: 'Captured plan',
      originSession: { harness: 'codex', sessionId: 'area-session' },
      operationId: randomUUID(),
    });
    await writeFile(
      join(String(a.sourcePath), 'plan.mdx'),
      '# Captured plan\n\nInspect this visual section.\n\n| Owner | Member |\n|---|---|\n| Allowed | Pending |',
    );
    const r = await mcp.tool('publish_artifact', {
      artifactId: a.artifactId,
      expectedLatestRevision: null,
      operationId: randomUUID(),
    });
    await mcp.tool('show_artifact', { artifactId: a.artifactId, revisionId: r.revisionId });
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('heading', { name: 'Captured plan' })).toBeVisible();
    const fixedHeader = await page.locator('.plan-header').boundingBox();
    await expect(titlebar.getByRole('tab', { name: 'Plan', exact: true })).toBeVisible();
    await expect(page.locator('.workspace [role=tablist]')).toHaveCount(0);
    await expect(page.locator('.window-title, .plan-header h1')).toHaveCount(0);
    const strip = await titlebar.boundingBox();
    expect(fixedHeader!.y).toBeCloseTo(strip!.y + strip!.height, 0);
    await frame.locator('body').evaluate(() => window.scrollTo(0, 100));
    expect((await page.locator('.plan-header').boundingBox())!.y).toBe(fixedHeader!.y);
    await frame.locator('body').evaluate(() => window.scrollTo(0, 0));
    const rightResize = page.getByRole('separator', { name: 'Resize feedback sidebar' });
    await expect(rightResize).toBeVisible();
    await rightResize.press('End');
    await expect(rightResize).toHaveAttribute('aria-valuenow', '500');
    expect((await rightTop.boundingBox())!.x).toBeCloseTo(
      (await page.locator('.feedback-panel').boundingBox())!.x,
      0,
    );
    expect((await rightTop.boundingBox())!.width).toBe(500);

    await rightResize.press('Home');
    await expect(rightResize).toHaveAttribute('aria-valuenow', '250');
    await rightResize.press('ArrowLeft');
    await expect(rightResize).toHaveAttribute('aria-valuenow', '260');
    await rightResize.dblclick();
    await expect(rightResize).toHaveAttribute('aria-valuenow', '310');
    const leftResize = page.getByRole('separator', { name: 'Resize projects sidebar' });
    await expect(leftResize).toHaveAttribute('aria-valuemin', '200');
    await leftResize.press('Home');
    await expect(leftResize).toHaveAttribute('aria-valuenow', '200');
    const titleBrand = page.locator('.titlebar-brand');
    const brandBounds = (await titleBrand.boundingBox())!;
    const toggleBounds = (await page.getByRole('button', { name: 'Hide projects sidebar' }).boundingBox())!;
    expect(brandBounds.x).toBeGreaterThanOrEqual(82);
    expect(brandBounds.x + brandBounds.width).toBeLessThanOrEqual(toggleBounds.x);
    expect(await titleBrand.locator('.titlebar-brand-name').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);

    await leftResize.dblclick();
    await expect(leftResize).toHaveAttribute('aria-valuenow', '250');
    await leftResize.focus();
    await expect(leftResize).toHaveCSS('outline-style', 'none');
    const leftDragBounds = (await leftResize.boundingBox())!;
    const x = leftDragBounds.x + 3;
    const y = leftDragBounds.y + 150;
    // Observe before triggering the 250 ms transition. Sampling only after the
    // mouse RPC returns can miss the entire animation on a busy visible desktop.
    await expect(page.locator('.app')).not.toHaveClass(/sidebar-animating/);
    await page.locator('.app').evaluate((el) => {
      const result = new Promise<{ duration: string; offset: number }[]>((resolve) => {
        const samples: { duration: string; offset: number }[] = [];
        const sample = () => {
          if (el.classList.contains('sidebar-animating')) {
            const handle = el.querySelector('[aria-label="Resize projects sidebar"]')!.getBoundingClientRect();
            const panel = el.querySelector('.sidebar-viewport')!.getBoundingClientRect();
            samples.push({
              duration: getComputedStyle(el).transitionDuration,
              offset: Math.abs(handle.x + handle.width / 2 - panel.right),
            });
          } else if (samples.length) {
            resolve(samples);
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      Object.assign(window, { sidebarDragProbe: result });
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 111, y, { steps: 4 });
    const samples = await page.evaluate(() =>
      (window as unknown as { sidebarDragProbe: Promise<{ duration: string; offset: number }[]> }).sidebarDragProbe,
    );
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every(sample => sample.duration === '0.25s')).toBe(true);
    expect(Math.max(...samples.map(sample => sample.offset))).toBeLessThan(1);
    await expect(page.locator('.sidebar')).toBeHidden();
    await page.mouse.move(x - 109, y);
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.mouse.move(x - 111, y);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.sidebar-resize-shield')).toHaveCount(0);
    await expect(page.locator('.app')).not.toHaveClass(/sidebar-animating/);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 111, y);
    await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Show projects sidebar' })).toBeVisible();
    await page.getByRole('button', { name: 'Show projects sidebar' }).click();
    await expect(page.locator('.app')).not.toHaveClass(/sidebar-animating/);
    await expect(leftResize).toHaveAttribute('aria-valuenow', '250');
    const originalWidth = (await page.locator('iframe').boundingBox())!.width;
    const treeWidth = (await page.locator('.project-tree').boundingBox())!.width;
    await page.getByRole('button', { name: 'Hide projects sidebar' }).click();
    expect(
      await page.locator('.app').evaluate((el) => getComputedStyle(el).transitionDuration),
    ).toBe('0.25s');

    const widths = await page.locator('.sidebar-viewport').evaluate(async (el) => {
      const samples: number[] = [];
      const textWidths: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 400) {
        samples.push(el.getBoundingClientRect().width);
        if (el.closest('.app')?.classList.contains('sidebar-animating'))
          textWidths.push(el.querySelector('.project-tree')!.getBoundingClientRect().width);
        await new Promise(requestAnimationFrame);
      }
      return { samples, textWidths };
    });
    expect(widths.samples.some((width) => width > 0 && width < 250)).toBe(true);
    expect(widths.samples.at(-1)).toBe(0);
    expect(widths.textWidths.length).toBeGreaterThan(0);
    expect(widths.textWidths.every((width) => width === treeWidth)).toBe(true);

    const feedbackWidth = (await page.locator('.feedback-panel').boundingBox())!.width;
    await page.getByRole('button', { name: 'Hide feedback sidebar' }).click();
    const feedbackWidths = await page.locator('.feedback-panel').evaluate(async (el) => {
      const samples: number[] = [];
      while (el.closest('.app')?.classList.contains('sidebar-animating')) {
        samples.push(el.getBoundingClientRect().width);
        await new Promise(requestAnimationFrame);
      }
      return samples;
    });
    expect(feedbackWidths.length).toBeGreaterThan(0);
    expect(feedbackWidths.every((width) => width === feedbackWidth)).toBe(true);
    await expect(titlebar.getByRole('button', { name: 'Show projects sidebar' })).toBeVisible();
    await expect(titlebar.getByRole('button', { name: 'Show feedback sidebar' })).toBeVisible();
    await page.screenshot({ path: resolve('.tmp/tasks/titlebar-20261010/hidden.png') });
    await expect
      .poll(async () => (await page.locator('iframe').boundingBox())!.width)
      .toBeGreaterThan(originalWidth + 300);
    await page.getByRole('button', { name: 'Show projects sidebar' }).click();
    await page.getByRole('button', { name: 'Show feedback sidebar' }).click();
    await expect
      .poll(async () => (await page.locator('iframe').boundingBox())!.width)
      .toBe(originalWidth);
    await page.screenshot({
      path: resolve('.tmp/tasks/titlebar-20261010/production.png'),
    });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!.setSize(980, 700));
    for (let i = 0; i < 9; i++) {
      await newBrowserTab(page);
      await expect(page.getByRole('textbox', { name: 'New tab address' })).toBeFocused();
    }
    await expect(titlebar.getByRole('tab')).toHaveCount(10);
    const overflow = await titlebar.locator('.content-tabs').evaluate((el) => ({
      width: el.clientWidth,
      total: el.scrollWidth,
      left: el.scrollLeft,
    }));
    expect(overflow.total).toBeGreaterThan(overflow.width);
    expect(overflow.left).toBeGreaterThan(0);
    const selectedTab = await titlebar.locator('.content-tab.active').boundingBox();
    const plus = await titlebar.getByRole('button', { name: 'New tab', exact: true }).boundingBox();
    expect(selectedTab!.x + selectedTab!.width).toBeLessThanOrEqual(plus!.x + 1);
    await page.screenshot({ path: resolve('.tmp/tasks/titlebar-20261010/overflow.png') });
    await titlebar.getByRole('tab', { name: 'Plan', exact: true }).click();
    await expect
      .poll(() => titlebar.locator('.content-tabs').evaluate((el) => el.scrollLeft))
      .toBe(0);
    for (let i = 0; i < 9; i++) {
      await titlebar.getByRole('button', { name: 'Close new tab tab', exact: true }).last().click();
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!.setSize(1360, 900));

    await page.getByRole('button', { name: 'Annotate document', exact: true }).click();
    const bounds = await frame.getByLabel('Select annotation area').boundingBox();
    if (!bounds) throw Error('No area selection surface');
    await page.mouse.move(bounds.x + 50, bounds.y + 110);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 250, bounds.y + 210);
    await page.mouse.up();
    await expect(frame.getByLabel('Annotation comment')).toBeVisible();
    await expect(frame.locator('.inline-annotation-number')).toHaveCount(1);
    await frame.getByLabel('Annotation comment').fill('Review captured table');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(
      await mcp.tool('read_artifact', { artifactId: a.artifactId, part: 'state' }),
    ).toMatchObject({ savedState: null });
    await frame.getByRole('button', { name: 'Save private annotation' }).click();
    await expect(page.getByText('Review captured table', { exact: true })).toBeVisible();
    await expect
      .poll(
        () =>
          app
            .context()
            .pages()
            .filter((p) => p.url().startsWith('data:text/html')).length,
      )
      .toBe(1);
    const overlay = app
      .context()
      .pages()
      .find((p) => p.url().startsWith('data:text/html'))!;
    await expect(overlay.locator('#capture')).toBeVisible();
    await expect(overlay.locator('#composer')).toBeHidden();
    await expect(overlay.locator('#number')).toHaveText('1');
    await overlay.screenshot({
      path: resolve('.tmp/tasks/capture-no-comment-20261010/document.png'),
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Copy update message', exact: true }),
    ).toBeVisible();
    const saved = await mcp.tool('read_artifact', { artifactId: a.artifactId, part: 'state' });
    const state = JSON.parse(String(saved.content)) as {
      id: string;
      annotations: {
        number: number;
        source: {
          attachmentId: string;
          capture: { rect: { width: number }; pointer: { x: number; y: number } };
        };
      }[];
    };
    expect(state.annotations[0].number).toBe(1);
    expect(state.annotations[0].source.capture.rect.width).toBeCloseTo(200, 0);
    expect(state.annotations[0].source.capture.pointer).toEqual({ x: 250, y: 210 });
    const marker = frame.locator('.area-annotation-number').first();
    await expect(marker).toHaveAttribute('data-pointer-x', '250');
    await expect(marker).toHaveAttribute('data-pointer-y', '210');
    const attachment = await mcp.tool('read_attachment', {
      artifactId: a.artifactId,
      savedStateId: state.id,
      attachmentId: state.annotations[0].source.attachmentId,
    });
    expect(attachment.mimeType).toBe('image/svg+xml');
    let imageParts = String(attachment.content);
    let cursor = attachment.cursor;
    while (cursor) {
      const chunk = await mcp.tool('read_attachment', {
        artifactId: a.artifactId,
        savedStateId: state.id,
        attachmentId: state.annotations[0].source.attachmentId,
        cursor,
      });
      imageParts += String(chunk.content);
      cursor = chunk.cursor;
    }
    const svg = Buffer.from(imageParts, 'base64').toString();
    expect(svg).toContain('M250 210 ');
    expect(svg).not.toContain('Review captured table');
    await overlay.getByRole('button', { name: 'Close captured viewport' }).click();
    await frame.locator('body').evaluate((body) => {
      const spacer = document.createElement('div');
      spacer.id = 'area-scroll-fixture';
      spacer.style.height = '2200px';
      body.append(spacer);
      window.scrollTo(0, 800);
    });
    await expect(frame.locator('.area-annotation-number')).toHaveCount(0);
    await frame.locator('body').evaluate(() => window.scrollTo(0, 0));
    await expect(marker).toHaveAttribute('data-pointer-x', '250');
    await expect(marker).toHaveAttribute('data-pointer-y', '210');
    await frame.locator('#area-scroll-fixture').evaluate((element) => element.remove());
    // A click selects the hovered semantic paragraph; dragging above retained arbitrary geometry.
    await page.getByRole('button', { name: 'Annotate document', exact: true }).click();
    const paragraph = await frame
      .locator('p')
      .filter({ hasText: 'Inspect this visual section.' })
      .boundingBox();
    if (!paragraph) throw Error('Missing paragraph geometry');
    await page.mouse.move(paragraph.x + 20, paragraph.y + paragraph.height / 2);
    await expect(frame.locator('.element-hover-outline')).toBeVisible();
    const hovered = await frame.locator('.element-hover-outline').boundingBox();
    if (!hovered) throw Error('Missing semantic outline');
    expect(hovered.width).toBeCloseTo(paragraph.width, 0);
    await page.mouse.click(paragraph.x + 20, paragraph.y + paragraph.height / 2);
    await expect(frame.getByLabel('Annotation comment')).toBeVisible();
    await frame.getByLabel('Annotation comment').fill('Clicked paragraph element');
    await frame.getByRole('button', { name: 'Save private annotation' }).click();
    await expect(frame.getByLabel('Annotation comment')).toHaveCount(0);
    // Composer closure precedes the asynchronous frozen-capture presentation.
    // Establish its second capture before a later jump can reuse the old #1 DOM.
    await expect(overlay.locator('#capture')).toBeVisible();
    await expect(overlay.locator('#number')).toHaveText('2');
    await expect(overlay.locator('#composer')).toBeHidden();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.submit-area')).toContainText('Saved state is unchanged');
    const clicked = JSON.parse(
      String(
        (await mcp.tool('read_artifact', { artifactId: a.artifactId, part: 'state' })).content,
      ),
    ) as {
      annotations: {
        source: { capture: { rect: { width: number } }; stateContext: { stateHash: string } };
      }[];
    };
    expect(clicked.annotations[1].source.capture.rect.width).toBeCloseTo(paragraph.width, 0);
    expect(clicked.annotations[1].source.stateContext.stateHash).toMatch(/^[a-f0-9]{64}$/);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!.setSize(1100, 750);
    });
    await page.locator('.annotation-jump').first().click();
    await expect
      .poll(() =>
        app.evaluate(
          ({ webContents }) =>
            webContents.getAllWebContents().filter((w) => w.getURL().startsWith('data:text/html'))
              .length,
        ),
      )
      .toBe(1);
    await expect(overlay.locator('#number')).toHaveText('1');
    const frozen = await app.evaluate(async ({ webContents }) => {
      const view = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith('data:text/html'))!;
      return view.executeJavaScript(
        '({number:document.getElementById("number").textContent,width:innerWidth,help:document.getElementById("help").textContent})',
      ) as Promise<{ number: string; width: number; help: string }>;
    });
    expect(frozen.number).toBe('1');
    expect(frozen.width).toBeGreaterThan(200);
    expect(frozen.help).toContain('Saved capture');
    await expect(overlay.locator('#composer')).toBeHidden();
    await expect(overlay.getByText('Review captured table', { exact: true })).toHaveCount(0);
  } finally {
    mcp?.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
