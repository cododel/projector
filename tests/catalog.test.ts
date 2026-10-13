import { readdir } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { catalog } from '../dev/catalog';

test('coverage map inventories every renderer TSX source without claiming planned interfaces are included', async () => {
  const files = (await readdir('src/renderer')).filter(f => f.endsWith('.tsx')).map(f => `src/renderer/${f}`).sort();
  expect(catalog.flatMap(entry => entry.sources).sort()).toEqual(files);
  for (const entry of catalog) {
    expect(entry.states.length).toBeGreaterThan(0);
    expect(entry.boundary.length).toBeGreaterThan(0);
    if (entry.status !== 'included') expect(entry.stories).toBeUndefined();
    else expect(entry.stories?.length).toBeGreaterThan(0);
  }
});
