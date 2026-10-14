import React from 'react';
type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
export function DocumentAreaSelection({ hovered, areaStart, areaEnd, ...handlers }: { hovered?: Rect | null; areaStart?: Point | null; areaEnd?: Point | null } & Pick<React.HTMLAttributes<HTMLDivElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onKeyDown'>): React.JSX.Element {
  return <div className="area-selection-overlay" role="application" aria-label="Select annotation area" tabIndex={0} {...handlers}>

          <span className="area-instructions">
            Click an element or drag an area · ↑/↓ select · Enter annotate · Escape cancel
          </span>
          {hovered && !areaStart && (
            <div
              className="element-hover-outline"
              style={{
                left: hovered.x,
                top: hovered.y,
                width: hovered.width,
                height: hovered.height,
              }}
            />
          )}
          {areaStart && areaEnd && (
            <div
              className="area-rectangle"
              style={{
                left: Math.min(areaStart.x, areaEnd.x),
                top: Math.min(areaStart.y, areaEnd.y),
                width: Math.abs(areaStart.x - areaEnd.x),
                height: Math.abs(areaStart.y - areaEnd.y),
              }}
            />
          )}
  </div>;
}
