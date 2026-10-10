import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('blueprint', {
  invoke: (method: string, params: unknown = {}) =>
    ipcRenderer.invoke('blueprint:invoke', method, params),
  onRefresh: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('blueprint:refresh', listener);
    return () => ipcRenderer.removeListener('blueprint:refresh', listener);
  },
});
