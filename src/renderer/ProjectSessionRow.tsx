import React, { useEffect, useRef, useState } from 'react';
import type { HarnessSession } from '../shared/harness';

export function ProjectSessionRow({
  session,
  active,
  pinned,
  actions,
  onSelect,
}: {
  session: HarnessSession;
  active: boolean;
  pinned: boolean;
  actions: React.ReactNode;
  onSelect: () => void;
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const viewport = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const engaged = hovered || focused;
  const title = session.title || 'Codex session';
  const tailWidth = (session.processState === 'running' ? 12 : 0) + (session.worktreePath ? 21 : 0);
  useEffect(() => {
    const container = viewport.current!,
      content = text.current!;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation: Animation | undefined;
    const measure = () => {
      animation?.cancel();
      setAtEnd(false);
      const distance = Math.max(0, content.scrollWidth - container.clientWidth);
      setOverflow(distance > 0);
      if (!engaged || !distance || motion.matches) return;
      animation = content.animate(
        [{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
        { duration: (distance / 30) * 1000, delay: 300, easing: 'linear', fill: 'forwards' },
      );
      animation.onfinish = () => setAtEnd(true);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(content);
    motion.addEventListener('change', measure);
    measure();
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', measure);
      animation?.cancel();
    };
  }, [engaged, title]);
  return (
    <div
      className={`harness-session project-session-row${active ? ' active' : ''}${engaged ? ' engaged' : ''}${pinned ? ' pinned' : ''}`}
      style={{ '--session-tail-width': `${tailWidth}px` } as React.CSSProperties}
      onMouseEnter={() => setHovered(true)}
      onMouseMove={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <button
        className="session-select"
        title={`${title} · ${session.id} · ${session.processState === 'unknown' ? 'Process state unknown' : session.processState}`}
        onClick={onSelect}
      >
        <span
          ref={viewport}
          className={`session-title${overflow ? ' overflowing' : ''}${atEnd ? ' at-end' : ''}`}
        >
          <span ref={text} className="session-title-text">
            {title}
          </span>
        </span>
      </button>
      {actions}
      <span className="session-indicators">
        {session.processState === 'running' && <span className="runtime-dot" />}
        {session.worktreePath && (
          <span
            className="session-worktree"
            role="img"
            aria-label={`Worktree ${session.worktreePath}`}
            title={`Worktree · ${session.worktreePath}`}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <path d="M4 12h6l10-8M14 4h6v6M10 12l10 8M14 20h6v-6" />
            </svg>
          </span>
        )}
      </span>
    </div>
  );
}
