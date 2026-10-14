import React from 'react';
export function DocumentStatus({ error, source, preview, onReturn }: { error?: string; source?: string; preview?: boolean; onReturn(): void }): React.JSX.Element {
  return <>{error && <section className="draft-diagnostic"><div role="alert" className="error-banner">{error}</div><pre>{source}</pre></section>}{preview && <div className="state-preview-banner" role="status">Annotation state preview · read-only<button onClick={onReturn}>Return to working state</button></div>}</>;
}
export function DocumentWaiting({ draft = false }: { draft?: boolean }): React.JSX.Element { return <p className="muted">{draft ? 'Waiting for the agent to write the MDX source.' : 'Loading document…'}</p>; }
