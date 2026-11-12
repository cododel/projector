import { observeElectron } from '../../src/main/test-diagnostics';
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

const root = process.env.PROJECTOR_COMPOSER_TEST_DATA!;
observeElectron(app);
app.setPath('userData', join(root, 'data'));
app.setPath('sessionData', join(root, 'data'));
void app.whenReady().then(() => {
  const window = new BrowserWindow(
    {
      width: 680,
      height: 520,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    },
  );
  void window.loadFile(join(root, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
