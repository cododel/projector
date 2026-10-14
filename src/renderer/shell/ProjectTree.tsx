import React from 'react';
import { Icon } from '../Icon';
import { ProjectSessionRow } from '../ProjectSessionRow';
import type { HarnessSession } from '../../shared/harness';
export interface TreeProject {
  id: string;
  path: string;
  available?: boolean;
}
export interface ProjectTreeProps {
  projects: TreeProject[];
  sessions: HarnessSession[];
  projectId: string | null | undefined;
  activeProjectId?: string;
  activeSessionId?: string | null;
  collapsed: Set<string>;
  pinnedSessions: string[];
  busy: boolean;
  otherSessionsOpen?: boolean;
  onCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
  pinOrder: (a: HarnessSession, b: HarnessSession) => number;
  sessionActions: (session: HarnessSession) => React.ReactNode;
  onProjectMenu: (project: TreeProject) => void;
  onProject: (project: TreeProject) => void;
  onNewSession: (project: TreeProject) => void;
  onSession: (projectId: string, sessionId: string) => void;
  onMetadata: (session: HarnessSession) => void;
  onChooseProject: () => void;
}
export function ProjectTree({
  projects,
  sessions,
  projectId,
  activeProjectId,
  activeSessionId,
  collapsed,
  pinnedSessions,
  busy,
  otherSessionsOpen,
  onCollapsed,
  pinOrder,
  sessionActions,
  onProjectMenu,
  onProject,
  onNewSession,
  onSession,
  onMetadata,
  onChooseProject,
}: ProjectTreeProps) {
  return (
    <div className="project-tree">
      <div className="tree-heading">Projects</div>
      {projects.map((item) => (
        <section key={item.id}>
          <div
            className="project-row"
            onContextMenu={(event) => {
              event.preventDefault();
              onProjectMenu(item);
            }}
          >
            <button
              className="project-toggle"
              aria-label={`${collapsed.has(item.id) ? 'Expand' : 'Collapse'} sessions in ${item.path.split('/').at(-1)}`}
              aria-expanded={!collapsed.has(item.id)}
              onClick={() =>
                onCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                })
              }
            >
              <Icon name={collapsed.has(item.id) ? 'right' : 'down'} />
            </button>
            <button
              className={`project-name ${item.id === projectId ? 'current' : ''}`}
              title={item.path}
              disabled={busy}
              aria-label={`Open project ${item.path.split('/').at(-1)}`}
              onClick={() => onProject(item)}
            >
              {item.path.split('/').filter(Boolean).at(-1)}
            </button>
            <div className="project-row-actions">
              <button
                aria-label={`Project actions for ${item.path.split('/').at(-1)}`}
                title="Project actions"
                disabled={busy}
                onClick={() => onProjectMenu(item)}
              >
                <Icon name="more" />
              </button>
              <button
                aria-label={`New Codex session in ${item.path.split('/').at(-1)}`}
                title="New Codex session"
                disabled={busy || item.available === false}
                onClick={() => onNewSession(item)}
              >
                <Icon name="plus" />
              </button>
            </div>
          </div>
          {item.available === false && !collapsed.has(item.id) && (
            <small className="project-unavailable">Folder unavailable</small>
          )}
          {!collapsed.has(item.id) && (
            <div className="project-sessions">
              {sessions
                .filter((session) => session.projectId === item.id)
                .sort(pinOrder)
                .map((session) => (
                  <ProjectSessionRow
                    key={session.id}
                    session={session}
                    active={activeSessionId === session.id && activeProjectId === item.id}
                    pinned={pinnedSessions.includes(session.id)}
                    actions={sessionActions(session)}
                    onSelect={() => onSession(item.id, session.id)}
                  />
                ))}
              {!sessions.some((session) => session.projectId === item.id) && (
                <small className="tree-empty">No sessions to display</small>
              )}
            </div>
          )}
        </section>
      ))}
      {(sessions.filter((session) => session.projectId === null).length ?? 0) > 0 && (
        <details className="other-sessions" open={otherSessionsOpen}>
          <summary>Other sessions</summary>
          {sessions
            .filter((session) => session.projectId === null)
            .sort(pinOrder)
            .map((session) => (
              <div key={session.id}>
                <div className="other-session-heading">
                  <strong>{session.title || 'Codex session'}</strong>
                  {sessionActions(session)}
                </div>
                <small title={session.cwd}>{session.cwd}</small>
                <small>Process state unknown · open its project folder to resume.</small>
                <button onClick={() => onMetadata(session)}>Read metadata</button>
              </div>
            ))}
        </details>
      )}
      <button className="subtle full" disabled={busy} onClick={onChooseProject}>
        + Open project folder
      </button>
    </div>
  );
}
