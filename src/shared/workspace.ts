export type WorkspaceTab =
  | { id: string; kind: 'document'; revisionId: string | null }
  | { id: string; kind: 'home'; address: string }
  | { id: string; kind: 'browser'; url: string; title: string; nativeId?: string };
export interface PlanWorkspace {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  lastDocumentRevisionId?: string | null;
}
export interface WorkspaceLayout {
  leftSidebarWidth?: number;
  rightSidebarWidth?: number;
  leftSidebarVisible: boolean;
  rightSidebarVisible: boolean;
}
export interface WorkspaceSnapshot {
  layout: WorkspaceLayout;
  plans: Record<string, PlanWorkspace>;
}
