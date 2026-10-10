import type { App, BrowserWindowConstructorOptions } from 'electron';
import { appendFileSync } from 'node:fs';

// Set by Playwright, never by the application's normal launch commands.
export function isBackgroundE2E(): boolean {
  return process.env.BLUEPRINT_E2E_BACKGROUND === '1';
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

// Observe native events from before window creation, including packaged launches.
// Recording a violation must not turn it into a passing test by hiding the window.
export function auditE2EWindows(app: App): void {
  const path = process.env.BLUEPRINT_E2E_WINDOW_AUDIT;
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
