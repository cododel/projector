import { mkdir, open, rename, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BlueprintError } from '../shared/protocol';
export async function atomicJson(path: string, value: unknown) {
  return atomicText(path, JSON.stringify(value, null, 2));
}
export async function atomicText(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
export async function inside(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  const rel = relative(canonicalRoot, canonical);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    throw new BlueprintError('PATH_OUTSIDE_PROJECT', 'Path leaves the registered directory');
  return canonical;
}
export function beneath(root: string, ...parts: string[]) {
  const path = resolve(root, ...parts);
  const rel = relative(resolve(root), path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    throw new BlueprintError('INVALID_PATH', 'Invalid path');
  return path;
}
/** Validate the nearest existing ancestor before creating any project-owned path. */
export async function writableInside(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const absolute = beneath(canonicalRoot, relative(canonicalRoot, resolve(path)));
  let ancestor = absolute;
  while (true) {
    try {
      await inside(canonicalRoot, ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return absolute;
}

export async function commitDirectory(stage: string, target: string, root: string) {
  await writableInside(root, stage);
  await writableInside(root, target);
  await rename(stage, target);
  const directory = await open(dirname(target), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
