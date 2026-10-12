import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { TerminalOutput } from '../shared/terminal';
import type { ShortcutAction } from '../shared/application-workspace';
const terminalListeners = new Set<(output: TerminalOutput) => void>();
ipcRenderer.on('projector:terminal-output', (_event, delivery: { deliveryId: string; output: TerminalOutput }) => {
  try {
    for (const callback of terminalListeners) {
      try { callback(delivery.output); } catch { /* One disposed view cannot block other consumers. */ }
    }
  } finally { ipcRenderer.send('projector:terminal-output-ack', delivery.deliveryId); }
});
contextBridge.exposeInMainWorld('projector', {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  invoke: (method: string, params: unknown = {}) =>
    ipcRenderer.invoke('projector:invoke', method, params),
  onOperationStatus: (callback: (status: { waiting: boolean; operation?: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: { waiting: boolean; operation?: string },
    ) => callback(status);
    ipcRenderer.on('projector:operation-status', listener);
    return () => ipcRenderer.removeListener('projector:operation-status', listener);
  },
  onRefresh: (callback: () => void) => {
    const listener = () => callback();
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
