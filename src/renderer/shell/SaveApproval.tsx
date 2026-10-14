import React from 'react';
export interface SaveApprovalProps {
  busy: boolean;
  autosaving: boolean;
  retry: boolean;
  saveDisabled: boolean;
  approvalDisabled: boolean;
  projectOverview: boolean;
  unpublished: boolean;
  dirty: boolean;
  approved: boolean;
  hasRevision: boolean;
  handoff?: React.ReactNode;
  onSave: () => void;
  onApproval: () => void;
}
export function SaveApproval({
  busy,
  autosaving,
  retry,
  saveDisabled,
  approvalDisabled,
  projectOverview,
  unpublished,
  dirty,
  approved,
  hasRevision,
  handoff,
  onSave,
  onApproval,
}: SaveApprovalProps) {
  return (
    <div className="submit-area">
      <button className="primary full" disabled={saveDisabled} onClick={onSave}>
        {busy ? 'Working…' : autosaving ? 'Autosaving…' : retry ? 'Retry Save' : 'Save'}
      </button>
      <small>
        {projectOverview ? (
          'Open a plan to review its answers and annotations.'
        ) : unpublished ? (
          'Save and approval become available after the agent publishes the first document. Your workspace is autosaved privately.'
        ) : (
          <>
            {dirty ? 'Unsaved working changes' : 'Saved state is unchanged'} · Save keeps
            annotations and creates an immutable snapshot.
          </>
        )}
      </small>
      {handoff}
      {hasRevision && (
        <button className="subtle full" disabled={approvalDisabled} onClick={onApproval}>
          {approved ? 'Revoke approval' : 'Approve this version'}
        </button>
      )}
      <small>Approval records agreement. It does not authorize implementation.</small>
    </div>
  );
}
