import { areWidgetsCompatible, type ParsedDocument } from '../document';
export function revisionSummary(previous: ParsedDocument | null, current: ParsedDocument) {
  const retained: string[] = [],
    added: string[] = [],
    requiresResponse: string[] = [];
  for (const widget of current.widgets) {
    const old = previous?.widgets.find((item) => item.id === widget.id);
    if (!old) added.push(widget.id);
    else if (areWidgetsCompatible(old, widget)) retained.push(widget.id);
    else requiresResponse.push(widget.id);
  }
  return {
    retained,
    added,
    requiresResponse,
    removed:
      previous?.widgets
        .filter((item) => !current.widgets.some((w) => w.id === item.id))
        .map((item) => item.id) ?? [],
  };
}
