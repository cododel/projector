import { contextBridge, ipcRenderer } from 'electron';
import type { NotificationCommand, NotificationOverlayBridge } from '../shared/notifications';

const bridge: NotificationOverlayBridge = {
  command: (command: NotificationCommand) => ipcRenderer.send('projector:notification-command', command),
  onState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state);
    ipcRenderer.on('projector:notification-state', listener);
    return () => ipcRenderer.removeListener('projector:notification-state', listener);
  },
  onFocus: callback => {
    const listener = () => callback();
    ipcRenderer.on('projector:notification-focus', listener);
    return () => ipcRenderer.removeListener('projector:notification-focus', listener);
  },
};
contextBridge.exposeInMainWorld('projectorNotifications', bridge);
