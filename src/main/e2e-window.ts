import type { App, BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { appendFileSync } from 'node:fs';

// Set by Playwright, never by the application's normal launch commands.
export function isBackgroundE2E(): boolean {
  return process.env.PROJECTOR_E2E_BACKGROUND === '1';
}

export function e2eWindowOptions(
  options: BrowserWindowConstructorOptions,
  background = isBackgroundE2E(),
): BrowserWindowConstructorOptions {
  if (!background) return options;
  return {
    ...options,
    show: false,
    focusable: false,
    webPreferences: { ...options.webPreferences, backgroundThrottling: false },
  };
}

export function showBackgroundE2EWindow(win: BrowserWindow): void {
  if (!isBackgroundE2E()) return;
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.setAlwaysOnTop(true, 'normal', -1);
    win.showInactive();
  });
}

// Observe native events from before window creation, including packaged launches.
// Record display separately from activation and focus violations.
export function auditE2EWindows(app: App): void {
  const path = process.env.PROJECTOR_E2E_WINDOW_AUDIT;
  if (!isBackgroundE2E() || !path) return;
  const record = (event: string, windowId?: number) =>
    appendFileSync(path, JSON.stringify({ event, windowId, pid: process.pid }) + '\n');
  app.on('did-become-active', () => record('app-active'));
  app.on('browser-window-focus', (_event, window) => record('window-focus', window.id));
  app.on('browser-window-created', (_event, window) => {
    record('window-created', window.id);
    window.on('show', () => record('window-show', window.id));
    window.on('focus', () => record('focus', window.id));
  });
}
