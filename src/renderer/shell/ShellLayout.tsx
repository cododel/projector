import React from 'react';
/** Shared native-shell layout; content ownership stays with the application controller. */
export function ShellLayout({
  leftVisible,
  rightVisible,
  animating = false,
  style,
  children,
}: {
  leftVisible: boolean;
  rightVisible: boolean;
  animating?: boolean;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div
      style={style}
      className={`app ${animating ? 'sidebar-animating' : ''} ${!leftVisible ? 'left-sidebar-hidden' : ''} ${!rightVisible ? 'right-sidebar-hidden' : ''}`}
    >
      {children}
    </div>
  );
}
export function ShellSidebar({
  side,
  contentRef,
  children,
}: {
  side: 'left' | 'right';
  contentRef?: React.Ref<HTMLElement>;
  children: React.ReactNode;
}) {
  return (
    <div className={side === 'left' ? 'sidebar-viewport' : 'feedback-viewport'}>
      <aside
        aria-label={side === 'left' ? 'Projects' : 'Feedback'}
        className={side === 'left' ? 'sidebar' : 'feedback-panel'}
        ref={contentRef}
      >
        {children}
      </aside>
    </div>
  );
}
export function ShellWorkspace({ children }: { children: React.ReactNode }) {
  return <main className="workspace">{children}</main>;
}
