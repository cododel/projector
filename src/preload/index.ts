import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { TerminalOutput } from '../shared/terminal';
import type { ShortcutAction } from '../shared/application-workspace';
const terminalListeners = new Set<(output: TerminalOutput) => void>();
ipcRenderer.on('blueprint:terminal-output', (_event, delivery: { deliveryId: string; output: TerminalOutput }) => {
  try {
    for (const callback of terminalListeners) {
      try { callback(delivery.output); } catch { /* One disposed view cannot block other consumers. */ }
    }
  } finally { ipcRenderer.send('blueprint:terminal-output-ack', delivery.deliveryId); }
});
contextBridge.exposeInMainWorld('blueprint', {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  invoke: (method: string, params: unknown = {}) =>
    ipcRenderer.invoke('blueprint:invoke', method, params),
  onOperationStatus: (callback: (status: { waiting: boolean; operation?: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: { waiting: boolean; operation?: string },
    ) => callback(status);
    ipcRenderer.on('blueprint:operation-status', listener);
    return () => ipcRenderer.removeListener('blueprint:operation-status', listener);
  },
  onRefresh: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('blueprint:refresh', listener);
    return () => ipcRenderer.removeListener('blueprint:refresh', listener);
  },
  onTerminalOutput: (callback: (output: TerminalOutput) => void) => {
    terminalListeners.add(callback);
    return () => terminalListeners.delete(callback);
  },
  onOpenSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('blueprint:open-settings', listener);
    return () => ipcRenderer.removeListener('blueprint:open-settings', listener);
  },
  onShortcut: (callback: (action: ShortcutAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: ShortcutAction) =>
      callback(action);
    ipcRenderer.on('blueprint:shortcut', listener);
    return () => ipcRenderer.removeListener('blueprint:shortcut', listener);
  },
  onPaneFocus: (callback: (pane: { key: string; paneId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, pane: { key: string; paneId: string }) =>
      callback(pane);
    ipcRenderer.on('blueprint:focus-pane', listener);
    return () => ipcRenderer.removeListener('blueprint:focus-pane', listener);
  },
});
