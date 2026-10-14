import React, { forwardRef } from 'react';
import type { DocumentNode, WidgetDefinition, WidgetValue } from '../../document/types';
import { Widget, Diagram } from './DocumentElements';
export interface DocumentContentProps { blocks: DocumentNode[]; widgets: WidgetDefinition[]; values: Record<string, WidgetValue>; details: Record<string, boolean>; widgetsReadOnly?: boolean; detailsReadOnly?: boolean; detailsLocked?: boolean; update(id: string, value: WidgetValue): void; onDetailsChange(id: string, open: boolean): void; }
export function DocumentContent({ blocks, widgets, values, details, widgetsReadOnly = false, detailsReadOnly = false, detailsLocked = false, update, onDetailsChange }: DocumentContentProps): React.JSX.Element {
  function render(node: DocumentNode, key: string): React.ReactNode {
    const children = node.children?.map((child, index) => render(child, `${key}-${index}`));
    const props = node.props ?? {};
    const widgetId =
      typeof props.widgetId === 'string'
        ? props.widgetId
        : typeof props.id === 'string'
          ? props.id
          : node.id;
    const widget = widgets.find((item) => item.id === widgetId);
    if (widget)
      return (
        <Widget
          key={key}
          definition={widget}
          value={values[widget.id]}
          update={update}
          readOnly={widgetsReadOnly}
        />
      );
    const common = { 'data-block-id': node.id ?? key };
    switch (node.type) {
      case 'root':
        return <React.Fragment key={key}>{children}</React.Fragment>;
      case 'text':
        return (
          <span key={key} data-text-path={JSON.stringify(key.split('-').map(Number))}>
            {node.value}
          </span>
        );
      case 'paragraph':
        return <p key={key} {...common}>{children}</p>;
      case 'heading': {
        const Heading =
          `h${Math.max(1, Math.min(6, typeof props.depth === 'number' ? props.depth : 2))}` as
            'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        return <Heading key={key} {...common}>{children}</Heading>;
      }
      case 'strong':
        return <strong key={key}>{children}</strong>;
      case 'emphasis':
        return <em key={key}>{children}</em>;
      case 'delete':
        return <del key={key}>{children}</del>;
      case 'inlineCode':
        return (
          <code key={key}>
            <span data-text-path={JSON.stringify(key.split('-').map(Number))}>{node.value}</span>
          </code>
        );
      case 'code':
        return props.language === 'mermaid' ? (
          <Diagram key={key} source={node.value ?? ''} />
        ) : (
          <pre key={key} {...common}>
            <code>
              <span data-text-path={JSON.stringify(key.split('-').map(Number))}>{node.value}</span>
            </code>
          </pre>
        );
      case 'blockquote':
        return <blockquote key={key} {...common}>{children}</blockquote>;
      case 'list':
        return props.ordered ? (
          <ol key={key} {...common} start={typeof props.start === 'number' ? props.start : 1}>
            {children}
          </ol>
        ) : (
          <ul key={key} {...common}>{children}</ul>
        );
      case 'listItem':
        return (
          <li key={key} {...common}>
            {typeof props.checked === 'boolean' && (
              <input type="checkbox" aria-label={props.checked ? 'Completed task' : 'Incomplete task'} checked={props.checked} disabled />
            )}
            {children}
          </li>
        );
      case 'table':
        return (
          <div className="table-wrap" key={key}>
            <table data-block-id={node.id ?? key}>
              <tbody>{children}</tbody>
            </table>
          </div>
        );
      case 'tableRow':
        return <tr key={key}>{children}</tr>;
      case 'tableCell':
        return <td key={key} {...common}>{children}</td>;
      case 'link':
        return (
          <span
            key={key}
            className="document-link"
            title={typeof props.url === 'string' ? props.url : ''}
          >
            {children}
          </span>
        );
      case 'image':
        return (
          <span key={key} {...common} className="image-placeholder">
            {typeof props.alt === 'string' ? props.alt : 'Image'} · external image preview
            unavailable in Alpha 1
          </span>
        );
      case 'thematicBreak':
        return <hr key={key} {...common} />;
      case 'break':
        return <br key={key} />;
      case 'Details':
      case 'details':
        return (
          <details
            key={key} {...common}
            open={details[node.id ?? key] ?? false}
            onToggle={(e) => {
              if (detailsReadOnly) return;
              const open = e.currentTarget.open,
                id = node.id ?? key;
              if (details[id] === open) return;
              onDetailsChange(id, open);
            }}
          >
            <summary
              onClick={(e) => {
                if (detailsLocked) e.preventDefault();
              }}
              aria-disabled={Boolean(detailsLocked)}
            >
              {typeof props.title === 'string' ? props.title : 'Details'}
            </summary>
            {children}
          </details>
        );
      case 'Callout':
      case 'callout':
        return (
          <aside key={key} {...common} className="callout">
            {typeof props.title === 'string' && <strong>{props.title}</strong>}
            {children}
          </aside>
        );
      case 'Mermaid':
        return (
          <Diagram
            key={key}
            source={typeof props.source === 'string' ? props.source : (node.value ?? '')}
          />
        );
      case 'component':
      case 'mdxJsxFlowElement':
      case 'mdxJsxTextElement': {
        const name =
          typeof props.name === 'string'
            ? props.name
            : (node as DocumentNode & { name?: string }).name;
        if (name) return render({ ...node, type: name }, key);
        return <div key={key} {...common}>{children}</div>;
      }
      default:
        return <div key={key} {...common}>{node.value ?? children}</div>;
    }
  }
  return <>{blocks.map((node, index) => render(node, String(index)))}</>;
}

/** Shared article markup; capture and persistence stay with the document controller. */
export const DocumentArticle = forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  function DocumentArticle(props, ref): React.JSX.Element {
    return <article {...props} ref={ref} className="plan-document" data-block-id="document" />;
  },
);
