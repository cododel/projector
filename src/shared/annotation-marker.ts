export function markerGeometry(
  pointer: { x: number; y: number },
  viewport: { width: number; height: number },
  center?: { x: number; y: number },
) {
  const radius = 11;
  const corner = 3;
  // The anchor lies on the rounded lower-left corner, not on a separate tail.
  // Visibility belongs to the caller; the contour never sticks to viewport edges.
  void viewport;
  const cx = center?.x ?? pointer.x + radius - corner / 4;
  const cy = center?.y ?? pointer.y - radius + corner / 4;
  const left = cx - radius;
  const bottom = cy + radius;
  const tip = { x: left + corner / 4, y: bottom - corner / 4 };
  return {
    cx,
    cy,
    radius,
    path: `M${tip.x} ${tip.y} Q${left} ${bottom - corner / 2} ${left} ${bottom - corner} L${left} ${cy} A${radius} ${radius} 0 1 1 ${cx} ${bottom} L${left + corner} ${bottom} Q${left + corner / 2} ${bottom} ${tip.x} ${tip.y} Z`,
  };
}

export function commentPosition(
  pointer: { x: number; y: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  geometry: typeof markerGeometry = markerGeometry,
) {
  const marker = geometry(pointer, viewport);
  const above = marker.cy - marker.radius - 8 - size.height;
  return {
    x: Math.max(12, Math.min(viewport.width - size.width - 12, pointer.x - size.width / 2)),
    y: Math.max(
      12,
      Math.min(viewport.height - size.height - 12, above >= 12 ? above : pointer.y + 12),
    ),
  };
}
