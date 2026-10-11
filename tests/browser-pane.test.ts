import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContentsView } from 'electron';
import { BrowserManager, type BrowserCapture } from '../src/main/browser';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Contents extends EventEmitter {
    private destroyed = false;
    navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      getActiveIndex: () => 0,
    };
    isDestroyed() {
      return this.destroyed;
    }
    isLoading() {
      return false;
    }
    setWindowOpenHandler() {}
    async loadURL() {}
    focus() {
      this.emit('focus');
    }
    send() {}
    async executeJavaScript() {
      throw new Error('DISK_WRITE_FAILED');
    }
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('destroyed');
    }
  }
  class View {
    webContents = new Contents();
    private bounds = { x: 0, y: 0, width: 0, height: 0 };
    private visible = true;
    setBackgroundColor() {}
    setBounds(bounds: typeof this.bounds) {
      this.bounds = { ...bounds };
    }
    getBounds() {
      return { ...this.bounds };
    }
    setVisible(visible: boolean) {
      this.visible = visible;
    }
    getVisible() {
      return this.visible;
    }
  }
  const profile = Object.assign(new EventEmitter(), {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
  });
  return {
    WebContentsView: View,
    ipcMain: { handle() {}, removeHandler() {} },
    session: { fromPartition: () => profile },
    dialog: {},
    screen: {},
    shell: {},
  };
});

const managers: BrowserManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

function fixture(
  onViewFocus?: (value: { viewId: string; tabId: string }) => void,
  onShortcut?: (input: Electron.Input) => boolean,
  hasUnfinishedEditor?: () => boolean,
) {
  const children: WebContentsView[] = [];
  const editorFocus = vi.fn();
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getContentSize: () => [1000, 700],
    webContents: { focus: editorFocus },
    contentView: {
      addChildView(view: WebContentsView) {
        const existing = children.indexOf(view);
        if (existing >= 0) children.splice(existing, 1);
        children.push(view);
      },
      removeChildView(view: WebContentsView) {
        const existing = children.indexOf(view);
        if (existing >= 0) children.splice(existing, 1);
      },
    },
  });
  const manager = new BrowserManager(window as unknown as BrowserWindow, {
    overlayPreload: '/isolated-overlay',
    onChange() {},
    onViewFocus,
    onShortcut,
    hasUnfinishedEditor,
    onAnnotation: async () => ({ id: 'annotation', number: 1 }),
  });
  managers.push(manager);
  return { manager, children, editorFocus };
}

async function tabs(manager: BrowserManager) {
  const first = await manager.open({
    artifactId: 'plan',
    projectId: 'project',
    url: 'https://first.example/',
  });
  const second = await manager.open({
    artifactId: 'plan',
    projectId: 'project',
    url: 'https://second.example/',
    background: true,
  });
  return { first, second };
}

const left = { x: 200, y: 80, width: 350, height: 540 };
const right = { x: 556, y: 80, width: 440, height: 540 };

describe('browser native pane ownership', () => {
  it('keeps separate native views bounded while selecting a browser or a terminal pane', async () => {
    const { manager, children } = fixture();
    const { first, second } = await tabs(manager);
    manager.setVisibleViews([
      { viewId: 'left', tabId: first.id, bounds: left, active: true },
      { viewId: 'right', tabId: second.id, bounds: right, active: false },
    ]);
    const [firstView, secondView] = children;
    expect(children).toHaveLength(2);
    expect(firstView.getBounds()).toEqual(left);
    expect(secondView.getBounds()).toEqual(right);
    manager.select(second.id);
    manager.setBounds({ x: 0, y: 40, width: 1000, height: 660 });
    expect(children).toEqual([firstView, secondView]);
    expect(firstView.getBounds()).toEqual(left);
    expect(secondView.getBounds()).toEqual(right);
    expect(manager.snapshot().activeTabId).toBe(second.id);
    manager.select(null);
    expect(children).toEqual([firstView, secondView]);
    expect(manager.snapshot().activeTabId).toBeNull();
    manager.setVisibleViews([]);
    expect(children).toHaveLength(0);
    expect(manager.snapshot().tabs).toHaveLength(2);
  });

  it('clips each pane to the window and rejects duplicate ownership without changing views', async () => {
    const { manager, children } = fixture();
    const { first, second } = await tabs(manager);
    manager.setVisibleViews([
      { viewId: 'left', tabId: first.id, bounds: left, active: true },
      { viewId: 'right', tabId: second.id, bounds: { ...right, width: 800 }, active: false },
    ]);
    expect(children[1].getBounds()).toEqual({ ...right, width: 444 });
    const previous = [...children];
    expect(() =>
      manager.setVisibleViews([
        { viewId: 'left', tabId: first.id, bounds: left, active: true },
        { viewId: 'right', tabId: first.id, bounds: right, active: false },
      ]),
    ).toThrow('INVALID_BROWSER_VIEWS');
    expect(() =>
      manager.setVisibleViews([
        { viewId: 'left', tabId: first.id, bounds: left, active: true },
        { viewId: 'right', tabId: second.id, bounds: right, active: true },
      ]),
    ).toThrow('Only one browser pane');
    expect(children).toEqual(previous);
    expect(manager.snapshot().activeTabId).toBe(first.id);
  });

  it('notifies the shell about background native input without selecting it prematurely', async () => {
    const onViewFocus = vi.fn();
    const { manager, children } = fixture(onViewFocus);
    const { first, second } = await tabs(manager);
    manager.setVisibleViews([
      { viewId: 'left', tabId: first.id, bounds: left, active: true },
      { viewId: 'right', tabId: second.id, bounds: right, active: false },
    ]);
    children[1].webContents.emit('focus');
    children[1].webContents.emit(
      'before-mouse-event',
      { preventDefault() {} },
      { type: 'mouseDown' },
    );
    await Promise.resolve();
    expect(onViewFocus).toHaveBeenCalledExactlyOnceWith({ viewId: 'right', tabId: second.id });
    expect(manager.snapshot().activeTabId).toBe(first.id);
    manager.select(second.id);
    children[1].webContents.emit('focus');
    await Promise.resolve();
    expect(onViewFocus).toHaveBeenCalledTimes(1);
  });

  it('keeps the failed comment editor and all pane ownership until private storage succeeds', async () => {
    const { manager, children } = fixture(vi.fn());
    const { first, second } = await tabs(manager);
    manager.setVisibleViews([
      { viewId: 'left', tabId: first.id, bounds: left, active: true },
      { viewId: 'right', tabId: second.id, bounds: right, active: false },
    ]);
    const capture: BrowserCapture = {
      id: 'capture',
      png: 'aGVsbG8=',
      source: {
        kind: 'browser-area',
        url: first.url,
        title: first.title,
        capturedAt: '2026-10-11T00:00:00.000Z',
        viewport: { width: left.width, height: left.height, deviceScaleFactor: 1 },
        rect: { x: 10, y: 10, width: 40, height: 20 },
        pointer: { x: 25, y: 25 },
        zoomFactor: 1,
        scroll: { x: 0, y: 0 },
      },
    };
    await manager.restoreDraft({
      capture,
      comment: 'Private comment',
      artifactId: 'plan',
      tabId: first.id,
    });
    const previous = [...children];
    await expect(manager.finishComment()).rejects.toThrow('DISK_WRITE_FAILED');
    expect(() => manager.setVisibleViews([])).toThrow('UNFINISHED_COMMENT');
    expect(() => manager.select(second.id)).toThrow('UNFINISHED_COMMENT');
    expect(children).toEqual(previous);
    expect(manager.snapshot().activeTabId).toBe(first.id);
    expect(manager.snapshot().annotating).toBe(true);
    const blocked = { preventDefault: vi.fn() };
    children[1].webContents.emit('before-mouse-event', blocked, { type: 'mouseDown' });
    expect(blocked.preventDefault).toHaveBeenCalledTimes(1);
    const resized = { ...left, width: 300 };
    manager.setVisibleViews([
      { viewId: 'left', tabId: first.id, bounds: resized, active: true },
      { viewId: 'right', tabId: second.id, bounds: right, active: false },
    ]);
    expect(children.at(-1)?.getBounds()).toEqual(resized);
    expect(capture.source.viewport).toEqual({ width: 350, height: 540, deviceScaleFactor: 1 });
  });

  it('suppresses the complete first native gesture until an editor transition activates its pane', async () => {
    let unfinished = true;
    const onViewFocus = vi.fn();
    const { manager, children, editorFocus } = fixture(onViewFocus, undefined, () => unfinished);
    const { first, second } = await tabs(manager);
    manager.setVisibleViews([
      { viewId: 'left', tabId: first.id, bounds: left, active: true },
      { viewId: 'right', tabId: second.id, bounds: right, active: false },
    ]);
    const mouseDown = { preventDefault: vi.fn() };
    children[1].webContents.emit('before-mouse-event', mouseDown, { type: 'mouseDown', button: 'left' });
    expect(mouseDown.preventDefault).toHaveBeenCalledOnce();
    expect(editorFocus).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(onViewFocus).toHaveBeenCalledWith({ viewId: 'right', tabId: second.id });
    expect(manager.snapshot().activeTabId).toBe(first.id);
    // Successful private storage is not yet confirmation of pane selection.
    unfinished = false;
    const pending = { preventDefault: vi.fn() };
    children[1].webContents.emit('before-mouse-event', pending, { type: 'mouseDown', button: 'left' });
    expect(pending.preventDefault).toHaveBeenCalledOnce();
    manager.select(second.id);
    const mouseUp = { preventDefault: vi.fn() };
    children[1].webContents.emit('before-mouse-event', mouseUp, { type: 'mouseUp', button: 'left' });
    expect(mouseUp.preventDefault).toHaveBeenCalledOnce();
    const activeClick = { preventDefault: vi.fn() };
    children[1].webContents.emit('before-mouse-event', activeClick, { type: 'mouseDown', button: 'left' });
    children[1].webContents.emit('before-mouse-event', activeClick, { type: 'mouseUp', button: 'left' });
    expect(activeClick.preventDefault).not.toHaveBeenCalled();
    // The active page also remains interactive when another editor is opened.
    unfinished = true;
    children[1].webContents.emit('before-mouse-event', activeClick, { type: 'mouseDown', button: 'left' });
    expect(activeClick.preventDefault).not.toHaveBeenCalled();
  });

  it('only cancels native key events recognized by the trusted shortcut matcher', async () => {
    const onShortcut = vi.fn(
      (input: Electron.Input) => input.control && input.key === 'Tab' && !input.isComposing,
    );
    const { manager, children } = fixture(undefined, onShortcut);
    await tabs(manager);
    const command = { preventDefault: vi.fn() };
    children[0].webContents.emit('before-input-event', command, {
      type: 'keyDown',
      key: 'Tab',
      control: true,
      isComposing: false,
    });
    expect(command.preventDefault).toHaveBeenCalledTimes(1);
    const ordinary = { preventDefault: vi.fn() };
    children[0].webContents.emit('before-input-event', ordinary, {
      type: 'keyDown',
      key: 'a',
      control: false,
      isComposing: false,
    });
    children[0].webContents.emit('before-input-event', ordinary, {
      type: 'keyDown',
      key: 'Tab',
      control: true,
      isComposing: true,
    });
    expect(ordinary.preventDefault).not.toHaveBeenCalled();
    expect(onShortcut).toHaveBeenCalledTimes(3);
  });

  it('removes only the destroyed tab and tolerates repeated window cleanup', async () => {
    const { manager, children } = fixture();
    const { first, second } = await tabs(manager);
    manager.setVisibleViews([
      { viewId: 'left', tabId: first.id, bounds: left, active: true },
      { viewId: 'right', tabId: second.id, bounds: right, active: false },
    ]);
    const secondView = children[1];
    await manager.command({ tabId: first.id, action: 'close' });
    expect(children).toEqual([secondView]);
    expect(manager.snapshot().tabs.map((value) => value.id)).toEqual([second.id]);
    expect(manager.snapshot().activeTabId).toBeNull();
    manager.setResizeMode(true);
    expect(secondView.getVisible()).toBe(false);
    manager.setResizeMode(false);
    expect(secondView.getVisible()).toBe(true);
    manager.dispose();
    manager.dispose();
    expect(children).toHaveLength(0);
    expect(manager.snapshot().tabs).toHaveLength(0);
  });

  it('preserves legacy single-view select and bounds until pane layout is used', async () => {
    const { manager, children } = fixture();
    const { second } = await tabs(manager);
    const firstView = children[0];
    manager.setBounds(left);
    expect(firstView.getBounds()).toEqual(left);
    manager.select(second.id);
    expect(children).toHaveLength(1);
    expect(children[0]).not.toBe(firstView);
    expect(children[0].getBounds()).toEqual(left);
    manager.select(null);
    expect(children).toHaveLength(0);
  });

  it('keeps an explicitly measured document capture surface across empty browser layouts', async () => {
    const { manager, children } = fixture();
    const { first } = await tabs(manager);
    manager.setVisibleViews([{ viewId: 'browser', tabId: first.id, bounds: right, active: true }]);
    manager.select(null);
    manager.setVisibleViews([]);
    manager.setBounds(left);
    const capture: BrowserCapture = {
      id: 'saved-document-capture', png: 'aGVsbG8=',
      source: { kind: 'browser-area', url: first.url, title: first.title,
        capturedAt: '2026-10-11T00:00:00.000Z',
        viewport: { width: left.width, height: left.height, deviceScaleFactor: 1 },
        rect: { x: 10, y: 10, width: 40, height: 20 }, pointer: { x: 25, y: 25 },
        zoomFactor: 1, scroll: { x: 0, y: 0 } },
    };
    await manager.showCapture({ artifactId: 'plan', capture, comment: 'Separate sidebar text', number: 2 });
    const overlay = children.at(-1)!;
    expect(overlay.getBounds()).toEqual(left);
    manager.setVisibleViews([]);
    expect(children).toEqual([overlay]);
    expect(overlay.getBounds()).toEqual(left);
    manager.setBounds({ ...left, width: 300 });
    expect(overlay.getBounds()).toEqual({ ...left, width: 300 });
    // An active native pane owns its geometry even when an older shell measurement arrives.
    manager.setVisibleViews([{ viewId: 'browser', tabId: first.id, bounds: right, active: true }]);
    manager.setBounds(left);
    expect(children).toHaveLength(1);
    expect(children[0].getBounds()).toEqual(right);
  });
});
