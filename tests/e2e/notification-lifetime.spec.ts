import { test, expect, electron, type ElectronApplication } from './test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

interface ProbeResult { closed: number; threw: string | null; parentAlive: boolean; children: number }
interface ProbeApi { run(mode: 'normal' | 'reentrant' | 'layout'): ProbeResult }

for (const mode of ['normal', 'reentrant', 'layout'] as const) {
  test(`native notification ${mode} close preserves child lifetime`, async () => {
    const root = await mkdtemp(resolve('.tmp/notification-lifetime-'));
    let app: ElectronApplication | undefined;
    try {
      const data = join(root, 'data');
      await mkdir(data);
      const preload = join(root, 'preload.cjs');
      await writeFile(preload, '');
      const entry = join(root, 'probe.mjs');
      await build({
        stdin: { contents: `
import { app, BrowserWindow, protocol } from 'electron';
import { NotificationOverlay } from ${JSON.stringify(resolve('src/main/notifications.ts'))};
import { e2eWindowOptions, auditE2EWindows } from ${JSON.stringify(resolve('src/main/e2e-window.ts'))};
import { installProcessDiagnostics } from ${JSON.stringify(resolve('src/shared/test-diagnostics.ts'))};
installProcessDiagnostics('main');
auditE2EWindows(app);
app.setPath('userData', ${JSON.stringify(data)});
app.setPath('sessionData', ${JSON.stringify(data)});
void app.whenReady().then(async () => {
protocol.handle('projector', () => new Response('<!doctype html><html lang="en"><title>Local notification lifetime probe</title><body>Local renderer boundary</body></html>', {headers:{'Content-Type':'text/html'}}));
const parent = new BrowserWindow(e2eWindowOptions({show:false,width:1000,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}));
await parent.loadURL('data:text/html,<title>Local parent</title><h1>Notification lifetime</h1>');
let owner;
globalThis.overlayProbe = {
 run(mode) {
  owner = new NotificationOverlay(parent, ${JSON.stringify(preload)});
  owner.publish([{id:'probe',source:'catalog',context:'probe',operation:'probe',level:'error',title:'Local error',pending:false,repeats:1,lifetime:'sticky',actions:[]}]);
  const child = BrowserWindow.getAllWindows().find(window => window !== parent);
  if (!child) throw new Error('Native child was not created');
  let closed = 0;
  child.once('closed', () => closed++);
  if (mode === 'layout') owner.publish([]);
  if (mode !== 'normal') {
   // Actual native destruction synchronously emits the production closed event
   // while sync is inside setBounds. No fake child/null assignment is involved.
   const bounds = child.setBounds.bind(child);
   child.setBounds = (...args) => { bounds(...args); child.destroy(); };
  }
  let threw = null;
  try { owner.command({type:'layout',width:544,height:mode === 'layout' ? 0 : 100}); }
  catch (error) { threw = error instanceof Error ? error.message : String(error); }
  if (mode === 'normal') child.destroy();
  owner.command({type:'layout',width:544,height:0});
  owner.dispose();
  return {closed,threw,parentAlive:!parent.isDestroyed(),children:BrowserWindow.getAllWindows().filter(window=>window!==parent).length};
 }
};
app.on('before-quit',()=>owner?.dispose());
});
`, resolveDir: resolve('.'), sourcefile: 'notification-lifetime-probe.ts', loader: 'ts' },
        outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['electron'],
      });
      app = await electron.launch({ args: [entry], env: { ...process.env, PROJECTOR_DATA: data, PROJECTOR_E2E_BACKGROUND: '1' } });
      await expect.poll(() => app!.evaluate(() => Boolean((globalThis as unknown as { overlayProbe?: ProbeApi }).overlayProbe))).toBe(true);
      const result = await app.evaluate((_electron, mode) => (globalThis as unknown as { overlayProbe: ProbeApi }).overlayProbe.run(mode), mode);
      expect(result).toEqual({ closed: 1, threw: null, parentAlive: true, children: 0 });
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
