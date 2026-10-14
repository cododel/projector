import React from 'react';
export interface HistoryItem {
  id: string;
  artifactId?: string;
  createdAt: string;
  notification?: string;
}
export function FeedbackHistory({
  savedStates,
  packages,
  onSavedCopy,
  onLegacyCopy,
}: {
  savedStates: HistoryItem[];
  packages: HistoryItem[];
  onSavedCopy: (state: HistoryItem) => void;
  onLegacyCopy: (state: HistoryItem) => void;
}) {
  return (
    <>
      {' '}
      {savedStates.length > 0 && (
        <details className="package-history">
          <summary>Saved states</summary>
          {savedStates.map((state) => (
            <div key={state.id}>
              <small>{new Date(state.createdAt).toLocaleString()}</small>
              {state.notification && (
                <button onClick={() => onSavedCopy(state)}>Copy update message</button>
              )}
            </div>
          ))}
        </details>
      )}
      {packages.length > 0 && (
        <details className="package-history">
          <summary>Legacy submitted packages</summary>
          {packages.map((p) => (
            <div key={p.id}>
              <small>{new Date(p.createdAt).toLocaleString()}</small>
              {p.notification && (
                <button onClick={() => onLegacyCopy(p)}>Copy legacy notification</button>
              )}
            </div>
          ))}
        </details>
      )}
    </>
  );
}
