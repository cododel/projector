import type { TerminalColorScheme, TerminalThemeMode } from './terminal-theme';
import type { WorkspaceTab } from './workspace';

export type PaneContent =
  | { kind: 'session'; sessionId: string; terminalId?: string }
  | { kind: 'terminal'; terminalId: string }
  | {
      kind: 'plan';
      artifactId: string;
      tab: WorkspaceTab;
      scrollTop?: number;
      details?: Record<string, boolean>;
    };
export type PaneNode =
  | { kind: 'pane'; id: string; content: PaneContent }
  | { kind: 'split'; id: string; axis: 'horizontal' | 'vertical'; ratio: number; first: PaneNode; second: PaneNode };
export interface ApplicationTab {
  id: string;
  root: PaneNode;
}
export interface SessionWorkspace {
  projectId: string;
  sessionId: string | null;
  tabs: ApplicationTab[];
  activeTabId: string | null;
  activePaneId: string | null;
}
export interface BottomTerminals {
  tabs: string[];
  activeTerminalId: string | null;
  visible: boolean;
  height: number;
}
export type ShortcutAction =
  | 'newTab' | 'closeTab' | 'nextTab' | 'previousTab'
  | 'splitRight' | 'splitDown' | 'nextPane' | 'previousPane'
  | 'bottomPanel' | 'settings';
export interface ApplicationSettings {
  appearance: 'system' | 'light' | 'dark';
  planPlacement: 'beside' | 'tab';
  restoreWorkspace: boolean;
  shell: string;
  shellArgs: string[];
  terminalFont: string;
  terminalFontSize: number;
  terminalScrollback: number;
  terminalTheme: TerminalThemeMode;
  terminalCustomTheme: TerminalColorScheme | null;
  codexExecutable: string;
  codexProfile: string;
  shortcuts: Record<ShortcutAction, string | null>;
}
export const DEFAULT_SHORTCUTS: ApplicationSettings['shortcuts'] = {
  newTab: 'Mod+T', closeTab: 'Mod+W', nextTab: 'Control+Tab', previousTab: 'Control+Shift+Tab',
  splitRight: null, splitDown: null, nextPane: null, previousPane: null,
  bottomPanel: 'Mod+J', settings: 'Mod+Comma',
};
export const DEFAULT_SETTINGS: ApplicationSettings = {
  appearance: 'system', planPlacement: 'beside', restoreWorkspace: true, shell: '', shellArgs: [],
  terminalFont: 'Menlo, Monaco, monospace', terminalFontSize: 13,
  terminalTheme: 'follow', terminalCustomTheme: null,
  terminalScrollback: 10000, codexExecutable: 'codex', codexProfile: '',
  shortcuts: DEFAULT_SHORTCUTS,
};
export interface ApplicationWorkspaceSnapshot {
  formatVersion: 1;
  settings: ApplicationSettings;
  selectedWorkspace: string | null;
  selectedSurface?: 'project' | 'workspace';
  pinnedSessionIds?: string[];
  workspaces: Record<string, SessionWorkspace>;
  bottom: Record<string, BottomTerminals>;
}
export function paneLeaves(root: PaneNode): Extract<PaneNode, { kind: 'pane' }>[] {
  return root.kind === 'pane' ? [root] : [...paneLeaves(root.first), ...paneLeaves(root.second)];
}
export function workspaceKey(projectId: string, sessionId: string | null): string {
  return `${projectId}/${sessionId ?? 'plans'}`;
}
