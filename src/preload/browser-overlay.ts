import { contextBridge, ipcRenderer } from 'electron';

// This preload belongs only to Blueprint's frozen-image overlay, never to a remote page.
contextBridge.exposeInMainWorld('blueprintCapture', {
  invoke: async (action: string, value: unknown = {}) => {
    const result: unknown = await ipcRenderer.invoke('blueprint:browser-overlay', action, value);
    if (
      result &&
      typeof result === 'object' &&
      'captureError' in result &&
      typeof result.captureError === 'string'
    )
      throw new Error(result.captureError);
    return result;
  },
  onLoad: (callback: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on('blueprint:browser-overlay-load', listener);
    return () => ipcRenderer.removeListener('blueprint:browser-overlay-load', listener);
  },
});
