import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export type AreaRect = { x: number; y: number; width: number; height: number };
export type BrowserElementAnchor = {
  path: number[];
  tag: string;
  id?: string;
  textHash: string;
  pointerOffset?: { x: number; y: number };
};

export function browserStateHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function browserUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 8192)
    throw new Error('INVALID_URL: Enter an HTTP or HTTPS URL.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_URL: Enter an HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('INVALID_URL: Only HTTP and HTTPS URLs without credentials are allowed.');
  return url.href;
}

export function browserPartition(projectId: string, data?: string): string {
  const hash = createHash('sha256').update(projectId).digest('hex');
  const current = 'projector-browser-' + hash;
  const legacy = 'blueprint-browser-' + hash;
  if (data && existsSync(join(data, 'Partitions', legacy))) {
    if (existsSync(join(data, 'Partitions', current)))
      throw new Error(
        'BROWSER_PROFILE_CONFLICT: Both Projector and legacy browser profiles exist for this project.',
      );
    return 'persist:' + legacy;
  }
  return 'persist:' + current;
}

export function validateArea(
  rect: AreaRect,
  viewport: { width: number; height: number },
): AreaRect {
  const values = [rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height];
  if (
    !values.every(Number.isFinite) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    viewport.width < 1 ||
    viewport.height < 1 ||
    rect.x + rect.width > viewport.width + 0.5 ||
    rect.y + rect.height > viewport.height + 0.5
  )
    throw new Error('INVALID_AREA: Select a rectangle inside the captured viewport.');
  return rect;
}

export function safeBrowserBounds(
  bounds: AreaRect,
  windowSize: { width: number; height: number },
): AreaRect {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite))
    throw new Error('INVALID_BOUNDS: Browser bounds must be finite.');
  const x = Math.max(0, Math.min(windowSize.width, Math.round(bounds.x)));
  const y = Math.max(0, Math.min(windowSize.height, Math.round(bounds.y)));
  return {
    x,
    y,
    width: Math.max(0, Math.min(windowSize.width - x, Math.round(bounds.width))),
    height: Math.max(0, Math.min(windowSize.height - y, Math.round(bounds.height))),
  };
}
