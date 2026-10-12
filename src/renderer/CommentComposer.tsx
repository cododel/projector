import { Icon } from './Icon';
import React, { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';

interface Props {
  value: string;
  label: string;
  saveLabel: string;
  editing?: boolean;
  disabled?: boolean;
  onChange(value: string): void;
  onSave(): Promise<void>;
  onCancel(): Promise<void>;
  onDelete?: () => Promise<void>;
  onError(error: unknown): void;
}

export interface CommentComposerHandle {
  /** Complete the private editor before navigating. Rejects if its write failed. */
  finish(): Promise<void>;
}

export const CommentComposer = forwardRef<CommentComposerHandle, Props>(
  function CommentComposer(props, ref): React.JSX.Element {
    const hintId = useId();
    const deleteAction = props.onDelete;
    const input = useRef<HTMLTextAreaElement>(null);
    const container = useRef<HTMLElement>(null);
    const inFlight = useRef<Promise<void> | null>(null);
    const current = useRef(props);
    current.current = props;
    const [working, setWorking] = useState(false);
    const disabled = props.disabled || working;
    useEffect(() => {
      const element = input.current;
      if (!element) return;
      const style = getComputedStyle(element);
      const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
      const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const border =
        Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
      element.style.height = '0px';
      const maximum = line * 6 + padding + border;
      element.style.height =
        Math.min(maximum, Math.max(line + padding + border, element.scrollHeight + border)) + 'px';
      element.style.overflowY = element.scrollHeight + border > maximum ? 'auto' : 'hidden';
    }, [props.value]);

    function run(action: () => Promise<void>): Promise<void> {
      if (inFlight.current) return inFlight.current;
      if (current.current.disabled)
        return Promise.reject(new Error('The comment editor is busy. Try again.'));
      setWorking(true);
      const promise = Promise.resolve()
        .then(action)
        .catch((error: unknown) => {
          current.current.onError(error);
          throw error;
        })
        .finally(() => {
          inFlight.current = null;
          setWorking(false);
          input.current?.focus();
        });
      inFlight.current = promise;
      return promise;
    }
    function finish(): Promise<void> {
      return run(() =>
        current.current.value.trim() ? current.current.onSave() : current.current.onCancel(),
      );
    }
    useImperativeHandle(ref, () => ({ finish }));
    useEffect(() => {
      const outside = (event: PointerEvent): void => {
        const target = event.target;
        if (!(target instanceof Node) || container.current?.contains(target)) return;
        // Navigation separately awaits finish(). Blocking this pointer prevents a failed
        // write from executing an unrelated action underneath the still-open editor.
        event.preventDefault();
        event.stopPropagation();
        void finish().catch(() => {});
      };
      document.addEventListener('pointerdown', outside, true);
      return () => document.removeEventListener('pointerdown', outside, true);
    });
    return (
      <section
        ref={container}
        className={`annotation-comment-composer${props.editing ? ' editing' : ''}`}
        role="dialog"
        aria-label={props.editing ? 'Edit comment' : 'Add annotation'}
      >
        <textarea
          ref={input}
          autoFocus
          rows={1}
          aria-label={props.label}
          aria-describedby={hintId}
          placeholder="Add a comment…"
          value={props.value}
          disabled={disabled}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              void run(() => current.current.onCancel()).catch(() => {});
            } else if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              if (!event.repeat) void finish().catch(() => {});
            }
          }}
        />
        <div className="comment-actions">
          {deleteAction && (
            <button
              className="comment-delete"
              aria-label="Delete annotation"
              title="Delete annotation"
              disabled={disabled}
              onClick={() => void run(deleteAction).catch(() => {})}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
              </svg>
            </button>
          )}
          <span id={hintId} className="visually-hidden">
            Enter saves the private comment. Shift+Enter adds a line. Escape cancels. Save artifact
            state to share with the agent.
          </span>
          <button
            className="comment-cancel"
            aria-label="Cancel"
            title="Cancel (Escape)"
            disabled={disabled}
            onClick={() => void run(() => current.current.onCancel()).catch(() => {})}
          >
            {props.editing ? 'Cancel' : <Icon name="close" />}
          </button>
          <button
            className={`comment-save ${props.editing ? '' : 'comment-confirm'}`}
            aria-label={props.saveLabel}
            title="Save comment (Enter)"
            disabled={disabled || !props.value.trim()}
            onClick={() => void run(() => current.current.onSave()).catch(() => {})}
          >
            {props.editing ? (
              'Save'
            ) : (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="m5 12 4 4 10-10" />
              </svg>
            )}
          </button>
        </div>
      </section>
    );
  },
);
