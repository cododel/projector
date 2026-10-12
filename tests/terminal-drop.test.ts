import { expect, it } from 'vitest';
import { terminalFilePaths } from '../src/renderer/terminal-drop';
it('formats multiple local references without Enter and quotes shell-sensitive filenames', () => {
  expect(
    terminalFilePaths([
      '/tmp/image.png',
      '/tmp/a b.png',
      "/tmp/it's $(touch nope);.txt",
      '/tmp/日本語.png',
    ]),
  ).toBe("/tmp/image.png '/tmp/a b.png' '/tmp/it'\"'\"'s $(touch nope);.txt' '/tmp/日本語.png' ");
});
it.each(
  [[], ['relative.png'], [''], ['/tmp/a\nb'], ['/tmp/a\rb'], ['/tmp/a\x1bb']].map((paths) => ({
    paths,
  })),
)('rejects missing paths and terminal control characters: %j', ({ paths }) => {
  expect(() => terminalFilePaths(paths)).toThrow('valid filesystem paths');
});
