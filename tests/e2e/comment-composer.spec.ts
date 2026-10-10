import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let app: ElectronApplication;
let root: string;
let page: Page;
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-composer-'));
  await mkdir(join(root, 'data'));
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {CommentComposer} from './src/renderer/CommentComposer';
function Fixture(){const [value,setValue]=useState(''),[open,setOpen]=useState(true),[editing,setEditing]=useState(false),[error,setError]=useState('');const ref=useRef(null);window.fixture={finish:()=>ref.current?.finish(),open:(edit=false)=>{setEditing(edit);setValue(edit?'Original comment':'');setOpen(true);setError('')},saved:window.fixture?.saved||[],canceled:window.fixture?.canceled||0,deleted:window.fixture?.deleted||0,fail:window.fixture?.fail||false,deferred:window.fixture?.deferred||false,resolve:window.fixture?.resolve};return <div style={{padding:30,width:460}}><button id="outside">Outside</button>{open&&<CommentComposer ref={ref} value={value} label="Comment" saveLabel="Save comment" editing={editing} onChange={setValue} onSave={async()=>{if(window.fixture.deferred)await new Promise(resolve=>window.fixture.resolve=resolve);if(window.fixture.fail)throw new Error('Disk unavailable');window.fixture.saved.push(value);setOpen(false)}} onCancel={async()=>{window.fixture.canceled++;setValue(editing?'Original comment':'');setOpen(false)}} onDelete={editing?async()=>{window.fixture.deleted++;setOpen(false)}:undefined} onError={e=>setError(e.message)}/>}<p role="alert">{error}</p></div>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
    },
    outfile: join(root, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
  });
  const css = await readFile(resolve('src/renderer/style.css'), 'utf8');
  await writeFile(
    join(root, 'index.html'),
    `<html><head><style>${css}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`,
  );
  await writeFile(
    join(root, 'main.cjs'),
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root, 'data'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:680,height:520,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});w.loadFile(${JSON.stringify(join(root, 'index.html'))})});app.on('window-all-closed',()=>app.quit());`,
  );
  app = await electron.launch({ args: [join(root, 'main.cjs')], timeout: 15000 });
  page = await app.firstWindow();
  await expect(page.getByLabel('Comment', { exact: true })).toBeVisible();
});
test.afterEach(async () => {
  await app?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  open(edit?: boolean): void;
  finish(): Promise<void>;
  saved: string[];
  canceled: number;
  deleted: number;
  fail: boolean;
  deferred: boolean;
  resolve?(): void;
}

// Real React component and production CSS in Electron; callbacks stand in only for
// private persistence. Disk durability is verified by the application's runtime tests.
test('compact field grows to six lines and scrolls beyond, keyboard and IME retain text', async () => {
  const input = page.getByLabel('Comment', { exact: true });
  const measure = () =>
    input.evaluate((element) => {
      const style = getComputedStyle(element);
      const line = parseFloat(style.lineHeight);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      return {
        height: element.getBoundingClientRect().height,
        line,
        padding,
        scroll: element.scrollHeight,
        overflow: style.overflowY,
      };
    });
  const one = await measure();
  expect(one.height).toBeGreaterThanOrEqual(one.line + one.padding);
  expect(one.height).toBeLessThanOrEqual(one.line + one.padding + 1);
  await input.fill('1\n2\n3\n4\n5\n6');
  const six = await measure();
  expect(six.height).toBeCloseTo(six.line * 6 + six.padding);
  await input.press('Shift+Enter');
  await input.press('7');
  const seven = await measure();
  expect(seven.height).toBeCloseTo(six.height);
  expect(seven.scroll).toBeGreaterThan(seven.height);
  expect(seven.overflow).toBe('auto');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(input).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.saved),
  ).toEqual(['1\n2\n3\n4\n5\n6\n7']);
});

test('outside completes private creation and empty editing cancels instead of deleting', async () => {
  const input = page.getByLabel('Comment', { exact: true });
  await input.fill('Outside saved');
  await page.locator('#outside').click();
  await expect(input).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.saved),
  ).toEqual(['Outside saved']);
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.open());
  await expect(input).toBeVisible();
  await page.locator('#outside').click();
  await expect(input).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.canceled),
  ).toBe(1);
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.open(true));
  await expect(input).toHaveValue('Original comment');
  await input.fill('');
  await page.locator('#outside').click();
  await expect(input).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.canceled),
  ).toBe(2);
  expect(
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.deleted),
  ).toBe(0);
});

test('finish rejects failed writes and overlapping completion awaits one operation', async () => {
  const input = page.getByLabel('Comment', { exact: true });
  await input.fill('Pending comment');
  await page.evaluate(() => ((window as unknown as { fixture: Fixture }).fixture.fail = true));
  expect(
    await page.evaluate(async () => {
      try {
        await (window as unknown as { fixture: Fixture }).fixture.finish();
        return 'unexpected success';
      } catch (error) {
        return String(error);
      }
    }),
  ).toContain('Disk unavailable');
  await expect(input).toHaveValue('Pending comment');
  await expect(page.getByRole('alert')).toContainText('Disk unavailable');
  await page.evaluate(() => {
    const f = (window as unknown as { fixture: Fixture }).fixture;
    f.fail = false;
    f.deferred = true;
    void Promise.all([f.finish(), f.finish()]);
  });
  await expect(input).toBeDisabled();
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.resolve?.());
  await expect(input).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.saved),
  ).toEqual(['Pending comment']);
});

test('edit action buttons stay inside the editor and preserve Save, Cancel and Delete intent', async () => {
  const input = page.getByLabel('Comment', { exact: true });
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.open(true));
  await input.fill('Edited comment');
  await page.getByRole('button', { name: 'Save comment', exact: true }).click();
  await expect(input).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.saved),
  ).toEqual(['Edited comment']);
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.open(true));
  await input.fill('Canceled comment');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(input).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.canceled),
  ).toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.saved),
  ).toEqual(['Edited comment']);
  await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.open(true));
  await page.getByRole('button', { name: 'Delete annotation', exact: true }).click();
  await expect(input).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { fixture: Fixture }).fixture.deleted),
  ).toBe(1);
});
