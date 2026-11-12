import { Buffer } from 'node:buffer';

import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { copyTerminalPayload } from './prepare-terminal.mjs';

export default async function afterPack(context) {
  if (context.electronPlatformName !== process.platform)
    throw new Error('Projector release packages must be built on the target platform.');
  if (process.versions.node !== (await readFile('.node-version', 'utf8')).trim())
    throw new Error('The bundled Node executable must match .node-version.');

  const mac = process.platform === 'darwin';
  const windows = process.platform === 'win32';
  const contents = join(context.appOutDir, 'Projector.app', 'Contents');
  const resources = mac ? join(contents, 'Resources') : join(context.appOutDir, 'resources');
  const helper = join(resources, 'mcp');
  const node = await realpath(process.execPath);
  await mkdir(helper, { recursive: true });
  await copyFile(node, join(helper, windows ? 'node.exe' : 'node'));
  await copyFile(
    join(dirname(node), windows ? '.' : '..', 'LICENSE'),
    join(helper, 'NODE-LICENSE'),
  );
  await copyFile('LICENSE', join(helper, 'PROJECTOR-LICENSE'));
  await copyFile('out/bridge.cjs', join(helper, 'bridge.cjs'));
  await copyTerminalPayload(join(resources, 'app'));
  if (!windows) {
    await chmod(join(helper, 'node'), 0o755);
    await writeFile(
      join(helper, 'projector-mcp'),
      `#!/bin/sh
set -eu
helper_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS
exec "$helper_dir/node" "$helper_dir/bridge.cjs" "$@"
`,
      { mode: 0o755 },
    );
  }
  if (!mac) return;

  const key = process.env.SPARKLE_PUBLIC_ED_KEY;
  if (!key || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32)
    throw new Error('Set SPARKLE_PUBLIC_ED_KEY to the Projector Sparkle public key.');
  const sparkle = resolve('.tmp/sparkle');
  execFileSync('ditto', [
    join(sparkle, 'Sparkle.framework'),
    join(contents, 'Frameworks', 'Sparkle.framework'),
  ]);
  await copyFile(
    join(sparkle, 'projector-update-helper'),
    join(contents, 'MacOS', 'projector-update-helper'),
  );
  await mkdir(join(contents, 'Frameworks', 'Projector Helper.app', 'Contents', 'Resources'), {
    recursive: true,
  });
  const plist = join(contents, 'Info.plist');
  const set = (...args) => execFileSync('plutil', [...args, plist]);
  set('-insert', 'SUPublicEDKey', '-string', key);
  set(
    '-insert',
    'SUFeedURL',
    '-string',
    'https://github.com/cododel/projector/releases/latest/download/appcast.xml',
  );
  set('-insert', 'SUEnableAutomaticChecks', '-bool', 'NO');
  set('-insert', 'SUAutomaticallyUpdate', '-bool', 'NO');
  set('-insert', 'SUVerifyUpdateBeforeExtraction', '-bool', 'YES');
  set('-insert', 'SURequireSignedFeed', '-bool', 'YES');
}
