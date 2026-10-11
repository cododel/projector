export const SIDEBAR_MIN = { left: 200, right: 250 };
export const SIDEBAR_MAX = 500;
export const SIDEBAR_DEFAULT = { left: 250, right: 310 };
export function sidebarWidth(width: number, side: 'left' | 'right'): number {
  return Math.max(SIDEBAR_MIN[side], Math.min(SIDEBAR_MAX, Math.round(width)));
}
/** Collapsing is a drag preview; persisted widths retain their side-specific limits. */
export function sidebarDragWidth(width: number, side: 'left' | 'right'): number {
  return width < SIDEBAR_MIN[side] * 0.7 ? 0 : sidebarWidth(width, side);
}
/** Preserve requested sizes while reserving a usable central toolbar on narrow windows. */
export function fitSidebars(left: number, right: number, windowWidth: number) {
  const available = Math.max(0, windowWidth - 420);
  const minimum = (left ? SIDEBAR_MIN.left : 0) + (right ? SIDEBAR_MIN.right : 0);
  if (left + right <= available || left + right <= minimum) return { left, right };
  const scale = Math.max(0, available - minimum) / (left + right - minimum);
  return {
    left: left ? SIDEBAR_MIN.left + (left - SIDEBAR_MIN.left) * scale : 0,
    right: right ? SIDEBAR_MIN.right + (right - SIDEBAR_MIN.right) * scale : 0,
  };
}
