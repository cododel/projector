import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalOutputReader } from './terminal-output';
import type { ApplicationSettings } from '../shared/application-workspace';
import type {
  TerminalOutput,
  TerminalRecord,
  TerminalReplay,
  TerminalScreen,
} from '../shared/terminal';

export interface TerminalBridge {
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onTerminalOutput?(callback: (output: TerminalOutput) => void): () => void;
}
export function TerminalPane({
  record,
  viewId,
  active,
  settings,
  bridge,
  onFocus,
  onChange,
  onResume,
}: {
  record: TerminalRecord;
  viewId: string;
  active: boolean;
  settings: ApplicationSettings;
  bridge: TerminalBridge;
  onFocus(): void;
  onChange(): void;
  onResume?(): void;
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const inputReady = useRef(false);
  const initializedRef = useRef(false);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  activeRef.current = active;
  const running = record.status === 'running';
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    if (!container.current) return;
    const terminal = new Terminal({
      fontFamily: settings.terminalFont,
      fontSize: settings.terminalFontSize,
      scrollback: settings.terminalScrollback,
      cursorBlink: true,
      theme: {
        background: '#ffffff',
        foreground: '#263142',
        cursor: '#4a65df',
        selectionBackground: '#cdd7ff',
      },
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    let disposed = false;
    let initialized = false;
    initializedRef.current = false;
    const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
    const reader = new TerminalOutputReader({
      screen: async () =>
        (await bridge.invoke('terminalScreen', { id: record.id })) as TerminalScreen,
      replay: async (afterSeq) =>
        (await bridge.invoke('terminalReplay', { id: record.id, afterSeq })) as TerminalReplay,
      reset: async (screen) => {
        terminal.reset();
        terminal.resize(screen.cols, screen.rows);
        await write(screen.content);
        setTruncated(screen.truncated);
      },
      write,
      error: (error) => {
        if (!disposed) setError(String(error));
      },
    });
    // Subscribe before reading the saved screen; racing output is replayed in sequence.
    const unsubscribe = bridge.onTerminalOutput?.((output) => {
      if (output.id === record.id) reader.push(output);
    });
    void reader
      .start()
      .then(() => {
        if (disposed) return;
        initialized = true;
        initializedRef.current = true;
        resize();
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      });
    const resize = () => {
      if (disposed || !initialized) return;
      fit.fit();
      if (terminal.cols > 500 || terminal.rows > 300)
        terminal.resize(Math.min(500, terminal.cols), Math.min(300, terminal.rows));
      inputReady.current = false;
      void bridge
        .invoke('terminalResize', {
          id: record.id,
          viewId,
          cols: Math.min(500, terminal.cols),
          rows: Math.min(300, terminal.rows),
          active: activeRef.current,
        })
        .then(() => {
          if (!disposed) inputReady.current = activeRef.current;
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    const input = terminal.onData((data) => {
      if (!activeRef.current || !inputReady.current || !runningRef.current) return;
      void bridge
        .invoke('terminalInput', { id: record.id, viewId, data })
        .catch((error) => setError(String(error)));
    });
    return () => {
      disposed = true;
      initializedRef.current = false;
      reader.stop();
      inputReady.current = false;
      unsubscribe?.();
      observer.disconnect();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [record.id, viewId, bridge]);
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = settings.terminalFont;
    terminal.options.fontSize = settings.terminalFontSize;
    terminal.options.scrollback = settings.terminalScrollback;
    fitRef.current?.fit();
    if (terminal.cols > 500 || terminal.rows > 300)
      terminal.resize(Math.min(500, terminal.cols), Math.min(300, terminal.rows));
    inputReady.current = false;
    void bridge
      .invoke('terminalResize', {
        id: record.id,
        viewId,
        cols: Math.min(500, terminal.cols),
        rows: Math.min(300, terminal.rows),
        active,
      })
      .then(() => {
        inputReady.current = initializedRef.current && activeRef.current;
        if (activeRef.current) terminal.focus();
      })
      .catch((error) => setError(String(error)));
  }, [
    active,
    settings.terminalFont,
    settings.terminalFontSize,
    settings.terminalScrollback,
    record.pid,
    record.id,
    viewId,
    bridge,
  ]);
  return (
    <section
      className={`terminal-pane ${active ? 'active' : ''}`}
      aria-label={record.title}
      onPointerDown={onFocus}
      onFocus={onFocus}
    >
      <div className="terminal-statusbar">
        <span title={record.cwd}>{record.title}</span>
        <small>{running ? 'Running' : 'Saved screen · ' + record.status}</small>
        {(truncated || record.truncated) && (
          <small title="Earlier output was removed at the configured limit">Output truncated</small>
        )}
        <button
          disabled={!running && record.kind === 'codex' && !onResume}
          aria-label={
            running
              ? 'Stop terminal'
              : record.kind === 'codex'
                ? 'Resume Codex session'
                : 'Restart terminal'
          }
          onClick={() => {
            if (!running && record.kind === 'codex') {
              onResume?.();
              return;
            }
            void bridge
              .invoke(running ? 'terminalStop' : 'terminalRestart', { id: record.id })
              .then(onChange)
              .catch((error) => setError(String(error)));
          }}
        >
          {running ? 'Stop' : record.kind === 'codex' ? 'Resume' : 'Start shell'}
        </button>
      </div>
      {record.kind === 'codex' && !running && (
        <p className="terminal-inactive-note">
          This is a saved screen. Resume starts Codex only by the recorded exact session ID.
        </p>
      )}
      {(error || record.error) && (
        <div className="error-banner" role="alert">
          {record.error}
          {error && <span>{error}</span>}
          {error && (
            <button aria-label="Dismiss terminal input error" onClick={() => setError('')}>
              ×
            </button>
          )}
        </div>
      )}
      <div className="xterm-container" ref={container} />
    </section>
  );
}
