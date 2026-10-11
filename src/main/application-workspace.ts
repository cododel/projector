import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { MetadataWriter } from './metadata-write';
import {
  DEFAULT_SETTINGS, paneLeaves, workspaceKey,
  type ApplicationSettings, type ApplicationWorkspaceSnapshot,
  type BottomTerminals, type PaneContent, type PaneNode, type SessionWorkspace,
} from '../shared/application-workspace';
import type { WorkspaceSnapshot, WorkspaceTab } from '../shared/workspace';
import { isPrintableShortcutKey } from '../shared/keyboard-shortcuts';

const id = z.string().min(1).max(512);
const tabSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('document'), revisionId: id.nullable() }),
  z.object({ id, kind: z.literal('home'), address: z.string().max(10000) }),
  z.object({ id, kind: z.literal('browser'), url: z.string().max(10000), title: z.string().max(10000), nativeId: id.optional() }),
]);
const contentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('terminal'), terminalId: id }),
  z.object({ kind: z.literal('plan'), artifactId: id, tab: tabSchema,
    scrollTop: z.number().finite().nonnegative().optional(),
    details: z.record(z.string(), z.boolean()).optional() }),
]);
const nodeSchema: z.ZodType<PaneNode> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pane'), id, content: contentSchema }),
  z.object({ kind: z.literal('split'), id, axis: z.enum(['horizontal', 'vertical']),
    ratio: z.number().min(0.1).max(0.9), first: nodeSchema, second: nodeSchema }),
]));
const shortcutsSchema = z.record(z.enum([
  'newTab', 'closeTab', 'nextTab', 'previousTab', 'splitRight', 'splitDown',
  'nextPane', 'previousPane', 'bottomPanel', 'settings',
]), z.string().max(80).nullable());
export const applicationSettingsSchema = z.object({
  planPlacement: z.enum(['beside', 'tab']), restoreWorkspace: z.boolean(),
  shell: z.string().max(4096), shellArgs: z.array(z.string().max(4096)).max(50),
  terminalFont: z.string().min(1).max(200), terminalFontSize: z.number().int().min(8).max(36),
  terminalScrollback: z.number().int().min(100).max(50000),
  codexExecutable: z.string().min(1).max(4096), codexProfile: z.string().max(200),
  shortcuts: shortcutsSchema,
}).strict();
const sessionSchema = z.object({ projectId: id, sessionId: id.nullable(),
  tabs: z.array(z.object({ id, root: nodeSchema })), activeTabId: id.nullable(), activePaneId: id.nullable() });
const bottomSchema = z.object({ tabs: z.array(id), activeTerminalId: id.nullable(),
  visible: z.boolean(), height: z.number().int().min(120).max(800) });
const schema = z.object({ formatVersion: z.literal(1), settings: applicationSettingsSchema,
  selectedWorkspace: id.nullable(), workspaces: z.record(id, sessionSchema), bottom: z.record(id, bottomSchema) });

export function normalizeShortcut(value: string, allowTextInput = false): string {
  const parts = value.split('+').map(part => part.trim());
  if (parts.length < 2 || parts.some(part => !part)) throw new Error('INVALID_SHORTCUT');
  const key = parts.pop()!;
  const modifiers = parts.map(part => part === 'Meta' || part === 'Command' ? 'Mod' : part);
  if (modifiers.some(part => !['Mod', 'Control', 'Alt', 'Shift'].includes(part)) ||
    new Set(modifiers).size !== modifiers.length) throw new Error('INVALID_SHORTCUT');
  if (!allowTextInput && isPrintableShortcutKey(key) && !modifiers.some(part => part === 'Mod' || part === 'Control'))
    throw new Error('SHORTCUT_TEXT_INPUT: Text shortcuts require Command or Control.');
  return [...['Mod', 'Control', 'Alt', 'Shift'].filter(part => modifiers.includes(part)), key.toLowerCase()].join('+');
}
/** App-owned views only. Artifact content, approval and live process ownership stay elsewhere. */
export class ApplicationWorkspace {
  private value: ApplicationWorkspaceSnapshot = {
    formatVersion: 1, settings: structuredClone(DEFAULT_SETTINGS), selectedWorkspace: null, workspaces: {}, bottom: {},
  };
  private readonly metadata: MetadataWriter;
  constructor(private readonly path: string) { this.metadata = new MetadataWriter(path); }
  hasPendingConfirmation(): boolean { return this.metadata.hasPendingConfirmation(); }
  assertConfirmed(): void { this.metadata.assertConfirmed(); }
  confirmPending(): Promise<void> { return this.metadata.confirmPending(); }
  async load() {
    try { this.value = schema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Older text-producing bindings remain readable with the workspace intact.
    // The keyboard boundary ignores them; changing settings requires remapping.
    this.validateSettings(this.value.settings, true);
    if (!this.value.settings.restoreWorkspace) this.value.selectedWorkspace = null;
  }
  snapshot(): ApplicationWorkspaceSnapshot { return structuredClone(this.value); }
  restore(value: ApplicationWorkspaceSnapshot) { this.assertConfirmed(); this.value = schema.parse(value); }
  workspace(key: string): SessionWorkspace {
    const workspace = this.value.workspaces[key];
    if (!workspace) throw new Error('WORKSPACE_NOT_FOUND');
    return workspace;
  }
  select(projectId: string, sessionId: string | null): string {
    this.assertConfirmed();
    id.parse(projectId); if (sessionId !== null) id.parse(sessionId);
    const key = workspaceKey(projectId, sessionId);
    this.value.workspaces[key] ??= { projectId, sessionId, tabs: [], activeTabId: null, activePaneId: null };
    this.value.selectedWorkspace = key;
    return key;
  }
  private newTab(key: string, content: PaneContent) {
    this.assertConfirmed();
    const pane: Extract<PaneNode, { kind: 'pane' }> = { kind: 'pane', id: randomUUID(), content: contentSchema.parse(content) };
    const tab = { id: randomUUID(), root: pane };
    const workspace = this.workspace(key);
    workspace.tabs.push(tab); workspace.activeTabId = tab.id; workspace.activePaneId = pane.id;
    return pane;
  }
  terminal(key: string, terminalId: string) {
    this.assertConfirmed();
    const workspace = this.workspace(key);
    const existing = workspace.tabs.flatMap(tab => paneLeaves(tab.root))
      .find(pane => pane.content.kind === 'terminal' && pane.content.terminalId === terminalId);
    if (existing) { this.focus(key, existing.id); return existing; }
    return this.newTab(key, { kind: 'terminal', terminalId });
  }
  openPlan(key: string, artifactId: string, tab: WorkspaceTab) {
    this.assertConfirmed();
    const workspace = this.workspace(key);
    const existing = workspace.tabs.flatMap(item => paneLeaves(item.root))
      .find(pane => pane.content.kind === 'plan' && pane.content.artifactId === artifactId && pane.content.tab.kind === tab.kind &&
        (tab.kind === 'document' || pane.content.tab.id === tab.id));
    if (existing) {
      if (existing.content.kind === 'plan') existing.content.tab = structuredClone(tab);
      this.focus(key, existing.id); return existing;
    }
    const content: PaneContent = { kind: 'plan', artifactId, tab: structuredClone(tab) };
    const active = workspace.activePaneId ? this.findPane(key, workspace.activePaneId) : null;
    if (tab.kind === 'document' && this.value.settings.planPlacement === 'beside' && active?.content.kind === 'terminal')
      return this.split(key, active.id, 'horizontal', content);
    return this.newTab(key, content);
  }
  findPane(key: string, paneId: string) {
    const pane = this.workspace(key).tabs.flatMap(tab => paneLeaves(tab.root)).find(pane => pane.id === paneId);
    if (!pane) throw new Error('PANE_NOT_FOUND');
    return pane;
  }
  focus(key: string, paneId: string) {
    this.assertConfirmed();
    this.findPane(key, paneId);
    const workspace = this.workspace(key);
    workspace.activeTabId = workspace.tabs.find(tab => paneLeaves(tab.root).some(pane => pane.id === paneId))!.id;
    workspace.activePaneId = paneId;
  }
  selectTab(key: string, tabId: string) {
    this.assertConfirmed();
    const workspace = this.workspace(key); const tab = workspace.tabs.find(tab => tab.id === tabId);
    if (!tab) throw new Error('WORKSPACE_TAB_NOT_FOUND');
    const pane = paneLeaves(tab.root).find(pane => pane.id === workspace.activePaneId) ?? paneLeaves(tab.root)[0];
    workspace.activeTabId = tab.id; workspace.activePaneId = pane.id;
  }
  split(key: string, paneId: string, axis: 'horizontal' | 'vertical', content: PaneContent) {
    this.assertConfirmed();
    this.findPane(key, paneId);
    const workspace = this.workspace(key);
    const pane: Extract<PaneNode, { kind: 'pane' }> = {
      kind: 'pane', id: randomUUID(), content: contentSchema.parse(content),
    };
    const replace = (node: PaneNode): PaneNode => {
      if (node.kind === 'pane')
        return node.id === paneId
          ? { kind: 'split', id: randomUUID(), axis, ratio: 0.5, first: node, second: pane }
          : node;
      return { ...node, first: replace(node.first), second: replace(node.second) };
    };
    const tab = workspace.tabs.find(tab => paneLeaves(tab.root).some(item => item.id === paneId))!;
    tab.root = replace(tab.root);
    workspace.activeTabId = tab.id;
    workspace.activePaneId = pane.id;
    return pane;
  }
  ratio(key: string, splitId: string, ratio: number) {
    this.assertConfirmed();
    const update = (node: PaneNode): boolean => {
      if (node.kind !== 'split') return false;
      if (node.id === splitId) { node.ratio = z.number().min(0.1).max(0.9).parse(ratio); return true; }
      return update(node.first) || update(node.second);
    };
    if (!this.workspace(key).tabs.some(tab => update(tab.root))) throw new Error('SPLIT_NOT_FOUND');
  }
  closeTab(key: string, tabId: string) {
    this.assertConfirmed();
    const workspace = this.workspace(key), index = workspace.tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    workspace.tabs.splice(index, 1);
    if (workspace.activeTabId === tabId) {
      const next = workspace.tabs[Math.min(index, workspace.tabs.length - 1)];
      workspace.activeTabId = next?.id ?? null; workspace.activePaneId = next ? paneLeaves(next.root)[0].id : null;
    }
  }
  closePane(key: string, paneId: string) {
    this.assertConfirmed();
    const workspace = this.workspace(key); this.findPane(key, paneId);
    const tab = workspace.tabs.find(tab => paneLeaves(tab.root).some(pane => pane.id === paneId))!;
    const remove = (node: PaneNode): PaneNode | null => {
      if (node.kind === 'pane') return node.id === paneId ? null : node;
      const first = remove(node.first), second = remove(node.second);
      if (!first) return second; if (!second) return first;
      return { ...node, first, second };
    };
    const root = remove(tab.root);
    if (!root) this.closeTab(key, tab.id);
    else {
      tab.root = root;
      if (workspace.activePaneId === paneId) workspace.activePaneId = paneLeaves(root)[0].id;
    }
  }
  view(key: string, paneId: string, view: { scrollTop?: number; details?: Record<string, boolean> }) {
    this.assertConfirmed();
    const pane = this.findPane(key, paneId);
    if (pane.content.kind !== 'plan') throw new Error('PLAN_PANE_REQUIRED');
    pane.content = contentSchema.parse({ ...pane.content, ...view });
  }
  planTab(key: string, paneId: string, tab: WorkspaceTab) {
    this.assertConfirmed();
    const pane = this.findPane(key, paneId);
    if (pane.content.kind !== 'plan') throw new Error('PLAN_PANE_REQUIRED');
    const parsed = contentSchema.parse({ ...pane.content, tab });
    if (parsed.kind !== 'plan') throw new Error('PLAN_PANE_REQUIRED');
    pane.content.tab = parsed.tab;
  }
  syncBrowser(tabs: { id: string; url: string; title: string }[]) {
    this.assertConfirmed();
    let changed = false;
    for (const entry of Object.values(this.value.workspaces))
      for (const tab of entry.tabs)
        for (const pane of paneLeaves(tab.root)) {
          if (pane.content.kind !== 'plan' || pane.content.tab.kind !== 'browser') continue;
          const nativeId = pane.content.tab.nativeId;
          const native = tabs.find(item => item.id === nativeId);
          if (!native || (pane.content.tab.url === native.url && pane.content.tab.title === native.title)) continue;
          pane.content.tab.url = native.url; pane.content.tab.title = native.title; changed = true;
        }
    return changed;
  }
  bottom(projectId: string): BottomTerminals {
    if (!this.value.bottom[projectId]) this.assertConfirmed();
    return this.value.bottom[projectId] ??= { tabs: [], activeTerminalId: null, visible: false, height: 260 };
  }
  bottomTerminal(projectId: string, terminalId: string) {
    this.assertConfirmed();
    const bottom = this.bottom(projectId); id.parse(terminalId);
    if (!bottom.tabs.includes(terminalId)) bottom.tabs.push(terminalId);
    bottom.activeTerminalId = terminalId; bottom.visible = true;
  }
  setBottom(projectId: string, value: BottomTerminals) { this.assertConfirmed(); this.value.bottom[projectId] = bottomSchema.parse(value); }
  settings(value: unknown) { this.assertConfirmed(); this.value.settings = this.validateSettings(value); }
  private validateSettings(value: unknown, allowTextInput = false): ApplicationSettings {
    const parsed = applicationSettingsSchema.parse(value), used = new Set<string>();
    for (const shortcut of Object.values(parsed.shortcuts)) if (shortcut !== null) {
      const normalized = normalizeShortcut(shortcut, allowTextInput);
      if (used.has(normalized)) throw new Error('SHORTCUT_CONFLICT');
      used.add(normalized);
    }
    return parsed;
  }
  migrateLegacy(legacy: WorkspaceSnapshot, artifacts: { id: string; projectId: string }[]) {
    this.assertConfirmed();
    const existing = new Set(Object.keys(this.value.workspaces));
    const selected = this.value.selectedWorkspace;
    for (const artifact of artifacts) {
      const key = workspaceKey(artifact.projectId, null);
      if (existing.has(key)) continue;
      const old = legacy.plans[artifact.id]; if (!old) continue;
      this.select(artifact.projectId, null);
      for (const tab of old.tabs) this.newTab(key, { kind: 'plan', artifactId: artifact.id, tab });
    }
    this.value.selectedWorkspace = selected;
  }
  save() {
    // Native pages are process-owned. Restore URLs lazily after a real application restart.
    const value = schema.parse(this.value);
    for (const workspace of Object.values(value.workspaces))
      for (const tab of workspace.tabs)
        for (const pane of paneLeaves(tab.root))
          if (pane.content.kind === 'plan' && pane.content.tab.kind === 'browser')
            delete pane.content.tab.nativeId;
    return this.metadata.write(value);
  }
}
