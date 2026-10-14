import React from 'react';
export function ArtifactProperties({
  artifact,
  migrationSummary,
  downloads,
  onClearProfile,
  onCopyOrigin,
  propertiesOpen,
  migrationOpen,
  downloadsOpen,
}: {
  artifact?: {
    originSession: { harness: string; sessionId: string } | null;
    revisions?: (string | { id: string })[];
  };
  migrationSummary?: {
    retained: string[];
    added: string[];
    requiresResponse: string[];
    removed: string[];
  };
  downloads: { id: string; filename: string; status: string }[];
  propertiesOpen?: boolean;
  migrationOpen?: boolean;
  downloadsOpen?: boolean;
  onClearProfile: () => void;
  onCopyOrigin: () => void;
}) {
  return (
    <>
      {' '}
      {artifact && (
        <details className="artifact-properties" open={propertiesOpen}>
          <summary>Artifact properties</summary>
          <p className="muted">
            Some sign-in providers block embedded browsers. Open the page externally; authentication
            is not imported back.
          </p>
          <button className="secondary full" onClick={onClearProfile}>
            Clear project browser profile
          </button>
          {artifact.originSession ? (
            <>
              <small>Origin: {artifact.originSession.harness} · availability unverified</small>
              <button className="secondary full" onClick={onCopyOrigin}>
                Copy session link
              </button>
            </>
          ) : (
            <small>No agent session attached</small>
          )}
        </details>
      )}
      {migrationSummary && artifact && (artifact.revisions?.length ?? 0) > 1 && (
        <details className="migration-summary" open={migrationOpen}>
          <summary>Answers in this version</summary>
          {(['retained', 'added', 'requiresResponse', 'removed'] as const).map((key) => (
            <p key={key}>
              <strong>
                {
                  {
                    retained: 'Retained',
                    added: 'New',
                    requiresResponse: 'Requires response',
                    removed: 'Removed',
                  }[key]
                }
              </strong>
              : {migrationSummary![key].join(', ') || 'None'}
            </p>
          ))}
          <small>
            Authored defaults are not confirmed answers. Previous versions retain their state.
          </small>
        </details>
      )}
      {(downloads?.length ?? 0) > 0 && (
        <details className="package-history" open={downloadsOpen}>
          <summary>Downloads</summary>
          {downloads?.map((download) => (
            <p key={download.id} role="status">
              {download.filename} · {download.status}
            </p>
          ))}
        </details>
      )}
    </>
  );
}
