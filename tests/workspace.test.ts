import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/main/workspace';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'bp-tabs-'));
  roots.push(root);
  const path = join(root, 'workspace.json');
  const workspace = new Workspace(path);
  await workspace.load();
  return { path, workspace };
}
it('persists isolated plan tabs, selected revisions and home addresses without native handles', async () => {
  const { path, workspace: w } = await setup();
  const doc = w.document('one', 'v1');
  const home = w.home('one');
  w.address('one', home.id, 'https://example.test/draft');
  const other = w.document('two', 'v2');
  const browser = w.browser('two', {
    id: 'native-process-id',
    url: 'https://example.test',
    title: 'Page',
  });
  w.select('two', other.id);
  await w.save();
  const restored = new Workspace(path);
  await restored.load();
  expect(restored.snapshot().plans.one).toEqual({
    tabs: [doc, home],
    activeTabId: home.id,
    lastDocumentRevisionId: 'v1',
  });
  expect(restored.snapshot().plans.two).toEqual({
    tabs: [other, { id: browser.id, kind: 'browser', url: 'https://example.test', title: 'Page' }],
    activeTabId: other.id,
    lastDocumentRevisionId: 'v2',
  });
  expect(await readFile(path, 'utf8')).not.toContain('native-process-id');
});
it('converts a home in place, reuses a document and closes only the selected plan view', async () => {
  const { workspace: w } = await setup();
  const doc = w.document('one', 'v1'),
    home = w.home('one');
  w.browser('one', { id: 'native', url: 'https://example.test', title: 'Page' }, home.id);
  expect(w.plan('one').tabs.map((t) => t.id)).toEqual([doc.id, home.id]);
  expect(w.document('one', 'v2').id).toBe(doc.id);
  expect(w.plan('one').tabs).toHaveLength(2);
  const other = w.home('two');
  w.close('one', home.id);
  w.close('one', doc.id);
  w.close('one', doc.id);
  expect(w.plan('one')).toEqual({ tabs: [], activeTabId: null, lastDocumentRevisionId: 'v2' });
  expect(w.plan('two').tabs).toEqual([other]);
  expect(w.document('one', 'v2').id).not.toBe(doc.id);
});
it('synchronizes navigation only by native identity and rejects unknown or inappropriate views', async () => {
  const { workspace: w } = await setup();
  const doc = w.document('one', 'v1');
  w.browser('one', { id: 'a', url: 'https://example.test', title: 'A' });
  w.browser('two', { id: 'b', url: 'https://example.test', title: 'B' });
  expect(w.sync([{ id: 'a', url: 'https://example.test/next', title: 'Next' }])).toBe(true);
  expect(w.plan('two').tabs[0]).toMatchObject({ title: 'B' });
  expect(() => w.select('two', doc.id)).toThrow('WORKSPACE_TAB_NOT_FOUND');
  expect(() => w.address('one', doc.id, '')).toThrow('WORKSPACE_HOME_REQUIRED');
});
it('retains the selected document revision after closing its view and restarting', async () => {
  const { path, workspace: w } = await setup();
  const doc = w.document('one', 'historical-v1');
  w.close('one', doc.id);
  await w.save();
  const restored = new Workspace(path);
  await restored.load();
  expect(restored.snapshot().plans.one).toMatchObject({
    lastDocumentRevisionId: 'historical-v1',
    tabs: [],
    activeTabId: null,
  });
});

it('persists sidebar visibility separately from plan workspaces', async () => {
  const { path, workspace: w } = await setup();
  expect(w.snapshot().layout).toEqual({ leftSidebarVisible: true, rightSidebarVisible: true });
  w.setLayout({ leftSidebarVisible: false, rightSidebarVisible: false });
  await w.save();
  const restored = new Workspace(path);
  await restored.load();
  expect(restored.snapshot().layout).toEqual({
    leftSidebarVisible: false,
    rightSidebarVisible: false,
  });
  expect(restored.snapshot().plans).toEqual({});
});

it('persists sidebar sizes and rejects out-of-range layout writes', async () => {
  const { path, workspace: w } = await setup();
  w.setLayout({
    leftSidebarVisible: true,
    rightSidebarVisible: false,
    leftSidebarWidth: 200,
    rightSidebarWidth: 250,
  });
  await w.save();
  const restored = new Workspace(path);
  await restored.load();
  expect(restored.snapshot().layout).toEqual(w.snapshot().layout);
  expect(() => w.setLayout({ ...w.snapshot().layout, leftSidebarWidth: 199 })).toThrow();
  expect(() => w.setLayout({ ...w.snapshot().layout, leftSidebarWidth: 501 })).toThrow();
  expect(() => w.setLayout({ ...w.snapshot().layout, rightSidebarWidth: 249 })).toThrow();
});
