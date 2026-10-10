import type { WidgetValue } from '../document/types';

export interface DocumentView {
  details: Record<string, boolean>;
}

export interface AnnotationStateContext {
  stateHash: string;
  values: Record<string, WidgetValue>;
  view: DocumentView;
}

/** A stable serialization shared by the renderer and the authoritative runtime hash. */
export function canonicalString(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalString).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonicalString(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
