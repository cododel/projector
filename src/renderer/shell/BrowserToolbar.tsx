import React from 'react';
import { Icon } from '../Icon';
export interface BrowserToolbarProps {
  activeBrowser: {
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    zoomFactor: number;
  };
  url: string;
  annotating: boolean;
  onAddress: (value: string) => void;
  onCommand: (
    action: 'back' | 'forward' | 'stop' | 'reload' | 'navigate' | 'zoom' | 'external' | 'annotate',
    params?: { url?: string; zoomFactor?: number },
  ) => void;
}
export function BrowserToolbar({
  activeBrowser,
  url,
  annotating,
  onAddress,
  onCommand,
}: BrowserToolbarProps) {
  return (
    <div className="browser-toolbar">
      <button
        aria-label="Back"
        disabled={!activeBrowser.canGoBack}
        onClick={() => onCommand('back')}
      >
        <Icon name="back" />
      </button>
      <button
        aria-label="Forward"
        disabled={!activeBrowser.canGoForward}
        onClick={() => onCommand('forward')}
      >
        <Icon name="forward" />
      </button>
      <button
        aria-label={activeBrowser.loading ? 'Stop' : 'Reload'}
        onClick={() => onCommand(activeBrowser.loading ? 'stop' : 'reload')}
      >
        <Icon name={activeBrowser.loading ? 'stop' : 'refresh'} />
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onCommand('navigate', { url });
        }}
      >
        <input
          aria-label="Browser address"
          value={url}
          onChange={(e) => onAddress(e.target.value)}
        />
      </form>
      <select
        aria-label="Browser zoom"
        title="Browser zoom · select 100% to reset"
        value={activeBrowser.zoomFactor ?? 1}
        onChange={(event) => onCommand('zoom', { zoomFactor: Number(event.currentTarget.value) })}
      >
        {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((factor) => (
          <option key={factor} value={factor}>
            {Math.round(factor * 100) + '%'}
          </option>
        ))}
      </select>
      <button
        aria-label="Open page in external browser"
        title="Open externally · sign-in remains in that browser"
        onClick={() => onCommand('external')}
      >
        <Icon name="external" />
      </button>

      <button
        className={annotating ? 'active' : ''}
        aria-label="Annotate browser"
        aria-pressed={annotating}
        onClick={() => onCommand('annotate')}
      >
        Annotate
      </button>
    </div>
  );
}
