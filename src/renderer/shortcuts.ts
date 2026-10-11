import { isPrintableShortcutKey, matchShortcut } from '../shared/keyboard-shortcuts';
import type { ApplicationSettings, ShortcutAction } from '../shared/application-workspace';

export interface ShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}
export function shortcutForEvent(
  event: ShortcutKey,
  mac = navigator.platform.includes('Mac'),
): string | null {
  if (
    event.isComposing ||
    ['Meta', 'Control', 'Shift', 'Alt', 'Dead', 'Process', 'Unidentified'].includes(event.key)
  )
    return null;
  if (!event.metaKey && !event.ctrlKey && isPrintableShortcutKey(event.key)) return null;
  const modifiers = [
    (mac ? event.metaKey : event.ctrlKey) && 'Mod',
    (mac ? event.ctrlKey : event.metaKey) && 'Control',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
  ].filter(Boolean);
  if (!modifiers.length) return null;
  const key =
    event.key === ','
      ? 'Comma'
      : event.key === ' '
        ? 'Space'
        : event.key.length === 1
          ? event.key.toUpperCase()
          : event.key;
  return [...modifiers, key].join('+');
}
export function normalizeShortcut(value: string): string {
  return value
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .join('+');
}
export function shortcutAction(
  event: ShortcutKey,
  shortcuts: ApplicationSettings['shortcuts'],
  mac = navigator.platform.includes('Mac'),
): ShortcutAction | null {
  return matchShortcut(event, shortcuts, mac ? 'darwin' : 'linux');
}
