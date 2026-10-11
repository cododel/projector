import React, { useEffect, useRef, useState } from 'react';
import type { GuideResponse } from '../guide';
const topics = ['overview', 'planning', 'authoring', 'widgets', 'annotations', 'all'];
export function GuideViewer({
  load,
  close,
}: {
  load: (input: { topic?: string; reference?: string }) => Promise<GuideResponse>;
  close: () => void;
}): React.JSX.Element {
  const [guide, setGuide] = useState<GuideResponse | null>(null);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState('topic:overview');
  const heading = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    let active = true;
    const [kind, value] = selection.split(':');
    void load(kind === 'reference' ? { reference: value } : { topic: value })
      .then((response) => {
        if (active) {
          setGuide(response);
          setError('');
        }
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [selection, load]);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
        if (event.key === 'Tab') {
          const elements = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>('button,select'),
          );
          const first = elements[0],
            last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        className="modal guide-viewer"
        role="dialog"
        aria-modal="true"
        aria-label="Blueprint guide"
      >
        <div className="modal-heading">
          <h2>Blueprint guide</h2>
          <button ref={heading} onClick={close}>
            Close
          </button>
        </div>
        <p>Available offline · Version {guide?.guideVersion ?? '…'}</p>
        <select
          aria-label="Guide topic or reference"
          value={selection}
          onChange={(event) => setSelection(event.target.value)}
        >
          <optgroup label="Topics">
            {topics.map((topic) => (
              <option key={topic} value={'topic:' + topic}>
                {topic}
              </option>
            ))}
          </optgroup>
          <optgroup label="References">
            {guide?.references.map((reference) => (
              <option key={reference.id} value={'reference:' + reference.id}>
                {reference.title}
              </option>
            ))}
          </optgroup>
        </select>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <pre className="guide-content">{guide?.content}</pre>
        )}
      </section>
    </div>
  );
}
