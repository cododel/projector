import React from 'react';
import type { HarnessSession } from '../../shared/harness';
export function Handoff({
  sessions,
  projectId,
  handoffSessionId,
  copied,
  onSelect,
  onCopy,
}: {
  sessions: HarnessSession[];
  projectId?: string;
  handoffSessionId: string;
  copied: boolean;
  onSelect: (id: string) => void;
  onCopy: () => void;
}) {
  return (
    <div className="notification">
      <label className="handoff-session-label">
        Target session
        <select
          aria-label="Target Codex session"
          value={handoffSessionId}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">Copy only</option>
          {sessions
            .filter((session) => session.projectId === projectId)
            .map((session) => (
              <option
                key={session.id}
                value={session.id}
                disabled={!session.terminalId || session.processState !== 'running'}
              >
                {session.title || session.id}
                {session.terminalId && session.processState === 'running' ? '' : ' · Resume first'}
              </option>
            ))}
        </select>
      </label>
      <button className="secondary full" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy update message'}
      </button>
      <small>Saved · notify your agent manually</small>
    </div>
  );
}
