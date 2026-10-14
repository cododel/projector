import React from 'react';
export function WorkspaceUnavailable({ kind }: { kind: 'terminal' | 'plan' | 'project' }) {
  return (
    <div className="new-tab-home">
      {kind === 'terminal'
        ? 'Terminal unavailable'
        : kind === 'plan'
          ? 'Plan unavailable'
          : 'Project folder unavailable'}
    </div>
  );
}
export function NoOpenTabs({
  application = false,
  hasPlan = false,
  onOpen,
  onNew,
}: {
  application?: boolean;
  hasPlan?: boolean;
  onOpen: () => void;
  onNew: () => void;
}) {
  return (
    <div className="new-tab-home">
      <h2>No open tabs</h2>
      {application && (
        <p className="muted">Open a plan from the project overview or start a project terminal.</p>
      )}
      {(!application || hasPlan) && (
        <>
          <button onClick={onOpen}>Open plan</button>
          <button onClick={onNew}>New tab</button>
        </>
      )}
    </div>
  );
}
export function WaitingForAgent({
  copied,
  onCopy,
  onNew,
}: {
  copied: boolean;
  onCopy: () => void;
  onNew: () => void;
}) {
  return (
    <div className="new-tab-home empty-plan-home">
      <h2>Waiting for your agent</h2>
      <p className="muted">
        This plan is ready as a private workspace. Ask your agent to write and publish its first
        document.
      </p>
      <button className="primary" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy message for agent'}
      </button>
      <button onClick={onNew}>New tab</button>
    </div>
  );
}
