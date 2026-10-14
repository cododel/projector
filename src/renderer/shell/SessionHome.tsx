import React from 'react';
import type { HarnessSession } from '../../shared/harness';
type Session = Pick<HarnessSession, 'id' | 'title' | 'cwd' | 'processState' | 'terminalId'>;
export function SessionHome({
  session,
  busy,
  onCopy,
  onOpenTerminal,
  onResume,
}: {
  session: Session;
  busy: boolean;
  onCopy: (value: string) => void;
  onOpenTerminal: () => void;
  onResume: () => void;
}) {
  return (
    <div className="session-home new-tab-home">
      <h2>{session.title || 'Codex session'}</h2>
      <p className="muted session-summary">
        {session.processState === 'unknown'
          ? 'Session from history · external process state unknown'
          : `Process: ${session.processState}`}
      </p>
      <details className="session-details">
        <summary>Details</summary>
        <dl>
          <dt>Session ID</dt>
          <dd>{session.id}</dd>
          <dt>Working folder</dt>
          <dd>{session.cwd}</dd>
          <dt>Process</dt>
          <dd>
            {session.processState === 'unknown'
              ? 'Unknown · this session was discovered from history'
              : session.processState}
          </dd>
        </dl>
        <button onClick={() => onCopy(session.id)}>Copy session ID</button>
        <button onClick={() => onCopy(session.cwd)}>Copy working folder</button>
      </details>
      {session.processState === 'running' && session.terminalId ? (
        <button className="primary" onClick={onOpenTerminal}>
          Open terminal
        </button>
      ) : (
        <>
          <button className="primary" disabled={busy} onClick={onResume}>
            Resume
          </button>
        </>
      )}
    </div>
  );
}
export function SessionUnavailable({ busy, onStart }: { busy: boolean; onStart: () => void }) {
  return (
    <div className="session-home new-tab-home">
      <h2>Session unavailable</h2>
      <p className="muted">This session is no longer available in Codex.</p>
      <button className="primary" disabled={busy} onClick={onStart}>
        Start new session
      </button>
    </div>
  );
}
