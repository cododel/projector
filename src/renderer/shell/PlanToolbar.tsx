import React from 'react';
export function PlanToolbar({
  revisionId,
  revisions,
  approved,
  draft,
  busy,
  documentActive,
  saveStatus,
  areaMode,
  canAnnotate,
  onVersion,
  onAnnotate,
}: {
  revisionId: string | null;
  revisions?: (string | { id: string })[];
  approved: boolean;
  draft: boolean;
  busy: boolean;
  documentActive: boolean;
  saveStatus: string;
  areaMode: boolean;
  canAnnotate: boolean;
  onVersion: (revisionId: string) => void;
  onAnnotate: () => void;
}) {
  return (
    <>
      <div className="version-tools">
        {revisionId && (
          <label>
            <select
              disabled={busy}
              aria-label="Document version"
              value={revisionId}
              onChange={(event) => onVersion(event.currentTarget.value)}
            >
              {(revisions ?? [revisionId]).map((r, i) => {
                const id = typeof r === 'string' ? r : r.id;
                return (
                  <option key={id} value={id}>
                    Version {i + 1}
                  </option>
                );
              })}
            </select>
          </label>
        )}

        <span className={`status ${approved ? 'approved' : ''}`}>
          {draft ? 'Draft preview' : approved ? 'Approved' : 'In review'}
        </span>
      </div>
      {documentActive && (
        <>
          <span
            className={`document-save-status ${saveStatus === 'Save failed' ? 'save-error' : ''}`}
            role="status"
          >
            {draft ? 'Read-only preview' : saveStatus}
          </span>
          <button
            className={`annotate-tool ${areaMode ? 'active' : ''}`}
            aria-label="Annotate document"
            aria-pressed={areaMode}
            disabled={busy || !canAnnotate || draft}
            onClick={onAnnotate}
          >
            Annotate
          </button>
        </>
      )}
    </>
  );
}
