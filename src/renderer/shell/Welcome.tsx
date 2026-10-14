import React from 'react';
export function Welcome({ onChooseProject }: { onChooseProject: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-symbol">◇</div>
      <h2>Make decisions before implementation</h2>
      <p>
        Connect your agent through MCP, publish a plan, and save answers and annotations for the
        same session.
      </p>
      <button className="primary" onClick={onChooseProject}>
        Open project folder
      </button>
    </div>
  );
}
