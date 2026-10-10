export function markerGeometry(
  pointer: { x: number; y: number },
  viewport: { width: number; height: number },
  center?: { x: number; y: number },
) {
  const radius = 11;
  const cx = center?.x ?? Math.max(12, Math.min(viewport.width - 12, pointer.x + 10));
  const cy = center?.y ?? Math.max(12, Math.min(viewport.height - 12, pointer.y - 14));
  const dx = pointer.x - cx,
    dy = pointer.y - cy;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length,
    uy = dy / length;
  const nx = -uy,
    ny = ux;
  const ax = cx + radius * (ux * 0.78 + nx * 0.625);
  const ay = cy + radius * (uy * 0.78 + ny * 0.625);
  const bx = cx + radius * (ux * 0.78 - nx * 0.625);
  const by = cy + radius * (uy * 0.78 - ny * 0.625);
  return {
    cx,
    cy,
    radius,
    path: `M${pointer.x} ${pointer.y} Q${pointer.x - dx * 0.35 + nx} ${pointer.y - dy * 0.35 + ny} ${ax} ${ay} A${radius} ${radius} 0 1 1 ${bx} ${by} Q${pointer.x - dx * 0.35 - nx} ${pointer.y - dy * 0.35 - ny} ${pointer.x} ${pointer.y} Z`,
  };
}

export function commentPosition(
  pointer: { x: number; y: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number },
) {
  const marker = markerGeometry(pointer, viewport);
  const above = marker.cy - marker.radius - 8 - size.height;
  return {
    x: Math.max(12, Math.min(viewport.width - size.width - 12, pointer.x - size.width / 2)),
    y: Math.max(
      12,
      Math.min(viewport.height - size.height - 12, above >= 12 ? above : pointer.y + 12),
    ),
  };
}
