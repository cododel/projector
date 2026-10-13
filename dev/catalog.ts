export interface CatalogEntry {
  name: string;
  sources: string[];
  status: 'included' | 'planned' | 'native';
  states: string;
  notApplicable?: string;
  stories?: { name: string; id: string }[];
  boundary: string;
}

/** Coverage inventory, not a claim of a complete catalog. Keep it in sync with UI changes. */
export const catalog: CatalogEntry[] = [
  {
    name: 'Notification stack', sources: ['src/renderer/NotificationStack.tsx'], status: 'included',
    states: 'Empty, info, warning, error, Undo, waiting, disabled pending action, repeats, three alerts, overflow, long/expanded details, dismiss, keyboard, live transitions.',
    notApplicable: 'Selected/pinned are session concepts. Native focus/routing is not browser coverage.',
    stories: [
      { name: 'State sheet', id: 'notifications-stack--state-sheet' },
      { name: 'Live transitions', id: 'notifications-stack--playground' },
      { name: 'Keyboard', id: 'notifications-stack--keyboard' },
    ], boundary: 'Production stack/controller; fixed timers paused; opaque actions stay in the story.',
  },
  {
    name: 'Project session row and actions', sources: ['src/renderer/ProjectSessionRow.tsx', 'src/renderer/SessionActions.tsx'], status: 'included',
    states: 'Short/long/fallback, selected, pinned, running, worktree, combined, narrow, disabled pending actions, hover, keyboard focus, scroll/reset, resize, local Pin/Archive/Undo.',
    notApplicable: 'Rows do not own loading/error/success banners or empty project state. Selection remains enabled during an action.',
    stories: [
      { name: 'State sheet', id: 'sessions-project-row--state-sheet' },
      { name: 'Hover', id: 'sessions-project-row--hover' },
      { name: 'Keyboard', id: 'sessions-project-row--keyboard-focus' },
      { name: 'Live interactions', id: 'sessions-project-row--playground' },
    ], boundary: 'Production row/actions, fictional data/callbacks; Git detection remains main-process coverage.',
  },
  { name: 'Notification access', sources: ['src/renderer/NotificationAccess.tsx'], status: 'planned', states: 'Hidden/visible count, keyboard access, dialog placement.', boundary: 'Needs an isolated transport adapter for native focus intent.' },
  { name: 'Workspace menu', sources: ['src/renderer/WorkspaceMenu.tsx'], status: 'planned', states: 'Closed/open, submenu, disabled, edge position, keyboard navigation/escape.', boundary: 'Pure local callbacks; menu focus ownership.' },
  { name: 'Split workspace', sources: ['src/renderer/WorkspaceSplit.tsx'], status: 'planned', states: 'Single/nested panes, horizontal/vertical, selected, resize pointer/keyboard/cancel.', boundary: 'Local pane fixtures and ratio callbacks.' },
  { name: 'Sidebar resizer', sources: ['src/renderer/SidebarResizer.tsx'], status: 'planned', states: 'Idle/drag, minimum/maximum, double-click reset, keyboard/cancel.', boundary: 'Local width state; no saved application settings.' },
  { name: 'Project dashboard', sources: ['src/renderer/ProjectDashboard.tsx'], status: 'planned', states: 'Empty/populated, missing directory, busy, archived/draft/published/private changes, long titles.', boundary: 'Project/plan/session/terminal inventory with local callbacks.' },
  { name: 'Comment composer', sources: ['src/renderer/CommentComposer.tsx'], status: 'planned', states: 'Empty/draft/editing, long multiline, save/cancel/delete, pending/disabled, rejected write, focus.', boundary: 'Controlled values and disposable async callback fixtures.' },
  { name: 'Application settings', sources: ['src/renderer/ApplicationSettings.tsx'], status: 'planned', states: 'Sections/search, dirty, validation, saving/error, compatibility, shortcut capture/conflict, pending write, keyboard.', boundary: 'Explicit settings and harness props; requires isolated notification adapter.' },
  { name: 'Guide dialog', sources: ['src/renderer/GuideViewer.tsx'], status: 'planned', states: 'Loading/loaded/error, topic/reference, long source, keyboard/focus trap/close.', boundary: 'Fictional offline load callback; never read the operator filesystem.' },
  { name: 'Icons', sources: ['src/renderer/Icon.tsx'], status: 'planned', states: 'All supported glyphs, sizes, inherited color, decorative accessibility.', boundary: 'Production icon set.' },
  { name: 'Plan/browser/home workspace panes', sources: ['src/renderer/PlanWorkspacePane.tsx'], status: 'native', states: 'Home/empty, plan current/history/unavailable, loading/compile failure, browser loading/navigation, selected tabs.', boundary: 'Home can become an isolated story; document protocol iframe and native browser attachment need explicit seams and Electron checks.' },
  { name: 'Terminal pane', sources: ['src/renderer/TerminalPane.tsx'], status: 'native', states: 'Starting/running/stopped/error, replay, resize, overflow, focused/inactive, drop, selection.', boundary: 'Actual xterm can be catalogued with an input-only bridge; PTY/clipboard/IME remain separate. Do not start a real shell.' },
  { name: 'Application and document surfaces', sources: ['src/renderer/main.tsx'], status: 'native', states: 'Project tree/tabs/panels, empty/disconnected, restored workspaces, widgets, disclosure, diagrams, private annotations/comments, approval/history/compile states.', boundary: 'Bootstrap owns bridge and state orchestration. Extract only demonstrated seams; browser stories must not import the live bootstrap.' },
  { name: 'Native notification host', sources: ['src/renderer/notifications-view.tsx'], status: 'native', states: 'Cold child, hidden/minimized/moved/resized/retired, rounded-corner/gap routing, explicit focus.', boundary: 'Dedicated private Electron preload/window; existing E2E/native smoke, not a HTML imitation.' },
];
