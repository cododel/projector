export type WidgetKind = 'choice' | 'text' | 'checklist';
export type WidgetValue = string | string[];

export interface WidgetDefinition {
  id: string;
  kind: WidgetKind;
  meaning: string;
  semanticsVersion: string;
  options?: string[];
  defaultValue: WidgetValue;
  schemaFingerprint: string;
}

/** Serializable render data, never executable artifact source. */
export interface DocumentNode {
  type: string;
  id?: string;
  value?: string;
  children?: DocumentNode[];
  props?: Record<string, unknown>;
}

export interface ParsedDocument {
  blocks: DocumentNode[];
  widgets: WidgetDefinition[];
}

export class DocumentValidationError extends Error {
  readonly code = 'INVALID_DOCUMENT';
  readonly guideReference = 'authoring';

  constructor(message: string) {
    super(message);
    this.name = 'DocumentValidationError';
  }
}

export function isWidgetValueValid(widget: WidgetDefinition, value: unknown): value is WidgetValue {
  if (widget.kind === 'text') return typeof value === 'string' && value.length <= 100_000;
  if (widget.kind === 'choice')
    return typeof value === 'string' && !!widget.options?.includes(value);
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && widget.options?.includes(item)) &&
    new Set(value).size === value.length
  );
}

export function areWidgetsCompatible(previous: WidgetDefinition, next: WidgetDefinition): boolean {
  return (
    previous.id === next.id &&
    previous.kind === next.kind &&
    previous.meaning === next.meaning &&
    previous.semanticsVersion === next.semanticsVersion &&
    previous.schemaFingerprint === next.schemaFingerprint
  );
}
