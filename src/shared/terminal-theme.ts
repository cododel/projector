import { z } from 'zod';
import light from './terminal-themes/light.json';
import graphite from './terminal-themes/graphite.json';
import type { ApplicationSettings } from './application-workspace';

const color = z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
export const terminalColorSchemeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  foreground: color, background: color,
  cursorColor: color.optional(), selectionBackground: color.optional(),
  black: color, red: color, green: color, yellow: color, blue: color, purple: color, cyan: color, white: color,
  brightBlack: color, brightRed: color, brightGreen: color, brightYellow: color,
  brightBlue: color, brightPurple: color, brightCyan: color, brightWhite: color,
}).strict();
export type TerminalColorScheme = z.infer<typeof terminalColorSchemeSchema>;
export type TerminalThemeMode = 'follow' | 'light' | 'dark' | 'custom';

export const LIGHT_TERMINAL: TerminalColorScheme = light;
// Graphite palette from Herdr's src/settings.rs (Apache-2.0).
// https://github.com/herdrdev/herdr-app/blob/17eac390c346a731ba1ac14816ad91dc7cd2209b/src/settings.rs
export const GRAPHITE_TERMINAL: TerminalColorScheme = graphite;

type TerminalSettings = Pick<ApplicationSettings, 'appearance' | 'terminalTheme' | 'terminalCustomTheme'>;

export function terminalThemeMode(settings: TerminalSettings, prefersDark: boolean): 'light' | 'dark' | 'custom' {
  if (settings.terminalTheme !== 'follow') return settings.terminalTheme;
  if (settings.appearance === 'system') return prefersDark ? 'dark' : 'light';
  return settings.appearance;
}

export function terminalColorScheme(settings: TerminalSettings, prefersDark: boolean): TerminalColorScheme {
  if (settings.terminalTheme === 'custom' && settings.terminalCustomTheme)
    return settings.terminalCustomTheme;
  return terminalThemeMode(settings, prefersDark) === 'dark' ? GRAPHITE_TERMINAL : LIGHT_TERMINAL;
}

export function xtermTheme(scheme: TerminalColorScheme) {
  const { foreground, background } = scheme;
  return {
    foreground, background, cursor: scheme.cursorColor ?? foreground, cursorAccent: background,
    selectionBackground: scheme.selectionBackground ?? '#' + rgbChannels(foreground).join('') + '44',
    black: scheme.black, red: scheme.red, green: scheme.green, yellow: scheme.yellow,
    blue: scheme.blue, magenta: scheme.purple, cyan: scheme.cyan, white: scheme.white,
    brightBlack: scheme.brightBlack, brightRed: scheme.brightRed, brightGreen: scheme.brightGreen,
    brightYellow: scheme.brightYellow, brightBlue: scheme.brightBlue, brightMagenta: scheme.brightPurple,
    brightCyan: scheme.brightCyan, brightWhite: scheme.brightWhite,
  };
}

function rgbChannels(color: string): string[] {
  const hex = color.slice(1);
  return hex.length === 3 ? [...hex].map(digit => digit.repeat(2)) : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
}

export const terminalColorQueries = [10, 11, 12] as const;
export function terminalColorReply(slot: typeof terminalColorQueries[number], scheme: TerminalColorScheme): string {
  const color = slot === 10 ? scheme.foreground : slot === 11 ? scheme.background : scheme.cursorColor ?? scheme.foreground;
  const channels = rgbChannels(color);
  return `\x1b]${slot};rgb:${channels.map(pair => pair.repeat(2)).join('/')}\x1b\\`;
}
