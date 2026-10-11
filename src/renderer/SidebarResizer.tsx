import { useRef, useState } from 'react';
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  sidebarWidth,
  sidebarDragWidth,
} from '../shared/sidebar-layout';

export function SidebarResizer({
  side,
  width,
  position,
  onPreview,
  onCommit,
  onCancel,
  onStart,
}: {
  side: 'left' | 'right';
  width: number;
  position: number;
  onPreview: (width: number) => void;
  onCommit: (width: number) => Promise<void>;
  onCancel: () => void;
  onStart: () => void;
}) {
  const drag = useRef<{ x: number; width: number; original: number; current: number } | null>(null);
  const [active, setActive] = useState(false);
  const label = `Resize ${side === 'left' ? 'projects' : 'feedback'} sidebar`;
  return (
    <div
      className={`sidebar-resizer sidebar-resizer-${side} ${active ? 'resizing' : ''}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_MIN[side]}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      title="Drag to resize · double-click to reset"
      onDoubleClick={() => void onCommit(SIDEBAR_DEFAULT[side])}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && drag.current) {
          drag.current = null;
          setActive(false);
          onCancel();
          event.preventDefault();
          return;
        }
        const direction = side === 'left' ? 1 : -1;
        const next =
          event.key === 'Home'
            ? SIDEBAR_MIN[side]
            : event.key === 'End'
              ? SIDEBAR_MAX
              : event.key === 'ArrowRight'
                ? width + 10 * direction
                : event.key === 'ArrowLeft'
                  ? width - 10 * direction
                  : null;
        if (next !== null) {
          event.preventDefault();
          void onCommit(sidebarWidth(next, side));
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: position, original: width, current: width };
        setActive(true);
        onStart();
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const next = sidebarDragWidth(
          drag.current.width + (event.clientX - drag.current.x) * (side === 'left' ? 1 : -1),
          side,
        );
        drag.current.current = next;
        onPreview(next);
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        const next = drag.current.current;
        const original = drag.current.original;
        drag.current = null;
        setActive(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (next === original) onCancel();
        else void onCommit(next);
      }}
      onPointerCancel={() => {
        if (drag.current) {
          drag.current = null;
          setActive(false);
          onCancel();
        }
      }}
      onLostPointerCapture={() => {
        if (drag.current) {
          drag.current = null;
          setActive(false);
          onCancel();
        }
      }}
    />
  );
}
