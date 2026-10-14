import React from 'react';
export function DocumentSelection({ candidate, selection, contextPending, position, onBegin, popoverRef, children }: { candidate: boolean; selection: boolean; contextPending: boolean; position: { x: number; y: number }; onBegin(): void; popoverRef?: React.Ref<HTMLDivElement>; children?: React.ReactNode }): React.JSX.Element {
  return <>{candidate && !selection && <button className="selection-annotate" style={{ left: position.x, top: position.y }} onMouseDown={(event) => event.preventDefault()} onClick={onBegin}>Annotate</button>}{selection && !contextPending && <div ref={popoverRef} className="annotation-popover" style={{ left: position.x, top: position.y }}>{children}</div>}{contextPending && <div className="capture-input-shield" aria-hidden="true" />}</>;
}
