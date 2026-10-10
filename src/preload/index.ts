import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('blueprint', {
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
});
