import type { ApplicationSettings, ShortcutAction } from './application-workspace';
export interface ShortcutInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}
export function isPrintableShortcutKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return Array.from(key).length === 1 || normalized === 'comma' || normalized === 'space';
}
export function matchShortcut(input: ShortcutInput, shortcuts: ApplicationSettings['shortcuts'], platform: string): ShortcutAction | null {
  if (input.isComposing || input.key === 'Process' || input.key === 'Dead') return null;
  // Shift and Option produce ordinary terminal text. Even an older stored
  // binding must not consume that input before xterm receives it.
  if (!input.metaKey && !input.ctrlKey && isPrintableShortcutKey(input.key)) return null;
  const key = input.key === ',' ? 'comma' : input.key === ' ' ? 'space' : input.key.toLowerCase();
  for (const [action, value] of Object.entries(shortcuts)) {
    if (!value) continue;
    const parts = value.split('+').map(part => part.trim().toLowerCase()).map(part => ['command', 'meta'].includes(part) ? 'mod' : part);
    const rawKey = parts.pop();
    const expectedKey = rawKey === ',' ? 'comma' : rawKey;
    const modifiers = new Set(parts);
    const mod = platform === 'darwin' ? input.metaKey : input.ctrlKey;
    const expectedMeta = modifiers.has('mod') && platform === 'darwin';
    const expectedControl = modifiers.has('control') || (modifiers.has('mod') && platform !== 'darwin');
    if (key !== expectedKey || (modifiers.has('mod') && !mod) || input.metaKey !== expectedMeta ||
        input.ctrlKey !== expectedControl || input.altKey !== modifiers.has('alt') || input.shiftKey !== modifiers.has('shift')) continue;
    if (input.repeat && !['nextTab', 'previousTab', 'nextPane', 'previousPane'].includes(action)) return null;
    return action as ShortcutAction;
  }
  return null;
}
