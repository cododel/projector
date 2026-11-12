import { app, dialog, net } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repository = 'cododel/projector';
const releases = `https://github.com/${repository}/releases`;
const sparkleHelper = join(process.resourcesPath, '..', 'MacOS', 'projector-update-helper');

export function updatesAvailable() {
  if (!app.isPackaged) return false;
  if (process.platform === 'darwin') return existsSync(sparkleHelper);
  return (
    (process.platform === 'win32' || Boolean(process.env.APPIMAGE)) &&
    existsSync(join(process.resourcesPath, 'app-update.yml'))
  );
}

async function checkSparkle() {
  let feed = `${releases}/latest/download/appcast.xml`;
  if (app.getVersion().includes('-')) {
    const response = await net.fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=30`,
      {
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    const published: {
      tag_name: string;
      draft: boolean;
      prerelease: boolean;
      assets: { name: string }[];
    }[] = await response.json();
    const currentChannel = app.getVersion().split('-')[1]?.split('.')[0];
    const release = published.find(
      (item) =>
        !item.draft &&
        /^v\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(item.tag_name) &&
        (!item.prerelease || item.tag_name.split('-')[1]?.split('.')[0] === currentChannel) &&
        item.assets.some((asset) => asset.name === 'appcast.xml'),
    );
    if (!release) throw new Error('No published Projector update feed is available.');
    feed = `${releases}/download/${release.tag_name}/appcast.xml`;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(sparkleHelper, [join(process.resourcesPath, '..', '..'), feed], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Sparkle exited with ${signal ?? code}.`));
    });
  });
}

async function checkInstaller(quitToInstall: (install: () => void) => void) {
  const { autoUpdater } = (await import('electron-updater')).default;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.disableDifferentialDownload = true;
  const onError = (error: Error) => console.error('Projector update failed', error);
  autoUpdater.on('error', onError);
  try {
    const update = await autoUpdater.checkForUpdates();
    if (!update?.isUpdateAvailable) {
      await dialog.showMessageBox({ message: 'Projector is up to date.' });
      return;
    }
    const { response } = await dialog.showMessageBox({
      message: `Projector ${update.updateInfo.version} is available.`,
      detail: 'Download the update and quit Projector to install it.',
      buttons: ['Download and Install', 'Cancel'],
      cancelId: 1,
      defaultId: 1,
    });
    if (response !== 0) return;
    await autoUpdater.downloadUpdate();
    quitToInstall(() => {
      autoUpdater.once('error', onError);
      autoUpdater.quitAndInstall(false, true);
      setImmediate(() => app.quit());
    });
  } finally {
    autoUpdater.off('error', onError);
  }
}

let checking = false;

export async function checkForUpdates(quitToInstall: (install: () => void) => void) {
  if (checking || !updatesAvailable()) return;
  checking = true;
  try {
    if (process.platform === 'darwin') await checkSparkle();
    else await checkInstaller(quitToInstall);
  } catch (error) {
    console.error('Projector update check failed', error);
    await dialog.showMessageBox({
      type: 'error',
      message: 'Projector could not check for or install an update.',
      detail: 'Try again later.',
    });
  } finally {
    checking = false;
  }
}
