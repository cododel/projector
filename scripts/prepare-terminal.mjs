import { access, chmod, cp, mkdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
/** Keep native PTY files physical and executable, including npm's non-executable helper. */
export async function prepareTerminal() {
  const directory = dirname(require.resolve('node-pty/package.json'));
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (metadata.version !== '1.1.0')
    throw new Error('Terminal packaging requires pinned node-pty 1.1.0.');
  let native;
  for (const candidate of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
    try {
      await access(
        join(directory, candidate, process.platform === 'win32' ? 'conpty.node' : 'pty.node'),
      );
      native = candidate;
      break;
    } catch {
      /* Try the next supported native distribution. */
    }
  }
  if (!native)
    throw new Error(`node-pty has no native payload for ${process.platform}/${process.arch}.`);
  if (process.platform === 'darwin') {
    const helper = join(directory, native, 'spawn-helper');
    const info = await stat(helper);
    if (!info.isFile()) throw new Error('node-pty spawn-helper is not a regular executable.');
    await chmod(helper, 0o755);
    await access(helper, constants.X_OK);
  }
  return { directory, native };
}
export async function copyTerminalPayload(destination) {
  const { directory, native } = await prepareTerminal();
  const target = join(destination, 'node_modules', 'node-pty');
  await mkdir(target, { recursive: true });
  for (const file of ['lib', 'package.json', 'LICENSE'])
    await cp(join(directory, file), join(target, file), { recursive: true });
  await cp(join(directory, native), join(target, native), { recursive: true });
  if (process.platform === 'darwin') {
    await chmod(join(target, native, 'spawn-helper'), 0o755);
    await access(join(target, native, 'spawn-helper'), constants.X_OK);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareTerminal();
