import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const version = '2.10.0';
const digest = 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c';
const directory = resolve('.tmp/sparkle');
const archive = join(directory, `Sparkle-${version}.tar.xz`);
await mkdir(directory, { recursive: true });
if (process.env.PROJECTOR_SPARKLE_ARCHIVE) {
  await copyFile(process.env.PROJECTOR_SPARKLE_ARCHIVE, archive);
} else {
  execFileSync(
    'curl',
    [
      '--location',
      '--fail',
      '--silent',
      '--show-error',
      '--max-time',
      '180',
      '--output',
      archive,
      `https://github.com/sparkle-project/Sparkle/releases/download/${version}/Sparkle-${version}.tar.xz`,
    ],
    { stdio: 'inherit' },
  );
}
if (
  createHash('sha256')
    .update(await readFile(archive))
    .digest('hex') !== digest
)
  throw new Error('Sparkle distribution checksum mismatch.');
execFileSync('tar', [
  '-xf',
  archive,
  '-C',
  directory,
  './Sparkle.framework',
  './bin/generate_appcast',
]);
execFileSync(
  'clang',
  [
    '-fobjc-arc',
    '-fblocks',
    '-mmacosx-version-min=12.0',
    '-F',
    directory,
    '-framework',
    'Cocoa',
    '-framework',
    'Sparkle',
    '-Wl,-rpath,@executable_path/../Frameworks',
    '-o',
    join(directory, 'projector-update-helper'),
    'src/native/sparkle-updater.m',
  ],
  { stdio: 'inherit' },
);
