import { describe, expect, it } from 'vitest';
import {
  browserPartition,
  browserUrl,
  safeBrowserBounds,
  validateArea,
} from '../src/main/browser-policy';

describe('external browser boundaries', () => {
  it('accepts development localhost and public web addresses', () => {
    expect(browserUrl('http://localhost:8000/staff/login')).toBe(
      'http://localhost:8000/staff/login',
    );
    expect(browserUrl('https://example.org')).toBe('https://example.org/');
    expect(browserUrl('http://[::1]:11828/path')).toBe('http://[::1]:11828/path');
  });

  it.each([
    'file:///etc/passwd',
    'projector://app/index.html',
    'javascript:alert(1)',
    'data:text/html,test',
    'https://user:password@example.org',
    'not a URL',
  ])('rejects privileged or malformed address %s', (url) =>
    expect(() => browserUrl(url)).toThrow('INVALID_URL'),
  );

  it('isolates persistent browser profiles by project, preserving the same project identity', () => {
    expect(browserPartition('checkout-one')).toBe(browserPartition('checkout-one'));
    expect(browserPartition('checkout-one')).not.toBe(browserPartition('checkout-two'));
    expect(browserPartition('checkout-one')).toMatch(/^persist:projector-browser-[a-f0-9]+$/);
  });

  it('keeps annotation coordinates in the captured viewport rather than current window dimensions', () => {
    const selection = { x: 40, y: 120, width: 140, height: 80 };
    expect(validateArea(selection, { width: 800, height: 600 })).toEqual(selection);
    expect(() => validateArea(selection, { width: 100, height: 600 })).toThrow('INVALID_AREA');
    expect(() => validateArea({ ...selection, x: NaN }, { width: 800, height: 600 })).toThrow(
      'INVALID_AREA',
    );
    expect(() => validateArea({ ...selection, width: 0 }, { width: 800, height: 600 })).toThrow(
      'INVALID_AREA',
    );
  });

  it('clamps a native view to the application content area', () => {
    expect(
      safeBrowserBounds({ x: 300, y: 60, width: 1000, height: 900 }, { width: 1000, height: 700 }),
    ).toEqual({ x: 300, y: 60, width: 700, height: 640 });
    expect(
      safeBrowserBounds({ x: -10, y: -10, width: 80, height: 40 }, { width: 1000, height: 700 }),
    ).toEqual({ x: 0, y: 0, width: 80, height: 40 });
    expect(() =>
      safeBrowserBounds({ x: Infinity, y: 0, width: 10, height: 10 }, { width: 1000, height: 700 }),
    ).toThrow('INVALID_BOUNDS');
  });
});

it('reuses an existing legacy browser partition without changing project isolation', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const data = await mkdtemp(join(tmpdir(), 'projector-profile-'));
  try {
    const current = browserPartition('legacy-project');
    const old = current.replace('projector-browser-', 'blueprint-browser-');
    await mkdir(join(data, 'Partitions', old.slice('persist:'.length)), { recursive: true });
    expect(browserPartition('legacy-project', data)).toBe(old);
    expect(browserPartition('other-project', data)).toMatch(/^persist:projector-browser-/);
    await mkdir(join(data, 'Partitions', current.slice('persist:'.length)), { recursive: true });
    expect(() => browserPartition('legacy-project', data)).toThrow('BROWSER_PROFILE_CONFLICT');
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
