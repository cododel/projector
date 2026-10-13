import { notifyError } from './notifications';
import { NotificationAccess } from './NotificationAccess';
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
        }
      })
      .catch((cause) => {
        if (active) notifyError(cause, 'guide', selection);
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
        aria-label="Projector guide"
      >
        <div className="modal-heading">
          <h2>Projector guide</h2>
          <NotificationAccess />
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
        <pre className="guide-content">{guide?.content}</pre>
      </section>
    </div>
  );
}
