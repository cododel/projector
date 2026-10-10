export interface Endpoint {
  blockId: string;
  path: number[];
  offset: number;
}
export interface TextAnchor {
  start: Endpoint;
  end: Endpoint;
}
export interface SelectionData {
  quote: string;
  prefix: string;
  suffix: string;
  blockId: string;
  kind: 'text';
  anchor: TextAnchor;
}
/** Paths address parsed text leaves, independent of quote content or annotation markup. */
function leaf(
  node: Node,
  offset: number,
  end: boolean,
): { element: HTMLElement; offset: number } | null {
  const element = node instanceof Element ? node : node.parentElement;
  const own = element?.closest<HTMLElement>('[data-text-path]');
  if (own)
    return {
      element: own,
      offset: node.nodeType === Node.TEXT_NODE ? offset : end ? (own.textContent?.length ?? 0) : 0,
    };
  if (node instanceof Element) {
    const boundary =
      node.childNodes[Math.max(0, Math.min(node.childNodes.length - 1, end ? offset - 1 : offset))];
    const candidate = boundary instanceof Element ? boundary : boundary?.parentElement;
    const all = candidate?.querySelectorAll<HTMLElement>('[data-text-path]');
    const next = candidate?.matches('[data-text-path]')
      ? (candidate as HTMLElement)
      : all?.[end ? all.length - 1 : 0];
    if (next) return { element: next, offset: end ? (next.textContent?.length ?? 0) : 0 };
  }
  return null;
}
export function captureTextSelection(root: HTMLElement): SelectionData | null {
  const selected = window.getSelection();
  if (!selected || selected.isCollapsed || !selected.rangeCount) return null;
  const range = selected.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = leaf(range.startContainer, range.startOffset, false),
    end = leaf(range.endContainer, range.endOffset, true);
  if (!start || !end || start.element.closest('.widget') || end.element.closest('.widget'))
    return null;
  const quote = range.toString();
  if (!quote.trim()) return null;
  const endpoint = (value: { element: HTMLElement; offset: number }): Endpoint => ({
    blockId: value.element.closest('[data-block-id]')?.getAttribute('data-block-id') ?? 'document',
    path: JSON.parse(value.element.dataset.textPath ?? '[]') as number[],
    offset: value.offset,
  });
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(root);
  after.setStart(range.endContainer, range.endOffset);
  return {
    kind: 'text',
    quote,
    prefix: before.toString().slice(-64),
    suffix: after.toString().slice(0, 64),
    blockId: endpoint(start).blockId,
    anchor: { start: endpoint(start), end: endpoint(end) },
  };
}
export function anchorRange(root: HTMLElement, anchor: TextAnchor): Range | null {
  const find = (point: Endpoint) =>
    Array.from(root.querySelectorAll<HTMLElement>('[data-text-path]')).find(
      (e) => e.dataset.textPath === JSON.stringify(point.path),
    );
  const start = find(anchor.start),
    end = find(anchor.end);
  if (!start?.firstChild || !end?.firstChild) return null;
  if (
    anchor.start.offset > (start.textContent?.length ?? 0) ||
    anchor.end.offset > (end.textContent?.length ?? 0)
  )
    return null;
  const range = document.createRange();
  range.setStart(start.firstChild, anchor.start.offset);
  range.setEnd(end.firstChild, anchor.end.offset);
  return range;
}
