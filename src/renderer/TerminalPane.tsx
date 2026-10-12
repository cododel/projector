import { terminalWheelController } from './terminal-wheel-controller';
import { terminalFilePaths } from './terminal-drop';
import { Icon } from './Icon';
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
  getPathForFile?(file: File): string;
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
  onActivateForDrop,
}: {
  record: TerminalRecord;
  viewId: string;
  active: boolean;
  settings: ApplicationSettings;
  bridge: TerminalBridge;
  onFocus(): void;
  onChange(): void;
  onResume?(): void;
  onActivateForDrop?(): Promise<boolean>;
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const inputReady = useRef(false);
  const pendingInput = useRef('');
  const pendingDrop = useRef<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const resizeSequence = useRef(0);
  const wheelReset = useRef<() => void>(() => {});
  const flushInput = useRef<() => void>(() => {});
  const focusAfterResize = useRef(false);
  const initializedRef = useRef(false);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  activeRef.current = active;
  const running = record.status === 'running';
  const runningRef = useRef(running);
  runningRef.current = running;
  function acknowledgeInput(): void {
    if (pendingDrop.current && activeRef.current && inputReady.current && runningRef.current) {
      const text = pendingDrop.current;
      pendingDrop.current = null;
      terminalRef.current?.paste(text);
    }
    flushInput.current();
    if (focusAfterResize.current && activeRef.current) {
      focusAfterResize.current = false;
      terminalRef.current?.focus();
    }
  }

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
    let batchingWheel = false;
    const wheel = terminalWheelController(terminal, {
      ready: () =>
        !disposed &&
        initializedRef.current &&
        activeRef.current &&
        runningRef.current &&
        inputReady.current,
      batch: (action) => {
        batchingWheel = true;
        try {
          action();
        } finally {
          batchingWheel = false;
          flushInput.current();
        }
      },
    });
    wheelReset.current = wheel.reset;
    const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
    const reader = new TerminalOutputReader({
      screen: async () =>
        (await bridge.invoke('terminalScreen', { id: record.id })) as TerminalScreen,
      replay: async (afterSeq) =>
        (await bridge.invoke('terminalReplay', { id: record.id, afterSeq })) as TerminalReplay,
      reset: async (screen) => {
        wheel.reset();
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
      const sequence = ++resizeSequence.current;
      void bridge
        .invoke('terminalResize', {
          id: record.id,
          viewId,
          cols: Math.min(500, terminal.cols),
          rows: Math.min(300, terminal.rows),
          active: activeRef.current,
        })
        .then(() => {
          if (!disposed && sequence === resizeSequence.current) {
            inputReady.current = activeRef.current;
            acknowledgeInput();
          }
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    flushInput.current = () => {
      if (
        disposed ||
        !activeRef.current ||
        !inputReady.current ||
        !runningRef.current ||
        !pendingInput.current
      )
        return;
      const data = pendingInput.current;
      // Clear before sending: an uncertain acknowledgement must never replay keystrokes.
      pendingInput.current = '';
      void bridge.invoke('terminalInput', { id: record.id, viewId, data }).catch((error) => {
        if (!disposed) setError(String(error));
      });
    };
    const input = terminal.onData((data) => {
      if (!activeRef.current || !runningRef.current) return;
      if (new TextEncoder().encode(pendingInput.current + data).byteLength > 65536) {
        setError('Pending terminal input is full. Wait for the terminal before typing more.');
        return;
      }
      pendingInput.current += data;
      if (!batchingWheel) flushInput.current();
    });
    return () => {
      disposed = true;
      resizeSequence.current++;
      pendingInput.current = '';
      pendingDrop.current = null;
      focusAfterResize.current = false;
      flushInput.current = () => {};
      initializedRef.current = false;
      reader.stop();
      inputReady.current = false;
      unsubscribe?.();
      observer.disconnect();
      wheel.dispose();
      wheelReset.current = () => {};
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [record.id, viewId, bridge]);
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    wheelReset.current();
    terminal.options.fontFamily = settings.terminalFont;
    terminal.options.fontSize = settings.terminalFontSize;
    terminal.options.scrollback = settings.terminalScrollback;
    fitRef.current?.fit();
    if (terminal.cols > 500 || terminal.rows > 300)
      terminal.resize(Math.min(500, terminal.cols), Math.min(300, terminal.rows));
    inputReady.current = false;
    const sequence = ++resizeSequence.current;
    focusAfterResize.current = active;
    if (!active || !runningRef.current) {
      if (pendingInput.current)
        setError('Pending input was cancelled when this terminal became inactive.');
      pendingInput.current = '';
      pendingDrop.current = null;
    }
    let disposed = false;
    void bridge
      .invoke('terminalResize', {
        id: record.id,
        viewId,
        cols: Math.min(500, terminal.cols),
        rows: Math.min(300, terminal.rows),
        active,
      })
      .then(() => {
        if (disposed || sequence !== resizeSequence.current) return;
        inputReady.current = initializedRef.current && activeRef.current;
        acknowledgeInput();
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      });
    return () => {
      disposed = true;
    };
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
  const cleanup = !running && Boolean(record.error);
  return (
    <section
      className={`terminal-pane ${active ? 'active' : ''} ${draggingFiles ? 'terminal-file-drop' : ''}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = running ? 'copy' : 'none';
        setDraggingFiles(running);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDraggingFiles(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        setDraggingFiles(false);
        if (!runningRef.current || pendingDrop.current) return;
        const terminal = terminalRef.current;
        try {
          if (!bridge.getPathForFile) throw new Error('Local file dropping is unavailable.');
          const text = terminalFilePaths(
            Array.from(event.dataTransfer.files, (file) => bridge.getPathForFile!(file)),
          );
          pendingDrop.current = text;
          const activate = onActivateForDrop
            ? onActivateForDrop()
            : Promise.resolve(activeRef.current);
          void activate
            .then((accepted) => {
              if (terminalRef.current !== terminal || !runningRef.current) return;
              if (!accepted) {
                pendingDrop.current = null;
                setError('Select this terminal and drop the files again.');
                return;
              }
              focusAfterResize.current = true;
              acknowledgeInput();
            })
            .catch((failure) => {
              pendingDrop.current = null;
              setError(String(failure));
            });
        } catch (failure) {
          pendingDrop.current = null;
          setError(String(failure));
        }
      }}
      aria-label={record.title}
      onPointerDown={onFocus}
      onFocus={onFocus}
    >
      <div className="terminal-statusbar">
        <span title={record.cwd}>{record.title}</span>
        <small>{running ? 'Running' : cleanup ? 'Cleanup required' : record.status}</small>
        {(truncated || record.truncated) && (
          <small title="Earlier output was removed at the configured limit">Output truncated</small>
        )}
        <button
          disabled={!running && !cleanup && record.kind === 'codex' && !onResume}
          aria-label={
            cleanup
              ? 'Retry terminal cleanup'
              : running
                ? 'Stop terminal'
                : record.kind === 'codex'
                  ? 'Resume Codex session'
                  : 'Restart terminal'
          }
          onClick={() => {
            if (!running && !cleanup && record.kind === 'codex') {
              onResume?.();
              return;
            }
            void bridge
              .invoke(running || cleanup ? 'terminalStop' : 'terminalRestart', { id: record.id })
              .then(onChange)
              .catch((error) => setError(String(error)));
          }}
        >
          {cleanup
            ? 'Retry cleanup'
            : running
              ? 'Stop'
              : record.kind === 'codex'
                ? 'Resume'
                : 'Start shell'}
        </button>
      </div>
      {record.kind === 'codex' && !running && !cleanup && (
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
              <Icon name="close" />
            </button>
          )}
        </div>
      )}
      <div className="xterm-container" ref={container} />
    </section>
  );
}
