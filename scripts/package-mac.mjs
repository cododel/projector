import { packager } from '@electron/packager';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Unsigned local package; uses a Node distribution of the same macOS architecture. */
export async function packageMac({ output = resolve('dist'), node = process.execPath } = {}) {
  if (process.platform !== 'darwin') throw new Error('Local packaging is supported on macOS only.');
  node = await realpath(node);
  await access(node, constants.X_OK);
  const info = JSON.parse(
    execFileSync(
      node,
      [
        '-p',
        'JSON.stringify({ version: process.versions.node, platform: process.platform, arch: process.arch })',
      ],
      { encoding: 'utf8', timeout: 5000 },
    ),
  );
  if (info.version !== '24.20.0' || info.platform !== 'darwin' || info.arch !== process.arch)
    throw new Error('Packaging requires macOS Node.js 24.20.0 matching the build architecture.');
  const metadata = JSON.parse(await readFile('package.json', 'utf8'));
  await access('out/main/index.js');
  await access('out/bridge.cjs');
  await mkdir('.tmp', { recursive: true });
  const stage = await mkdtemp(resolve('.tmp/package-mac-'));
  try {
    const source = join(stage, 'app');
    const helper = join(stage, 'mcp');
    await mkdir(source);
    await mkdir(helper);
    await cp('out', join(source, 'out'), { recursive: true });
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({
        name: metadata.name,
        version: metadata.version,
        type: 'module',
        main: metadata.main,
      }),
    );
    await copyFile(node, join(helper, 'node'));
    await chmod(join(helper, 'node'), 0o755);
    await copyFile(join(dirname(node), '..', 'LICENSE'), join(helper, 'NODE-LICENSE'));
    await copyFile('out/bridge.cjs', join(helper, 'bridge.cjs'));
    await writeFile(
      join(helper, 'blueprint-mcp'),
      `#!/bin/sh
set -eu
helper_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS
exec "$helper_dir/node" "$helper_dir/bridge.cjs" "$@"
`,
      { mode: 0o755 },
    );
    const apps = await packager({
      dir: source,
      name: 'Blueprint',
      appBundleId: 'dev.cododel.blueprint',
      appVersion: metadata.version,
      electronVersion: metadata.devDependencies.electron,
      platform: 'darwin',
      arch: process.arch,
      out: output,
      extraResource: [helper],
      // Compiler worker and runtime are physical files in this unsigned alpha package.
      asar: false,
      prune: false,
      overwrite: true,
      tmpdir: stage,
      quiet: true,
    });
    return join(apps[0], 'Blueprint.app');
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await packageMac({ node: process.env.BLUEPRINT_NODE ?? process.execPath }));
}
