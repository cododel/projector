import React from 'react';
import { NotificationAccess } from '../NotificationAccess';
import type { HarnessSession } from '../../shared/harness';
import type { McpSetup } from '../../shared/protocol';
export function RenamePlanDialog({
  title,
  busy,
  error,
  onChange,
  onSave,
  onClose,
}: {
  title: string;
  busy: boolean;
  error: string | null;
  onChange: (title: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <section
        className="modal rename-plan-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Rename plan"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <h2>Rename plan</h2>
          {error && (
            <p role="alert" className="error-banner">
              {error}
            </p>
          )}
          <label htmlFor="plan-name">Plan name</label>
          <NotificationAccess />
          <input
            id="plan-name"
            disabled={busy}
            autoFocus
            value={title}
            onChange={(event) => onChange(event.target.value)}
          />
          <div className="rename-plan-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={busy || !title.trim()}>
              Save
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function SessionMetadataDialog({
  session,
  onClose,
}: {
  session: HarnessSession;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Codex session metadata"
      >
        <div className="modal-heading">
          <h2>{session.title || 'Codex session'}</h2>
          <button onClick={() => onClose()}>Close</button>
        </div>
        <dl>
          <dt>Session ID</dt>
          <dd>{session.id}</dd>
          <dt>Working folder</dt>
          <dd>{session.cwd}</dd>
          <dt>Process</dt>
          <dd>{session.processState === 'unknown' ? 'Unknown' : session.processState}</dd>
        </dl>
        <p className="muted">
          Open this session's project folder in Projector to enable explicit Resume.
        </p>
      </section>
    </div>
  );
}

export function McpConnectionDialog({
  setup,
  copied,
  onCopy,
  onClose,
  promptOpen,
  configurationOpen,
}: {
  promptOpen?: boolean;
  configurationOpen?: boolean;
  setup: McpSetup;
  copied: string | null;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-label="MCP connection">
        <div className="modal-heading">
          <h2>Connect Projector through MCP</h2>
          <button className="subtle" onClick={onClose}>
            Close
          </button>
        </div>
        <p>Copy the setup prompt and paste it into your agent. Keep Projector running.</p>
        <button className="primary" onClick={() => onCopy(setup.prompt)}>
          {copied === setup.prompt ? 'Copied' : 'Copy setup prompt'}
        </button>
        <p className="muted">
          The prompt configures your user-level MCP connection across projects. Keep personal paths
          out of project configuration. You may need to reconnect MCP before tools appear in this
          session.
        </p>
        <details open={promptOpen}>
          <summary>Preview setup prompt</summary>
          <pre>{setup.prompt}</pre>
        </details>
        <details open={configurationOpen}>
          <summary>Connection details and manual configuration</summary>
          <p className="muted">
            {setup.mode === 'packaged'
              ? 'Packaged application — uses the bundled MCP helper and Node runtime.'
              : setup.mode === 'development'
                ? 'Development — uses the source bridge and your Node.js installation.'
                : 'Production build from source — uses the source bridge and your Node.js installation.'}
          </p>
          <p>MCP calls reach this application through an authenticated loopback HTTP runtime.</p>
          <label>Runtime descriptor</label>
          <pre>{setup.descriptorPath}</pre>
          <label>Stdio command</label>
          <pre>{setup.command}</pre>
          <label>Configuration</label>
          <pre>{setup.config}</pre>
          <button className="secondary" onClick={() => onCopy(setup.config)}>
            {copied === setup.config ? 'Copied' : 'Copy configuration'}
          </button>
        </details>
        <p className="muted">
          Projector does not edit your configuration. The prompt asks your agent to configure only
          this MCP connection.
        </p>
      </section>
    </div>
  );
}
