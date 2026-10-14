import React from 'react';
import { markerGeometry } from '../../shared/annotation-marker';
export interface DocumentHighlight { id: string; number: number; pointer?: { x: number; y: number }; markerVisible: boolean; rects: { x: number; y: number; width: number; height: number }[]; }
export function DocumentAnnotations({ highlights, focused = '' }: { highlights: DocumentHighlight[]; focused?: string }): React.JSX.Element { return (
      <div className="annotation-layer" aria-hidden="true">
        {highlights.map((a, annotationIndex) => (
          <React.Fragment key={a.id}>
            {a.rects.map((r, i) => (
              <span
                key={i}
                className={`text-highlight ${focused === a.id ? 'focused' : ''}`}
                style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
              />
            ))}
            {a.markerVisible &&
              a.pointer &&
              (() => {
                const pointer = {
                  x: a.pointer.x - window.scrollX,
                  y: a.pointer.y - window.scrollY,
                };
                const overlap = highlights
                  .slice(0, annotationIndex)
                  .filter(
                    (previous) =>
                      previous.markerVisible &&
                      previous.pointer &&
                      Math.abs(previous.pointer.x - a.pointer!.x) < 8 &&
                      Math.abs(previous.pointer.y - a.pointer!.y) < 8,
                  ).length;
                const base = markerGeometry(pointer, { width: innerWidth, height: innerHeight });
                const center = overlap ? { x: base.cx + overlap * 24, y: base.cy } : undefined;
                const { cx, cy, path } = markerGeometry(
                  pointer,
                  { width: innerWidth, height: innerHeight },
                  center,
                );
                return (
                  <svg
                    className="area-annotation-number inline-annotation-number"
                    data-pointer-x={a.pointer.x}
                    data-pointer-y={a.pointer.y}
                    style={{ left: window.scrollX, top: window.scrollY }}
                    width={innerWidth}
                    height={innerHeight}
                    aria-label={`Annotation ${a.number}`}
                  >
                    <path
                      d={path}
                      fill="#4263da"
                      stroke="white"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                    <text
                      x={cx}
                      y={cy}
                      dominantBaseline="central"
                      textAnchor="middle"
                      fontSize="10"
                      fontWeight="600"
                      fill="white"
                    >
                      {a.number}
                    </text>
                  </svg>
                );
              })()}
          </React.Fragment>
        ))}
      </div>
  );
}
