import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import type { WidgetDefinition } from '../../document/types';
import { markerGeometry } from '../../shared/annotation-marker';
type Value = string | string[];
export function AnnotationBadge({ number }: { number: number }): React.JSX.Element {
  const { cx, cy, path } = markerGeometry({ x: 3.75, y: 24.25 }, { width: 28, height: 28 });
  return (
    <svg className="annotation-number" viewBox="0 0 28 28" aria-hidden="true">
      <path d={path} fill="#4263da" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
      <text
        x={cx}
        y={cy}
        dominantBaseline="central"
        textAnchor="middle"
        fontSize="10"
        fontWeight="600"
        fontFamily="sans-serif"
        fill="white"
      >
        {number}
      </text>
    </svg>
  );
}

export function Diagram({ source, renderDiagram = mermaid.render }: { source: string; renderDiagram?: (id: string, source: string) => Promise<{ svg: string }> }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'neutral',
      suppressErrorRendering: true,
    });
    void renderDiagram(`diagram-${crypto.randomUUID()}`, source)
      .then((result) => {
        if (active && container.current) container.current.innerHTML = result.svg;
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [source, renderDiagram]);
  return error ? (
    <div className="diagram-error">
      Diagram unavailable: {error}
      <pre>{source}</pre>
    </div>
  ) : (
    <div ref={container} className="diagram" />
  );
}

export function Widget({
  definition,
  value,
  update,
  readOnly = false,
}: {
  definition: WidgetDefinition;
  value: Value | undefined;
  update: (id: string, value: Value) => void;
  readOnly?: boolean;
}): React.JSX.Element {
  const options = (definition.options ?? []).map((option) =>
    typeof option === 'string' ? { value: option, label: option } : option,
  );
  const current =
    value ?? definition.defaultValue ?? (definition.kind.toLowerCase().includes('check') ? [] : '');
  return (
    <section className="widget" data-widget-id={definition.id}>
      <div className="widget-label">{definition.meaning}</div>
      {definition.kind.toLowerCase().includes('choice') ? (
        <div className="choices">
          {options.map((option) => (
            <label key={option.value} className={current === option.value ? 'selected' : ''}>
              <input
                type="radio"
                disabled={readOnly}
                name={definition.id}
                value={option.value}
                checked={current === option.value}
                onChange={() => update(definition.id, option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : definition.kind.toLowerCase().includes('check') ? (
        <div className="checklist">
          {options.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                disabled={readOnly}
                checked={Array.isArray(current) && current.includes(option.value)}
                onChange={(event) => {
                  const values = Array.isArray(current) ? current : [];
                  update(
                    definition.id,
                    event.target.checked
                      ? [...values, option.value]
                      : values.filter((item) => item !== option.value),
                  );
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : (
        <textarea
          aria-label={definition.meaning}
          disabled={readOnly}
          value={typeof current === 'string' ? current : ''}
          placeholder="Your answer…"
          onChange={(event) => update(definition.id, event.target.value)}
        />
      )}
      <small>Your answer is private until Save.</small>
    </section>
  );
}
