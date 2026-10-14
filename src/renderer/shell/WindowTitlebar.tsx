import React from 'react';
export function WindowTitlebar({
  leftSidebarVisible,
  rightSidebarVisible,
  sidebarToggle,
  tabs,
  actions,
  notification,
}: {
  leftSidebarVisible: boolean;
  rightSidebarVisible: boolean;
  sidebarToggle: (side: 'left' | 'right') => React.ReactNode;
  tabs: React.ReactNode;
  actions?: React.ReactNode;
  notification?: React.ReactNode;
}) {
  return (
    <div className="window-titlebar" role="toolbar" aria-label="Window toolbar">
      {leftSidebarVisible && (
        <div className="titlebar-section titlebar-left">
          <div className="titlebar-brand" aria-label="Projector">
            <span className="titlebar-brand-mark" aria-hidden="true">
              P
            </span>
            <span className="titlebar-brand-name">Projector</span>
          </div>
          {sidebarToggle('left')}
        </div>
      )}
      <div className="titlebar-section titlebar-center">
        {!leftSidebarVisible && sidebarToggle('left')}
        {tabs}
        <span className="titlebar-drag-space" />

        {actions}
        {notification}
        {!rightSidebarVisible && sidebarToggle('right')}
      </div>
      {rightSidebarVisible && (
        <div className="titlebar-section titlebar-right">
          {sidebarToggle('right')}
          <span className="titlebar-drag-space" />
        </div>
      )}
    </div>
  );
}
