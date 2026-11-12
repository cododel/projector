import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const files = await readdir('dist/release');
const platform = process.argv[2];
function requireAsset(name) {
  if (!files.includes(name)) throw new Error(`Missing release asset ${name}`);
}

if (platform === 'mac') {
  requireAsset(`Projector-${version}-mac-arm64.dmg`);
  requireAsset(`Projector-${version}-mac-arm64.zip`);
  if (process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF_TYPE === 'tag') {
    requireAsset('appcast.xml');
    const appcast = await readFile('dist/release/appcast.xml', 'utf8');
    if (
      !appcast.includes(`Projector-${version}-mac-arm64.zip`) ||
      !appcast.includes('sparkle:edSignature')
    )
      throw new Error('Sparkle appcast is missing the signed enclosure.');
  }
} else if (platform === 'win' || platform === 'linux') {
  const linux = platform === 'linux';
  const artifact = linux
    ? `Projector-${version}-linux-x86_64.AppImage`
    : `Projector-${version}-windows-x64-setup.exe`;
  requireAsset(artifact);
  if (!linux) requireAsset(`${artifact}.blockmap`);
  const channel = version.split('-')[1]?.split('.')[0] || 'latest';
  const suffix = linux ? '-linux.yml' : '.yml';
  const manifest = [channel, 'latest']
    .map((name) => name + suffix)
    .find((name) => files.includes(name));
  if (!manifest) throw new Error(`Missing update manifest for ${platform}`);
  const contents = await readFile(`dist/release/${manifest}`, 'utf8');
  const expectedHash = contents.match(/^sha512: ([A-Za-z0-9+/=]+)$/m)?.[1];
  if (!contents.includes(`path: ${artifact}\n`) || !expectedHash)
    throw new Error(`Update manifest ${manifest} does not describe ${artifact}`);
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(`dist/release/${artifact}`)) hash.update(chunk);
  if (hash.digest('base64') !== expectedHash)
    throw new Error(`Update manifest ${manifest} checksum does not match ${artifact}`);
} else {
  throw new Error('Expected mac, win, or linux.');
}
