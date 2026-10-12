import React from 'react';
import { Icon } from './Icon';
import type { HarnessSession } from '../shared/harness';
import type { TerminalRecord } from '../shared/terminal';

interface Plan {
  id: string;
  title: string;
  projectId: string;
  latestRevision: string | null;
  originSession: { harness: string; sessionId: string } | null;
  archived?: boolean;
  displayStatus?: string;
  privateChanges?: boolean;
}
interface Props {
  project?: { id: string; path: string; available?: boolean };
  plans: Plan[];
  sessions: HarnessSession[];
  terminals: TerminalRecord[];
  busy: boolean;
  showArchived: boolean;
  onShowArchived(value: boolean): void;
  onOpenPlan(plan: Plan): void;
  onPlanMenu(plan: Plan): void;
  onArchive(plan: Plan): void;
  onSession(session: HarnessSession): void;
  onTerminal(terminal: TerminalRecord): void;
  onNewTerminal(): void;
  onWorkspace(): void;
}
/** Project inventory; opening a view never changes artifact ownership or stops a process. */
export function ProjectDashboard(props: Props) {
  const visiblePlans = props.plans.filter((plan) => props.showArchived || !plan.archived);
  return (
    <div className="project-dashboard">
      <header>
        <h1>{props.project?.path.split('/').at(-1)}</h1>
        <p>{props.project?.path}</p>
      </header>
      <section aria-label="Project plans">
        <div className="dashboard-section-heading">
          <h2>Plans</h2>
          <label>
            <input
              type="checkbox"
              checked={props.showArchived}
              onChange={(event) => props.onShowArchived(event.target.checked)}
            />{' '}
            Show archived plans
          </label>
        </div>
        {!visiblePlans.length && <p>No plans yet</p>}
        {visiblePlans.map((plan) => (
          <div
            className="plan-row"
            key={plan.id}
            onContextMenu={(event) => {
              event.preventDefault();
              props.onPlanMenu(plan);
            }}
          >
            <button
              className="plan-title"
              disabled={props.busy || props.project?.available === false}
              title={plan.title}
              onClick={() => props.onOpenPlan(plan)}
            >
              {plan.title}
            </button>
            <small>{plan.archived ? 'Archived' : (plan.displayStatus ?? 'Draft')}</small>
            {plan.privateChanges && <span className="private-dot" aria-label="Private changes" />}
            <button
              aria-label={`${plan.archived ? 'Restore' : 'Archive'} plan ${plan.title}`}
              disabled={props.busy || props.project?.available === false}
              onClick={() => props.onArchive(plan)}
            >
              {plan.archived ? 'Restore' : 'Archive'}
            </button>
            <button
              aria-label={`Plan actions for ${plan.title}`}
              disabled={props.busy || props.project?.available === false}
              onClick={() => props.onPlanMenu(plan)}
            >
              <Icon name="more" />
            </button>
          </div>
        ))}
        <p className="dashboard-hint">Plans are created by agents through Blueprint MCP.</p>
      </section>
      <section aria-label="Project sessions">
        <h2>Sessions</h2>
        {!props.sessions.length && <p className="dashboard-hint">No sessions to display</p>}
        {props.sessions.map((session) => (
          <button
            aria-label={`Open session ${session.title || 'Codex session'}`}
            key={session.id}
            disabled={props.busy}
            onClick={() => props.onSession(session)}
          >
            {session.title || 'Codex session'}
          </button>
        ))}
      </section>
      <section aria-label="Project terminals">
        <h2>Terminals</h2>
        <button
          disabled={props.busy || props.project?.available === false}
          onClick={props.onNewTerminal}
        >
          New project terminal
        </button>
        {props.terminals.map((record) => (
          <button key={record.id} disabled={props.busy} onClick={() => props.onTerminal(record)}>
            {record.title} · {record.status}
            {record.harnessSessionId ? ' · session' : ''}
          </button>
        ))}
      </section>
      <button disabled={props.busy} onClick={props.onWorkspace}>
        Open project workspace
      </button>
    </div>
  );
}
