import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { TerminalOutput } from '../shared/terminal';
import type { ShortcutAction } from '../shared/application-workspace';
import type { Notification, NotificationCommand } from '../shared/notifications';
const terminalListeners = new Set<(output: TerminalOutput) => void>();
let shuttingDown = false;
const shutdownListeners = new Set<() => void>();
function shutdownError() {
  return Object.assign(new Error('Projector is shutting down.'), { code: 'SHUTTING_DOWN' });
}
function beginShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const callback of shutdownListeners) callback();
}
ipcRenderer.on('projector:shutdown', beginShutdown);
ipcRenderer.on('projector:terminal-output', (_event, delivery: { deliveryId: string; output: TerminalOutput }) => {
  try {
    for (const callback of terminalListeners) {
      try { callback(delivery.output); } catch { /* One disposed view cannot block other consumers. */ }
    }
  } finally { ipcRenderer.send('projector:terminal-output-ack', delivery.deliveryId); }
});
contextBridge.exposeInMainWorld('projector', {
  notifications: {
    publish: (notifications: Notification[]) => shuttingDown ? Promise.resolve() : ipcRenderer.invoke('projector:notifications-publish', notifications),
    focus: () => { if (!shuttingDown) ipcRenderer.send('projector:notifications-focus'); },
    onCommand: (callback: (command: NotificationCommand) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: NotificationCommand) => { if (!shuttingDown) callback(command); };
      ipcRenderer.on('projector:notification-action', listener);
      return () => ipcRenderer.removeListener('projector:notification-action', listener);
    },
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  invoke: async (method: string, params: unknown = {}) => {
    if (shuttingDown) throw shutdownError();
    const result: unknown = await ipcRenderer.invoke('projector:invoke', method, params);
    if (result && typeof result === 'object' &&
      '__projectorLifecycle' in result && result.__projectorLifecycle === 'shutdown' &&
      'code' in result && result.code === 'SHUTTING_DOWN') {
      beginShutdown();
      throw shutdownError();
    }
    return result;
  },
  isShuttingDown: () => shuttingDown,
  onShutdown: (callback: () => void) => {
    shutdownListeners.add(callback);
    if (shuttingDown) callback();
    return () => shutdownListeners.delete(callback);
  },
  onOperationStatus: (callback: (status: { waiting: boolean; operationId: string; operation: string; error?: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: { waiting: boolean; operationId: string; operation: string; error?: string },
    ) => callback(status);
    ipcRenderer.on('projector:operation-status', listener);
    return () => ipcRenderer.removeListener('projector:operation-status', listener);
  },
  onRefresh: (callback: () => void) => {
    const listener = () => { if (!shuttingDown) callback(); };
    ipcRenderer.on('projector:refresh', listener);
    return () => ipcRenderer.removeListener('projector:refresh', listener);
  },
  onTerminalOutput: (callback: (output: TerminalOutput) => void) => {
    terminalListeners.add(callback);
    return () => terminalListeners.delete(callback);
  },
  onOpenSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('projector:open-settings', listener);
    return () => ipcRenderer.removeListener('projector:open-settings', listener);
  },
  onShortcut: (callback: (action: ShortcutAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: ShortcutAction) =>
      callback(action);
    ipcRenderer.on('projector:shortcut', listener);
    return () => ipcRenderer.removeListener('projector:shortcut', listener);
  },
  onPaneFocus: (callback: (pane: { key: string; paneId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, pane: { key: string; paneId: string }) =>
      callback(pane);
    ipcRenderer.on('projector:focus-pane', listener);
    return () => ipcRenderer.removeListener('projector:focus-pane', listener);
  },
});
