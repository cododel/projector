import { useNotifyError } from './NotificationContext';
import { NotificationAccess } from './NotificationAccess';
import { Icon } from './Icon';
import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SHORTCUTS,
  type ApplicationSettings as Settings,
  type ShortcutAction,
} from '../shared/application-workspace';
import type { HarnessSnapshot } from '../shared/harness';
import { shortcutForEvent } from './shortcuts';

const shortcutLabels: Record<ShortcutAction, string> = {
  newTab: 'New tab',
  closeTab: 'Close view',
  nextTab: 'Next tab',
  previousTab: 'Previous tab',
  splitRight: 'Split right',
  splitDown: 'Split down',
  nextPane: 'Next panel',
  previousPane: 'Previous panel',
  bottomPanel: 'Project terminals',
  settings: 'Settings',
};
export function ApplicationSettings({
  settings,
  harnesses,
  onSave,
  onCheck,
  onShortcutCapture,
  metadataPending,
  onReviewPendingWrite,
  onClose,
}: {
  settings: Settings;
  harnesses: HarnessSnapshot;
  onSave(settings: Settings): Promise<void>;
  onCheck(): Promise<void>;
  onShortcutCapture(active: boolean): void;
  metadataPending: boolean;
  onReviewPendingWrite(): void;
  onClose(): void;
}): React.JSX.Element {
  const notifyError = useNotifyError();
  const [section, setSection] = useState('General');
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [shellArgs, setShellArgs] = useState(() => JSON.stringify(settings.shellArgs));
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const initialFocus = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    initialFocus.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    onShortcutCapture(Boolean(recording));
    return () => onShortcutCapture(false);
  }, [recording, onShortcutCapture]);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(settings) ||
    shellArgs !== JSON.stringify(settings.shellArgs);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Tab' &&
        !event.isComposing &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        const controls = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ) ?? []),
        ].filter((element) => element.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (!first || !last) return;
        const active = document.activeElement;
        if (
          !dialog.current?.contains(active) ||
          (event.shiftKey ? active === first : active === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
        return;
      }
      if (event.key !== 'Escape' || event.isComposing) return;
      event.stopPropagation();
      if (recording) setRecording(null);
      else if (!busy && !dirty) onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [busy, dirty, recording, onClose]);
  const field = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const row = (title: string, description: string, control: React.ReactNode, key?: string) => (
    <div className="settings-row" key={key}>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {control}
    </div>
  );
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !dirty && !busy) onClose();
      }}
    >
      <section
        ref={dialog}
        className="application-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <nav aria-label="Settings sections">
          <h2 id="settings-title">Settings</h2>
          {['General', 'Terminal', 'Harnesses', 'Keyboard shortcuts'].map((name) => (
            <button
              ref={name === 'General' ? initialFocus : undefined}
              key={name}
              className={section === name ? 'active' : ''}
              onClick={() => setSection(name)}
            >
              {name}
            </button>
          ))}
        </nav>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setError('');
            let args: unknown;
            try {
              args = JSON.parse(shellArgs);
            } catch {
              setError('Shell arguments must be a JSON array of strings.');
              return;
            }
            if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
              setError('Shell arguments must be a JSON array of strings.');
              return;
            }
            setBusy(true);
            void onSave({ ...draft, shellArgs: args })
              .then(onClose)
              .catch((error) => { notifyError(error, 'settings', JSON.stringify(draft)); })
              .finally(() => setBusy(false));
          }}
        >
          <header>
            <h2>{section}</h2>
            <NotificationAccess />
            <button type="button" onClick={onClose} disabled={busy} aria-label="Close settings">
              <Icon name="close" />
            </button>
          </header>
          <div className="settings-content">
            {section === 'General' && (
              <>
                {row(
                  'Open plans',
                  'Reuse the open document in this workspace.',
                  <select
                    aria-label="Plan placement"
                    value={draft.planPlacement}
                    onChange={(event) =>
                      field('planPlacement', event.target.value === 'tab' ? 'tab' : 'beside')
                    }
                  >
                    <option value="beside">Beside active terminal</option>
                    <option value="tab">New tab</option>
                  </select>,
                )}
                {row(
                  'Restore workspace',
                  'Restore layout and saved screens. Commands and agents start only when you ask.',
                  <input
                    aria-label="Restore workspace"
                    type="checkbox"
                    checked={draft.restoreWorkspace}
                    onChange={(event) => field('restoreWorkspace', event.target.checked)}
                  />,
                )}
              </>
            )}
            {section === 'Terminal' && (
              <>
                {row(
                  'Shell',
                  'Leave empty to use your system shell. Applies to newly started shells.',
                  <input
                    aria-label="Shell executable"
                    value={draft.shell}
                    placeholder="System default"
                    onChange={(event) => field('shell', event.target.value)}
                  />,
                )}
                {row(
                  'Shell arguments',
                  'JSON array; existing processes keep their launch arguments.',
                  <input
                    aria-label="Shell arguments"
                    value={shellArgs}
                    onChange={(event) => setShellArgs(event.target.value)}
                  />,
                )}
                {row(
                  'Font',
                  'Terminal text font family.',
                  <input
                    aria-label="Terminal font"
                    value={draft.terminalFont}
                    onChange={(event) => field('terminalFont', event.target.value)}
                  />,
                )}
                {row(
                  'Text size',
                  '8–36 pixels.',
                  <input
                    aria-label="Terminal font size"
                    type="number"
                    min={8}
                    max={36}
                    value={draft.terminalFontSize}
                    onChange={(event) => field('terminalFontSize', Number(event.target.value))}
                  />,
                )}
                {row(
                  'Saved output',
                  '100–50,000 lines per terminal. Earlier output is marked when truncated.',
                  <input
                    aria-label="Terminal scrollback"
                    type="number"
                    min={100}
                    max={50000}
                    value={draft.terminalScrollback}
                    onChange={(event) => field('terminalScrollback', Number(event.target.value))}
                  />,
                )}
              </>
            )}
            {section === 'Harnesses' && (
              <>
                {row(
                  'Codex executable',
                  'Projector changes launch parameters only; your Codex policies and login stay intact.',
                  <input
                    aria-label="Codex executable"
                    value={draft.codexExecutable}
                    onChange={(event) => field('codexExecutable', event.target.value)}
                  />,
                )}
                {row(
                  'Codex profile',
                  'An existing named profile; empty uses your default profile.',
                  <input
                    aria-label="Codex profile"
                    value={draft.codexProfile}
                    onChange={(event) => field('codexProfile', event.target.value)}
                  />,
                )}
                <p className="muted">
                  {harnesses.compatibility
                    ? `${harnesses.compatibility.version ?? 'Version unavailable'} · ${harnesses.compatibility.qualified ? 'Protocol qualified' : 'Not qualified'}`
                    : 'Compatibility has not been checked.'}
                </p>
                {harnesses.compatibility?.error && (
                  <p role="alert">{harnesses.compatibility.error}</p>
                )}
                <p className="muted">
                  MCP startup status is observed from Projector-owned Codex backends. Startup ready
                  does not prove that a connection remains healthy or that an agent read a saved
                  state.
                </p>
                {harnesses.mcpStartup.length ? (
                  <ul aria-label="Projector MCP startup status">
                    {harnesses.mcpStartup.map((connection) => (
                      <li key={connection.launchId}>
                        <strong>{connection.sessionId ?? 'New session'}</strong>
                        <span> · MCP startup: {connection.status}</span>
                        {connection.error && <p role="alert">{connection.error}</p>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">
                    No owned MCP connection has been observed. External client status is unknown.
                  </p>
                )}
                <button
                  type="button"
                  disabled={busy || dirty}
                  onClick={() => {
                    setBusy(true);
                    void onCheck()
                      .catch((error) => { notifyError(error, 'settings', JSON.stringify(draft)); })
                      .finally(() => setBusy(false));
                  }}
                >
                  Check installed Codex
                </button>
                {dirty && <small>Save settings before checking a new executable or profile.</small>}
              </>
            )}
            {section === 'Keyboard shortcuts' && (
              <>
                <input
                  aria-label="Search shortcuts"
                  placeholder="Search shortcuts"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {(Object.entries(shortcutLabels) as [ShortcutAction, string][])
                  .filter(([, name]) => name.toLowerCase().includes(search.toLowerCase()))
                  .map(([action, name]) =>
                    row(
                      name,
                      'Text shortcuts require Command or Control. Normal terminal input and IME are preserved.',
                      <div className="shortcut-controls" key={action}>
                        <button
                          type="button"
                          aria-label={`Shortcut for ${name}: ${recording === action ? 'Press combination…' : (draft.shortcuts[action] ?? 'Unassigned')}`}
                          onClick={() => setRecording(action)}
                          onBlur={() =>
                            setRecording((current) => (current === action ? null : current))
                          }
                          onKeyDown={(event) => {
                            if (recording !== action || event.nativeEvent.isComposing) return;
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              event.stopPropagation();
                              setRecording(null);
                              return;
                            }
                            const shortcut = shortcutForEvent(event.nativeEvent);
                            if (!shortcut) return;
                            event.preventDefault();
                            event.stopPropagation();
                            field('shortcuts', { ...draft.shortcuts, [action]: shortcut });
                            setRecording(null);
                          }}
                        >
                          {recording === action
                            ? 'Press combination…'
                            : (draft.shortcuts[action] ?? 'Unassigned')}
                        </button>
                        <button
                          type="button"
                          aria-label={`Disable ${name} shortcut`}
                          onClick={() => field('shortcuts', { ...draft.shortcuts, [action]: null })}
                        >
                          Disable
                        </button>
                        <button
                          type="button"
                          aria-label={`Reset ${name} shortcut`}
                          onClick={() =>
                            field('shortcuts', {
                              ...draft.shortcuts,
                              [action]: DEFAULT_SHORTCUTS[action],
                            })
                          }
                        >
                          Reset
                        </button>
                      </div>,
                      action,
                    ),
                  )}
              </>
            )}
          </div>
          {error && (
            <p role="alert" className="error-banner">
              {error}
            </p>
          )}
          <footer>
            <small>{dirty ? 'Unsaved changes' : 'Settings are saved locally'}</small>
            {metadataPending && <button type="button" onClick={onReviewPendingWrite}>Review pending write</button>}
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="primary" disabled={busy || !dirty || metadataPending}>
              Save
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
