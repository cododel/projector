import { BrowserWindow, ipcMain, screen, webContents, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { notificationsSchema, notificationCommandSchema, type Notification, type NotificationCommand } from '../shared/notifications';
import { e2eWindowOptions } from './e2e-window';

let current: NotificationOverlay | null = null;
let bound = false;
function activate(owner: NotificationOverlay): void { current = owner; }
const retired = new WeakSet<Electron.WebContents>();

/** Process-owned dispatcher stays bound during child/parent teardown. */
function bind(): void {
  if (bound) return;
  bound = true;
  ipcMain.handle('projector:notifications-publish', (event, input: unknown) => {
    if (retired.has(event.sender)) return;
    if (!current?.ownsShell(event)) throw new Error('Untrusted notification publisher');
    current.publish(notificationsSchema.parse(input));
  });
  ipcMain.on('projector:notification-command', (event, input: unknown) => {
    if (retired.has(event.sender)) return;
    if (!current?.ownsOverlay(event)) return;
    const result = notificationCommandSchema.safeParse(input);
    if (result.success) current.command(result.data);
  });
  ipcMain.on('projector:notifications-focus', event => {
    if (current?.ownsShell(event)) current.focus();
  });
}

export class NotificationOverlay {
  private child: BrowserWindow | null = null;
  private notices: Notification[] = [];
  private ready = false;
  private size = { width: 544, height: 100 };
  private disposed = false;
  private shell: Electron.WebContents;
  private returnFocus: Electron.WebContents | null = null;
  private focusPending = false;
  private pointerTimer: ReturnType<typeof setInterval> | null = null;
  private samplePointer = () => {
    if (!this.child || this.child.isDestroyed() || !this.ready || !this.child.isVisible()) return;
    const point = screen.getCursorScreenPoint(), bounds = this.child.getBounds();
    this.child.webContents.send('projector:notification-pointer', { x: point.x - bounds.x, y: point.y - bounds.y });
  };
  private stopPointer = () => {
    if (this.pointerTimer) clearInterval(this.pointerTimer);
    this.pointerTimer = null;
  };
  private sync = () => {
    if (this.disposed || this.parent.isDestroyed() || !this.child || this.child.isDestroyed()) return;
    const bounds = this.parent.getContentBounds();
    const width = Math.min(this.size.width, bounds.width);
    const height = Math.min(this.size.height, Math.floor(bounds.height * 0.6));
    // 40px shell titlebar + 12px visible gap - 8px stack padding.
    this.child.setBounds({ x: Math.round(bounds.x + (bounds.width - width) / 2), y: bounds.y + 44, width: Math.max(1, width), height: Math.max(1, height) });
    const visible = this.parent.isVisible() && !this.parent.isMinimized();
    if (!visible) this.child.hide();
    else if (this.notices.length && this.ready && !this.child.isVisible()) this.child.showInactive();
    if (this.ready) this.child.webContents.send('projector:notification-state', {
      notifications: this.notices, visible, maxHeight: Math.floor(bounds.height * 0.6),
    });
    // Forwarded mousemove is not guaranteed for an ignored, inactive native child
    // (or when a new alert appears under a stationary cursor). Sample only while
    // visible; the renderer owns hit testing including rounded corners and gaps.
    if (visible && this.ready && this.child.isVisible()) {
      if (!this.pointerTimer) this.pointerTimer = setInterval(this.samplePointer, 32);
      this.samplePointer();
    } else this.stopPointer();
  };
  constructor(private parent: BrowserWindow, private preload: string) {
    this.shell = parent.webContents;
    bind(); activate(this);
    parent.on('move', this.sync); parent.on('resize', this.sync); parent.on('show', this.sync); parent.on('hide', this.sync);
    parent.on('minimize', this.sync); parent.on('restore', this.sync); parent.on('enter-full-screen', this.sync); parent.on('leave-full-screen', this.sync);
    parent.webContents.on('did-start-navigation', this.reset);
    parent.on('close', this.closeWithParent);
    parent.once('closed', this.dispose);
  }
  ownsShell(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return !this.disposed && event.sender === this.shell && event.senderFrame === event.sender.mainFrame;
  }
  ownsOverlay(event: IpcMainEvent): boolean {
    return !this.disposed && event.sender === this.child?.webContents && event.senderFrame === event.sender.mainFrame;
  }
  private reset = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) { this.notices = []; this.child?.hide(); this.stopPointer(); }
  };
  publish(notices: Notification[]): void {
    this.notices = notices;
    if (!notices.length) this.focusPending = false;
    if (!this.child && notices.length) {
      const child = new BrowserWindow(e2eWindowOptions({ parent: this.parent, frame: false, transparent: true,
        backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false,
        minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false, acceptFirstMouse: true,
        width: 544, height: 100, webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false } }));
      this.child = child;
      child.setIgnoreMouseEvents(true, { forward: true });
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      child.webContents.on('will-navigate', event => event.preventDefault());
      child.on('closed', () => { this.stopPointer(); this.child = null; this.ready = false; });
      const contents = child.webContents;
      void child.loadURL('projector://app/notifications.html').catch(error => {
        if (!this.disposed && !retired.has(contents)) console.error(error);
      });
    }
    this.sync();
  }
  command(command: NotificationCommand): void {
    if (this.disposed || !this.child || this.child.isDestroyed()) return;
    if (command.type === 'ready') { this.ready = true; this.sync(); if (this.focusPending) this.focus(); }
    else if (command.type === 'layout') {
      this.size = { width: Math.ceil(command.width), height: Math.ceil(command.height) };
      this.sync();
      if (!this.notices.length && command.height <= 32) { this.child.hide(); this.stopPointer(); }
    } else if (command.type === 'pointer') this.child.setIgnoreMouseEvents(!command.interactive, { forward: true });
    else if (command.type === 'blur') {
      if (!this.parent.isVisible()) return;
      this.parent.focus();
      if (this.returnFocus && !this.returnFocus.isDestroyed()) this.returnFocus.focus(); else this.shell.focus();
    }
    else if (command.type === 'action' || command.type === 'dismiss') {
      const n = this.notices.find(n => n.id === command.id);
      if (!n || (command.type === 'action' && (n.pending || !n.actions.some(a => a.id === command.actionId)))) return;
      this.shell.send('projector:notification-action', command);
    }
  }
  focus(): void {
    if (!this.notices.length || !this.parent.isVisible() || this.parent.isMinimized()) return;
    this.focusPending = true;
    if (!this.child || !this.ready) return;
    this.focusPending = false;
    const focused = webContents.getFocusedWebContents();
    if (focused !== this.child.webContents) this.returnFocus = focused;
    this.child.focus(); this.child.webContents.focus(); this.child.webContents.send('projector:notification-focus');
  }
  private retireChild(): void {
    this.stopPointer();
    if (this.child && !this.child.isDestroyed()) {
      retired.add(this.child.webContents);
      this.child.destroy();
    }
    this.child = null; this.ready = false;
  }
  private closeWithParent = (event: Electron.Event): void => {
    // Retire the native child before macOS tears down its parent window graph.
    this.retireChild();
    queueMicrotask(() => {
      if (!this.disposed && !this.parent.isDestroyed() && event.defaultPrevented) this.publish(this.notices);
    });
  };
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.parent.removeListener('move', this.sync); this.parent.removeListener('resize', this.sync); this.parent.removeListener('show', this.sync); this.parent.removeListener('hide', this.sync);
    this.parent.removeListener('minimize', this.sync); this.parent.removeListener('restore', this.sync); this.parent.removeListener('enter-full-screen', this.sync); this.parent.removeListener('leave-full-screen', this.sync);
    this.shell.removeListener('did-start-navigation', this.reset);
    this.parent.removeListener('close', this.closeWithParent);
    retired.add(this.shell);
    this.retireChild();
    if (current === this) current = null;
  };
}
