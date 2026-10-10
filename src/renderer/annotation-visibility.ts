/** Visible client coordinates, including nested scroll/overflow clipping. */
export function annotationClip(node: Node | null) {
  const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  for (
    let element = node instanceof Element ? node : node?.parentElement;
    element;
    element = element.parentElement
  ) {
    const css = getComputedStyle(element);
    if (css.visibility === 'hidden' || css.visibility === 'collapse') return null;
    const x = /^(auto|scroll|hidden|clip)$/.test(css.overflowX);
    const y = /^(auto|scroll|hidden|clip)$/.test(css.overflowY);
    if (!x && !y) continue;
    const box = element.getBoundingClientRect();
    const scaleX =
      element instanceof HTMLElement && element.offsetWidth ? box.width / element.offsetWidth : 1;
    const scaleY =
      element instanceof HTMLElement && element.offsetHeight
        ? box.height / element.offsetHeight
        : 1;
    if (x) {
      clip.left = Math.max(clip.left, box.left + element.clientLeft * scaleX);
      clip.right = Math.min(
        clip.right,
        box.left + (element.clientLeft + element.clientWidth) * scaleX,
      );
    }
    if (y) {
      clip.top = Math.max(clip.top, box.top + element.clientTop * scaleY);
      clip.bottom = Math.min(
        clip.bottom,
        box.top + (element.clientTop + element.clientHeight) * scaleY,
      );
    }
  }
  return clip.right > clip.left && clip.bottom > clip.top ? clip : null;
}
