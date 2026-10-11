import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationWorkspace } from '../src/main/application-workspace';
import { paneLeaves } from '../src/shared/application-workspace';
import { Workspace } from '../src/main/workspace';

const fault = vi.hoisted(() => ({ directorySyncFailures: 0, fileSyncFailures: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    if (args[1] === 'r') {
      const directory = (await file.stat()).isDirectory();
      const sync = file.sync.bind(file);
      file.sync = async () => {
        if (directory ? fault.directorySyncFailures > 0 : fault.fileSyncFailures > 0) {
          if (directory) --fault.directorySyncFailures; else --fault.fileSyncFailures;
          throw Object.assign(new Error('Synthetic lost sync acknowledgement'), { code: 'EIO' });
        }
        await sync();
      };
    }
    return file;
  } };
});

let directory = '';
afterEach(async () => {
  fault.directorySyncFailures = 0;
  fault.fileSyncFailures = 0;
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function store() {
  directory = await mkdtemp(join(tmpdir(), 'bp-session-workspace-'));
  const workspace = new ApplicationWorkspace(join(directory, 'workspaces.json'));
  await workspace.load();
  return workspace;
}
it('keeps per-session splits and project bottom terminals independent after restart', async () => {
  const w = await store();
  const one = w.select('project-a', 'session-one');
  const terminal = w.terminal(one, 'terminal-one');
  w.split(one, terminal.id, 'vertical', { kind: 'terminal', terminalId: 'terminal-two' });
  w.openPlan(one, 'artifact-one', { id: 'doc-one', kind: 'document', revisionId: 'r1' });
  w.bottomTerminal('project-a', 'dev-server');
  const two = w.select('project-a', 'session-two');
  w.terminal(two, 'terminal-three');
  const other = w.select('project-b', 'session-three');
  w.bottomTerminal('project-b', 'other-server');
  await w.save();
  const restored = new ApplicationWorkspace(join(directory, 'workspaces.json'));
  await restored.load();
  expect(restored.snapshot()).toEqual(w.snapshot());
  expect(restored.workspace(one).tabs).toHaveLength(1);
  expect(paneLeaves(restored.workspace(one).tabs[0].root).map(p => p.content.kind)).toEqual(['terminal', 'terminal', 'plan']);
  expect(restored.workspace(two).tabs).toHaveLength(1);
  expect(restored.workspace(other).tabs).toHaveLength(0);
  expect(restored.snapshot().bottom['project-a'].tabs).toEqual(['dev-server']);
  expect(restored.snapshot().bottom['project-b'].tabs).toEqual(['other-server']);
});
it('reuses an open plan and closing its pane retains siblings without stopping terminals', async () => {
  const w = await store(); const key = w.select('p', 's');
  w.terminal(key, 't');
  const pane = w.openPlan(key, 'a', { id: 'd', kind: 'document', revisionId: 'r1' });
  const same = w.openPlan(key, 'a', { id: 'd2', kind: 'document', revisionId: 'r2' });
  expect(same.id).toBe(pane.id);
  expect(w.workspace(key).tabs).toHaveLength(1);
  w.closePane(key, pane.id);
  expect(paneLeaves(w.workspace(key).tabs[0].root).map(p => p.content)).toEqual([{ kind: 'terminal', terminalId: 't' }]);
});
it('isolates document view state while keeping artifact identity and never persists native browser IDs', async () => {
  const w = await store(); const one = w.select('p', 's1');
  const p1 = w.openPlan(one, 'a', { id: 'd', kind: 'document', revisionId: 'r' });
  const two = w.select('p', 's2');
  const p2 = w.openPlan(two, 'a', { id: 'b', kind: 'browser', url: 'https://example.com', title: 'Example', nativeId: 'native-ephemeral' });
  w.view(one, p1.id, { scrollTop: 321, details: { disclosure: true } });
  await w.save();
  expect((w.findPane(one, p1.id).content as { scrollTop?: number }).scrollTop).toBe(321);
  expect((w.findPane(two, p2.id).content as { scrollTop?: number }).scrollTop).toBeUndefined();
  expect(await readFile(join(directory, 'workspaces.json'), 'utf8')).not.toContain('native-ephemeral');
});
it('rejects shortcut conflicts and invalid sizes without replacing valid settings', async () => {
  const w = await store(); const original = w.snapshot().settings;
  expect(() => w.settings({ ...original, shortcuts: { ...original.shortcuts, splitRight: 'Mod+J' } })).toThrow('SHORTCUT_CONFLICT');
  expect(() => w.settings({ ...original, terminalScrollback: -1 })).toThrow();
  for (const binding of ['Shift+A', 'Alt+å', 'Alt+Shift+Å', 'Shift+Space', 'Alt+Comma'])
    expect(() => w.settings({ ...original, shortcuts: { ...original.shortcuts, newTab: binding } })).toThrow('SHORTCUT_TEXT_INPUT');
  expect(w.snapshot().settings).toEqual(original);
  w.settings({ ...original, shortcuts: { ...original.shortcuts, splitRight: 'Mod+Shift+D' } });
  expect(w.snapshot().settings.shortcuts.splitRight).toBe('Mod+Shift+D');
});
it('opens legacy text-producing bindings without losing the workspace and requires explicit remapping', async () => {
  const w = await store();
  const key = w.select('project', 'session');
  w.terminal(key, 'existing-terminal');
  const persisted = w.snapshot();
  persisted.settings.shortcuts.newTab = 'Shift+A';
  await writeFile(join(directory, 'workspaces.json'), JSON.stringify(persisted));
  const restored = new ApplicationWorkspace(join(directory, 'workspaces.json'));
  await restored.load();
  expect(restored.snapshot()).toEqual(persisted);
  expect(() => restored.settings(persisted.settings)).toThrow('SHORTCUT_TEXT_INPUT');
  restored.settings({ ...persisted.settings, shortcuts: { ...persisted.settings.shortcuts, newTab: 'Mod+Shift+A' } });
  expect(restored.snapshot().settings.shortcuts.newTab).toBe('Mod+Shift+A');
});
it('migrates every legacy plan in one project once without losing tabs or changing selection', async () => {
  const w = await store();
  const selected = w.select('other', 'session');
  const legacy = { layout: { leftSidebarVisible: false, rightSidebarVisible: true }, plans: {
    a: { tabs: [{ id: 'a-doc', kind: 'document' as const, revisionId: 'r2' },
      { id: 'a-home', kind: 'home' as const, address: 'https://a.test/' }], activeTabId: 'a-home' },
    b: { tabs: [{ id: 'b-browser', kind: 'browser' as const, url: 'https://b.test/', title: 'B' }], activeTabId: 'b-browser' },
  } };
  const artifacts = [{ id: 'a', projectId: 'project' }, { id: 'b', projectId: 'project' }];
  w.migrateLegacy(legacy, artifacts);
  expect(w.snapshot().selectedWorkspace).toBe(selected);
  expect(w.workspace('project/plans').tabs.flatMap(tab => paneLeaves(tab.root)).map(pane => pane.content)).toEqual([
    { kind: 'plan', artifactId: 'a', tab: legacy.plans.a.tabs[0] },
    { kind: 'plan', artifactId: 'a', tab: legacy.plans.a.tabs[1] },
    { kind: 'plan', artifactId: 'b', tab: legacy.plans.b.tabs[0] },
  ]);
  w.migrateLegacy(legacy, artifacts);
  expect(w.workspace('project/plans').tabs).toHaveLength(3);
});
it('keeps native browser bindings through local edits and rollback, but restores only URLs after restart', async () => {
  const w = await store(); const key = w.select('p', 's');
  const pane = w.openPlan(key, 'a', { id: 'browser', kind: 'browser', url: 'https://a.test', title: 'A', nativeId: 'native' });
  w.view(key, pane.id, { scrollTop: 20 });
  const before = w.snapshot();
  w.restore(before);
  expect(w.findPane(key, pane.id).content).toMatchObject({ tab: { nativeId: 'native' } });
  w.syncBrowser([{ id: 'native', url: 'https://b.test', title: 'B' }]);
  await w.save();
  const restored = new ApplicationWorkspace(join(directory, 'workspaces.json')); await restored.load();
  expect(restored.findPane(key, pane.id).content).toMatchObject({ tab: { url: 'https://b.test', title: 'B' } });
  expect(JSON.stringify(restored.snapshot())).not.toContain('native');
});
it('reconciles one lost fsync acknowledgement without replaying a workspace mutation', async () => {
  const w = await store();
  const key = w.select('p', 's');
  const pane = w.terminal(key, 'exact-terminal');
  fault.directorySyncFailures = 1;
  await expect(w.save()).resolves.toBeUndefined();
  expect(w.findPane(key, pane.id).content).toEqual({ kind: 'terminal', terminalId: 'exact-terminal' });
  const restored = new ApplicationWorkspace(join(directory, 'workspaces.json'));
  await restored.load();
  expect(restored.snapshot()).toEqual(w.snapshot());
});
it('retains a renamed workspace and blocks mutations until metadata-only durability confirmation', async () => {
  const w = await store();
  const key = w.select('p', 's');
  await w.save();
  const previous = w.snapshot();
  const pane = w.openPlan(key, 'a', { id: 'browser', kind: 'browser', url: 'https://a.test/',
    title: 'A', nativeId: 'native-process-only' });
  const attempted = w.snapshot();
  fault.directorySyncFailures = Infinity;
  await expect(w.save()).rejects.toMatchObject({ code: 'UNKNOWN_RESULT',
    details: { phase: 'after-rename', metadataConfirmation: true } });
  const file = join(directory, 'workspaces.json');
  const bytes = await readFile(file, 'utf8');
  expect(bytes).not.toContain('native-process-only');
  expect(JSON.parse(bytes).workspaces[key].tabs).toHaveLength(1);
  expect(w.hasPendingConfirmation()).toBe(true);
  expect(w.snapshot()).toEqual(attempted);
  expect(() => w.restore(previous)).toThrow(/Retry confirmation/);
  expect(() => w.terminal(key, 'duplicate-process')).toThrow(/Retry confirmation/);
  await expect(w.save()).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' });
  await expect(w.confirmPending()).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' });
  expect(await readFile(file, 'utf8')).toBe(bytes);
  fault.directorySyncFailures = 0;
  await w.confirmPending();
  expect(w.hasPendingConfirmation()).toBe(false);
  expect(w.findPane(key, pane.id).content).toMatchObject({ tab: { nativeId: 'native-process-only' } });
  expect(w.snapshot()).toEqual(attempted);
  await w.confirmPending();
  expect(await readFile(file, 'utf8')).toBe(bytes);
});
it('never overwrites changed readback while trying to confirm an unknown commit', async () => {
  const w = await store();
  w.select('p', null);
  fault.directorySyncFailures = Infinity;
  await expect(w.save()).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' });
  const file = join(directory, 'workspaces.json');
  const original = await readFile(file, 'utf8');
  await writeFile(file, '{"externalChange":true}');
  fault.directorySyncFailures = 0;
  await expect(w.confirmPending()).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' });
  expect(await readFile(file, 'utf8')).toBe('{"externalChange":true}');
  expect(w.hasPendingConfirmation()).toBe(true);
  await writeFile(file, original);
  await w.confirmPending();
  expect(w.hasPendingConfirmation()).toBe(false);
});
it('requires confirmed file fsync as well as directory fsync after a lost acknowledgement', async () => {
  const w = await store();
  w.select('p', null);
  fault.directorySyncFailures = 1;
  fault.fileSyncFailures = Infinity;
  await expect(w.save()).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' });
  expect(w.hasPendingConfirmation()).toBe(true);
  await expect(w.confirmPending()).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' });
  fault.fileSyncFailures = 0;
  await w.confirmPending();
  expect(w.hasPendingConfirmation()).toBe(false);
});
it('applies the same confirmation barrier to legacy workspace layout and tabs', async () => {
  await store();
  const path = join(directory, 'legacy-workspace.json');
  const w = new Workspace(path);
  w.document('a', 'r1');
  await w.save();
  const previous = w.snapshot();
  w.setLayout({ leftSidebarVisible: false, rightSidebarVisible: true });
  fault.directorySyncFailures = Infinity;
  await expect(w.save()).rejects.toMatchObject({ code: 'UNKNOWN_RESULT' });
  expect(w.snapshot().layout.leftSidebarVisible).toBe(false);
  expect(w.hasPendingConfirmation()).toBe(true);
  expect(() => w.restore(previous)).toThrow(/Retry confirmation/);
  expect(() => w.home('a')).toThrow(/Retry confirmation/);
  fault.directorySyncFailures = 0;
  await w.confirmPending();
  expect(w.hasPendingConfirmation()).toBe(false);
  const restored = new Workspace(path);
  await restored.load();
  expect(restored.snapshot()).toEqual(w.snapshot());
});
