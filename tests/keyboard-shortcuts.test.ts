import { expect, it } from 'vitest';
import { matchShortcut, type ShortcutInput } from '../src/shared/keyboard-shortcuts';
import { DEFAULT_SHORTCUTS } from '../src/shared/application-workspace';
import { shortcutForEvent } from '../src/renderer/shortcuts';
const input: ShortcutInput = { key: 'j', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
it('applies application modifiers exactly and preserves ordinary terminal input and composition', () => {
  expect(matchShortcut(input, DEFAULT_SHORTCUTS, 'darwin')).toBeNull();
  expect(matchShortcut({ ...input, metaKey: true }, DEFAULT_SHORTCUTS, 'darwin')).toBe('bottomPanel');
  expect(matchShortcut({ ...input, ctrlKey: true }, DEFAULT_SHORTCUTS, 'darwin')).toBeNull();
  expect(matchShortcut({ ...input, ctrlKey: true }, DEFAULT_SHORTCUTS, 'linux')).toBe('bottomPanel');
  expect(matchShortcut({ ...input, metaKey: true, isComposing: true }, DEFAULT_SHORTCUTS, 'darwin')).toBeNull();
  expect(matchShortcut({ ...input, key: 'Process', metaKey: true }, DEFAULT_SHORTCUTS, 'darwin')).toBeNull();
  expect(matchShortcut({ ...input, key: 'Tab', ctrlKey: true }, DEFAULT_SHORTCUTS, 'darwin')).toBe('nextTab');
  expect(matchShortcut({ ...input, key: 'Tab', ctrlKey: true, shiftKey: true }, DEFAULT_SHORTCUTS, 'darwin')).toBe('previousTab');
});
it('honors disabled/remapped actions and does not repeat creation on held keys', () => {
  expect(matchShortcut({ ...input, metaKey: true }, { ...DEFAULT_SHORTCUTS, bottomPanel: null }, 'darwin')).toBeNull();
  expect(matchShortcut({ ...input, key: ',', metaKey: true }, DEFAULT_SHORTCUTS, 'darwin')).toBe('settings');
  expect(matchShortcut({ ...input, key: 't', metaKey: true, repeat: true }, DEFAULT_SHORTCUTS, 'darwin')).toBeNull();
  expect(matchShortcut({ ...input, key: 'd', metaKey: true, shiftKey: true }, { ...DEFAULT_SHORTCUTS, splitRight: 'Mod+Shift+D' }, 'darwin')).toBe('splitRight');
});
it('never consumes Shift or Option printable input from existing bindings', () => {
  for (const [key, binding, modifiers] of [
    ['A', 'Shift+A', { shiftKey: true }],
    ['å', 'Alt+å', { altKey: true }],
    ['Å', 'Alt+Shift+Å', { altKey: true, shiftKey: true }],
    [',', 'Shift+Comma', { shiftKey: true }],
    [' ', 'Alt+Space', { altKey: true }],
  ] as const) {
    expect(matchShortcut({ ...input, key, ...modifiers }, { ...DEFAULT_SHORTCUTS, newTab: binding }, 'darwin')).toBeNull();
  }
  expect(shortcutForEvent({ ...input, key: 'A', shiftKey: true, ctrlKey: true }, true)).toBe('Control+Shift+A');
  expect(shortcutForEvent({ ...input, key: 'å', altKey: true, metaKey: true }, true)).toBe('Mod+Alt+Å');
  expect(matchShortcut({ ...input, key: 'A', ctrlKey: true, shiftKey: true },
    { ...DEFAULT_SHORTCUTS, newTab: 'Control+Shift+A' }, 'darwin')).toBe('newTab');
});
it('does not record text-producing Shift or Option combinations as shortcuts', () => {
  for (const modifiers of [{ shiftKey: true }, { altKey: true }, { altKey: true, shiftKey: true }])
    expect(shortcutForEvent({ ...input, key: 'A', ...modifiers }, true)).toBeNull();
  expect(shortcutForEvent({ ...input, key: ' ', altKey: true }, true)).toBeNull();
  expect(shortcutForEvent({ ...input, key: 'ArrowLeft', altKey: true }, true)).toBe('Alt+ArrowLeft');
});
