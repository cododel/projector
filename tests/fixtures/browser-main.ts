import { observeElectron } from '../../src/main/test-diagnostics';
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { BrowserManager, type BrowserCapture } from '../../src/main/browser';

observeElectron(app);
app.setName('Projector Browser Test');
app.setPath('userData', process.env.PROJECTOR_BROWSER_TEST_DATA!);
app.setPath('sessionData', process.env.PROJECTOR_BROWSER_TEST_DATA!);
type TestState = {
  manager: BrowserManager;
  drafts: unknown[];
  failDraft?: boolean;
  annotations: { artifactId: string; tabId: string; comment: string; capture: BrowserCapture }[];
};
declare global {
  var browserTest: TestState;
}
void app.whenReady().then(async () => {
  const window = new BrowserWindow(
    {
      width: 900,
      height: 700,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    },
  );
  const drafts: unknown[] = [];
  const annotations: TestState['annotations'] = [];
  const manager = new BrowserManager(
    window,
    {
      overlayPreload: join(process.env.PROJECTOR_BROWSER_TEST_DATA!, 'overlay.cjs'),
      onChange: () => {},
      getRevision: async () => 'source-version-1',
      onDraft: async (value) => {
        if (value && globalThis.browserTest?.failDraft) throw new Error('DISK_WRITE_FAILED');
        drafts.push(value);
        // Clearing editing can release a queued request to show the document.
        if (value === null) manager.select(null);
      },
      onAnnotation: async (value) => {
        annotations.push(value);
        return { id: 'annotation-1', number: 1 };
      },
    },
    process.env.PROJECTOR_BROWSER_TEST_DATA,
  );
  manager.setBounds({ x: 20, y: 80, width: 840, height: 540 });
  globalThis.browserTest = { manager, drafts, annotations };
  await window.loadURL('data:text/html,<h1>Browser manager test shell</h1>');
});
app.on('window-all-closed', () => app.quit());
